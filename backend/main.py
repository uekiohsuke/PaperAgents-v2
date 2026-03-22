from fastapi import FastAPI
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

# アプリ立ち上げ時にPDFを解析してメモリに保持(仮)
print("⏳ PDFを解析中...")
pdf_parser = PaperParser("sample.pdf") 
print("✅ PDF解析完了！サーバーを立ち上げます。")

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
    task_type: Literal["qa", "math", "citation"]
    context: ContextData
    payload: PayloadData
    chat_history: List[ChatMessage] = []

class OARequest(BaseModel):
    raw_citation: str

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
@app.post("/api/check_oa")
async def check_oa_status(req: OARequest):
    # 🌟 変更: Citation Agentのスキル（関数）を非同期で呼び出すだけ！
    result = await asyncio.to_thread(get_oa_status_from_text, req.raw_citation)
    return result

@app.get("/api/pdf_info")
def get_pdf_info():
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

        # QA/Mathタスクの文脈再取得 (既存ロジック維持)
        if request.task_type in ["qa", "math"] and (request.payload.selected_text or request.payload.selected_image):
            backend_context = pdf_parser.get_context_around(request.payload.selected_text or "", window_size=400)
            if backend_context and backend_context != request.payload.selected_text:
                current_context = backend_context
                print("🔍 バックエンドでページ横断の文脈を再抽出しました。")

        # 🌟 変更: 新生 Paper Agent 用の State を構築
        state = {
            # --- 新アーキテクチャ用データ ---
            "intent": request.task_type,
            "raw_image": request.payload.selected_image or None,
            "raw_text": request.payload.selected_text or None,
            "extracted_text": None, # ここは空っぽで渡す（OCR Agentに任せる）
            
            "current_context": current_context,
            "paper_metadata": request.context.paper_metadata or "",
            "chat_history": [{"role": msg.role, "content": msg.content} for msg in request.chat_history],
            "references_dict": pdf_parser.references,
            
            # --- 既存エージェントとの後方互換用データ ---
            "selected_text": request.payload.selected_text or "",
            "user_intent": request.payload.user_intent or "",
            "selected_tex": request.payload.selected_tex or "",
            "selected_image": request.payload.selected_image or "",
            "action_type": request.payload.action_type or "",
            "selected_citation": request.payload.selected_citation or "",
            "target_reference_text": target_reference or "",
        }
        
        # グラフ（Supervisor）の実行
        graph_result = await asyncio.to_thread(app_graph.invoke, state)
        
        # 出力振り分けとストリーミング(0.01s)
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
                
        elif request.task_type == "citation":
            explanation = graph_result.get("relevance_explanation", "エラー: 解説が生成されませんでした。")
            
            for char in explanation:
                await asyncio.sleep(0.01)
                yield f"data: {json.dumps({'chunk': char, 'task_type': 'citation'})}\n\n"

        yield f"data: {json.dumps({'done': True})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")

if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)