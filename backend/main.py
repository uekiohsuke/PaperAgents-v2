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
@app.get("/api/pdf_info")
def get_pdf_info():
    return {
        "toc": pdf_parser.toc,
        "references": pdf_parser.references
    }

@app.post("/api/agent")
async def run_agent(request: AgentRequest):
    print(f"\n📨 リクエスト受信: タスクタイプ [{request.task_type}]")
    
    async def event_generator():
        current_context = request.context.current_context
        target_reference = request.payload.target_reference_text

        state = {
            "task_type": request.task_type,
            "current_context": current_context,
            "paper_metadata": request.context.paper_metadata or "",
            "selected_text": request.payload.selected_text or "",
            "user_intent": request.payload.user_intent or "",
            "selected_tex": request.payload.selected_tex or "",
            "selected_image": request.payload.selected_image or "",
            "action_type": request.payload.action_type or "",
            "selected_citation": request.payload.selected_citation or "",
            "target_reference_text": target_reference or "",
            "chat_history": [{"role": msg.role, "content": msg.content} for msg in request.chat_history],
        }

        yield f"data: {json.dumps({'status': 'info', 'message': '🧠 エージェントが推論中...'})}\n\n"

        # QA/Mathタスク
        if request.task_type in ["qa", "math"] and (request.payload.selected_text or request.payload.selected_image):
            # ページ横断の完璧な文脈をバックエンドで取得し直す
            backend_context = pdf_parser.get_context_around(request.payload.selected_text, window_size=400)
            if backend_context and backend_context != request.payload.selected_text:
                current_context = backend_context
                print("🔍 バックエンドでページ横断の文脈を再抽出しました。")

        # Citationタスク
        elif request.task_type == "citation" and request.payload.selected_citation:
            # "[4]" などの引用番号から、パース済みの参考文献リストを引く
            ref_text = pdf_parser.references.get(request.payload.selected_citation)
            if ref_text:
                target_reference = ref_text
                print(f"📚 引用元を特定しました: {target_reference[:40]}...")
            else:
                print("⚠️ 指定された引用番号が見つかりませんでした。")

        # 強化されたデータを使って LangGraph に渡す State を構築
        state = {
            "task_type": request.task_type,
            "current_context": current_context,
            "paper_metadata": request.context.paper_metadata or "",
            "selected_text": request.payload.selected_text or "",
            "user_intent": request.payload.user_intent or "",
            "selected_tex": request.payload.selected_tex or "",
            "selected_image": request.payload.selected_image or "",
            "action_type": request.payload.action_type or "",
            "selected_citation": request.payload.selected_citation or "",
            "target_reference_text": target_reference or "",
            "chat_history": [{"role": msg.role, "content": msg.content} for msg in request.chat_history],
        }
        
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
            paper_info = graph_result.get("paper_info", {})
            explanation = graph_result.get("relevance_explanation", "エラー: 解説が生成されませんでした。")
            
            # 論文データを先に送る
            yield f"data: {json.dumps({'paper_info': paper_info, 'task_type': 'citation'})}\n\n"
            
            for char in explanation:
                await asyncio.sleep(0.01)
                yield f"data: {json.dumps({'chunk': char, 'task_type': 'citation'})}\n\n"

        yield f"data: {json.dumps({'done': True})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")

if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)