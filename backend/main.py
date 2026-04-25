from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, Literal, List
import uvicorn
import json
import asyncio
from pdf_parser import PaperParser
from supervisor import app_graph
from pdf_parser import PaperParser
from citation_agent import get_oa_status_from_text
from fastapi import UploadFile, File
import os
import shutil
import base64

pdf_parser = None 
print("✅ サーバーを立ち上げました。PDFのアップロードを待機しています。")

# ==========================================
# データコントラクト定義
# ==========================================
class ContextData(BaseModel):
    paper_metadata: Optional[str] = None
    current_context: str

class PayloadData(BaseModel):
    selected_text: Optional[str] = None
    user_intent: Optional[str] = None
    selected_tex: Optional[str] = None
    selected_image: Optional[str] = None
    action_type: Optional[str] = None
    selected_citation: Optional[str] = None
    target_reference_text: Optional[str] = None

class ChatMessage(BaseModel):
    role: Literal["user", "ai"]
    content: str

class AgentRequest(BaseModel):
    task_type: Literal["qa", "math", "citation", "chart", "code"]
    context: ContextData
    payload: PayloadData
    chat_history: List[ChatMessage] = []

class OARequest(BaseModel):
    raw_citation: str

class ThreadSummaryRequest(BaseModel):
    messages: list[dict]

app = FastAPI(title="Paper Agent Backend API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==========================================
# エンドポイント
# ==========================================
@app.post("/api/summarize_thread")
async def summarize_thread(req: ThreadSummaryRequest):
    # 🌟 変更: LLMを直接叩かず、Supervisorに状態(State)を投げる
    state = {
        "intent": "thread_summary",
        "user_intent": "thread_summary", # QA Agentでの分岐用
        "chat_history": req.messages,
        
        # エラー回避のためのダミーデータ（既存の Graph 構造に合わせる）
        "raw_text": "", "extracted_text": "", "current_context": "", "paper_metadata": "",
        "selected_text": "", "selected_tex": "", "selected_image": "", "action_type": "",
        "selected_citation": "", "target_reference_text": "", "references_dict": {}
    }
    
    try:
        # Supervisorを通してQAAgentを実行（非同期）
        result = await asyncio.to_thread(app_graph.invoke, state)
        
        # QAAgentがセットしてくれた qa_answer を取り出して返す
        return {"summary": result.get("qa_answer", "要約結果が空です。")}
    except Exception as e:
        return {"summary": f"要約エラー: {str(e)}"}

@app.post("/api/upload")
async def upload_pdf(file: UploadFile = File(...)):
    global pdf_parser
    
    # uploadsディレクトリを作って一時保存
    os.makedirs("uploads", exist_ok=True)
    file_path = f"uploads/{file.filename}"
    
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
        
    print(f"⏳ {file.filename} を解析中...")
    pdf_parser = PaperParser(file_path) # ここで自作パーサーが走る
    print("✅ 解析完了！")
    
    # 解析結果をフロントにそのまま返す
    return {
        "message": "success",
        "toc": getattr(pdf_parser, "toc", []),
        "references": getattr(pdf_parser, "references", {}),
        "citation_pages": getattr(pdf_parser, "citation_pages", {})
    }

@app.post("/api/check_oa")
async def check_oa_status(req: OARequest):
    # 🌟 変更: Citation Agentのスキル（関数）を非同期で呼び出すだけ！
    result = await asyncio.to_thread(get_oa_status_from_text, req.raw_citation)
    return result

@app.get("/api/pdf_info")
def get_pdf_info():
    if not pdf_parser:
        return {"toc": [], "references": {}, "citation_pages": {}}
    return {
        "toc": pdf_parser.toc,
        "references": pdf_parser.references,
        "citation_pages": getattr(pdf_parser, "citation_pages", {}) 
    }

@app.post("/api/agent")
async def run_agent(request: AgentRequest):
    print(f"\n📨 リクエスト受信: タスクタイプ [{request.task_type}]")
    
    async def event_generator():
        current_context = request.context.current_context
        target_reference = request.payload.target_reference_text

        yield f"data: {json.dumps({'status': 'info', 'message': '🧠 エージェントが推論中...'})}\n\n"

        # 🌟 修正1: pdf_parser が None じゃない時だけ get_context_around を実行する
        if request.task_type in ["qa", "math", "chart"] and (request.payload.selected_text or request.payload.selected_image):
            if pdf_parser is not None: # ← この if 文を追加！
                backend_context = pdf_parser.get_context_around(request.payload.selected_text or "", window_size=400)
                if backend_context and backend_context != request.payload.selected_text:
                    current_context = backend_context
                    print("🔍 バックエンドでページ横断の文脈を再抽出しました。")
            else:
                print("⚠️ pdf_parserが未初期化のため、フロントエンドの文脈をそのまま使用します。")

        # State を構築
        state = {
            "intent": request.task_type,
            "raw_image": request.payload.selected_image or None,
            "raw_text": request.payload.selected_text or None,
            "extracted_text": None, 
            
            "current_context": current_context,
            "paper_metadata": request.context.paper_metadata or "",
            "chat_history": [{"role": msg.role, "content": msg.content} for msg in request.chat_history],
            
            # 🌟 修正2: pdf_parser が None の時は空の辞書を渡すように変更！
            "references_dict": pdf_parser.references if pdf_parser is not None else {},
            
            "selected_text": request.payload.selected_text or "",
            "user_intent": request.payload.user_intent or "",
            "selected_tex": request.payload.selected_tex or "",
            "selected_image": request.payload.selected_image or "",
            "action_type": request.payload.action_type or "",
            "selected_citation": request.payload.selected_citation or "",
            "target_reference_text": target_reference or "",
            "code_result": "",
        }
        
        # グラフ（Supervisor）の実行
        graph_result = await asyncio.to_thread(app_graph.invoke, state)
        
        # 🌟 修正3: 出力振り分け部分を正しく Chart に対応させる
        if request.task_type == "qa":
            answer = graph_result.get("qa_answer", "エラー: 回答が生成されませんでした。")
            for char in answer:
                await asyncio.sleep(0.01)
                yield f"data: {json.dumps({'chunk': char, 'task_type': 'qa'})}\n\n"
                
        elif request.task_type == "math":
            answer = graph_result.get("math_result", "エラー: 解説が生成されませんでした。")
            for char in answer:
                await asyncio.sleep(0.01)
                yield f"data: {json.dumps({'chunk': char, 'task_type': 'math'})}\n\n"
                
        elif request.task_type == "chart": # 📊 Chart用の出力処理を追加
            # ChartAgent は qa_answer キーに結果を入れているのでそれを取り出す
            answer = graph_result.get("qa_answer", "エラー: 解説が生成されませんでした。")
            for char in answer:
                await asyncio.sleep(0.01)
                yield f"data: {json.dumps({'chunk': char, 'task_type': 'chart'})}\n\n"
                
        elif request.task_type == "citation":
            explanation = graph_result.get("relevance_explanation", "エラー: 解説が生成されませんでした。")
            for char in explanation:
                await asyncio.sleep(0.01)
                yield f"data: {json.dumps({'chunk': char, 'task_type': 'citation'})}\n\n"

        elif request.task_type == "code": # 🌟 Code用の出力処理を追加
            answer = graph_result.get("code_result", "エラー: コードが生成されませんでした。")
            for char in answer:
                await asyncio.sleep(0.01)
                yield f"data: {json.dumps({'chunk': char, 'task_type': 'code'})}\n\n"

        dict_data = graph_result.get("dict_suggestions", "{}")
        yield f"data: {json.dumps({'done': True, 'dict_suggestions': dict_data})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")

@app.post("/api/run_preview")
async def run_preview(request: Request):
    data = await request.json()
    code = data.get("code", "")

    # 🌟 ハック: GUIを抑制し、plt.show() を画像保存に強制置換する
    safe_code = (
        "import matplotlib\n"
        "matplotlib.use('Agg')\n" # バックエンド描画モードを強制
    ) + code.replace("plt.show()", "plt.savefig('temp_preview.png', bbox_inches='tight')")

    # 一時ファイルとして書き出し
    with open("temp_sim.py", "w", encoding="utf-8") as f:
        f.write(safe_code)

    try:
        # サブプロセスで別スレッドとして実行（メインアプリをフリーズさせない）
        # タイムアウトを設けて無限ループを防止
        process = await asyncio.create_subprocess_exec(
            "python", "temp_sim.py",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=5.0)

        if process.returncode != 0:
            return {"status": "error", "error": stderr.decode()}

        # グラフ画像が生成されていればBase64に変換して返す
        if os.path.exists("temp_preview.png"):
            with open("temp_preview.png", "rb") as img:
                b64 = base64.b64encode(img.read()).decode("utf-8")
            os.remove("temp_preview.png")
            return {"status": "success", "image": f"data:image/png;base64,{b64}"}
        else:
            # 画像が出ない計算コード等の場合
            return {"status": "success", "output": stdout.decode()}

    except asyncio.TimeoutError:
        return {"status": "error", "error": "実行がタイムアウトしました（5秒）。動的シミュレーション、または計算が重すぎます。"}
    except Exception as e:
        return {"status": "error", "error": str(e)}
    finally:
        # 実行用の一時ファイルを掃除
        if os.path.exists("temp_sim.py"):
            os.remove("temp_sim.py")

if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)