from typing import TypedDict, Literal, List, Dict, Optional
from langgraph.graph import StateGraph, START, END
from qa_agent import qa_agent_node
from math_agent import math_agent_node
from citation_agent import citation_agent_node
from ocr_agent import ocr_agent_node
from chart_agent import chart_agent_node
from code_agent import code_agent_node

# ==========================================
# アプリ全体の統合State（新生Paper Agentの心臓部）
# ==========================================
class AppState(TypedDict):
    # --- 🌟 新規: 共通の入力データ ---
    intent: Literal["qa", "math", "citation", "chart", "code"] # ユーザーの目的
    raw_image: Optional[str]     # 切り抜き画像（base64）
    raw_text: Optional[str]      # 選択テキスト
    
    # --- 🌟 新規: OCRエージェントが埋める中間データ ---
    extracted_text: Optional[str] # 画像から抽出された綺麗なテキスト/数式/引用番号
    
    # --- 共通の文脈データ ---
    current_context: str
    paper_metadata: str
    chat_history: List[Dict[str, str]]
    references_dict: dict
    
    # ========================================
    # 以下、既存エージェントとの互換性維持用データ
    # （各専門エージェントを改修した後に順次削っていきます）
    # ========================================
    selected_text: str
    user_intent: str
    qa_answer: str
    dict_suggestions: str
    
    selected_tex: str
    selected_image: str 
    action_type: str
    math_result: str
    
    selected_citation: str
    target_reference_text: str
    paper_info: dict
    relevance_explanation: str

    code_result: str

# ==========================================
# 🧭 ルーティング関数 (Supervisor)
# ==========================================
def route_task(state: AppState) -> str:
    # 🌟 画像があって、かつOCRがまだ終わっていなければ、問答無用でOCRへ回送
    if state.get("raw_image") and not state.get("extracted_text"):
        print("🧭 [Supervisor] 未解析の画像を検知。 -> OCR Agent へ回送")
        return "OCRNode"
    
    # 画像がない、またはOCRが完了している場合は、目的（intent）に応じて専門ワーカーへ
    intent = state.get("intent")
    print(f"🧭 [Supervisor] Intent [{intent}] を確認。 -> 専門Agent へ回送")
    
    if intent == "math":
        return "MathNode"
    elif intent == "citation":
        return "CitationNode"
    elif intent in ["qa", "thread_summary"]: 
        return "QANode"
    elif intent == "chart":
        return "ChartNode"
    elif intent == "code":
        return "CodeNode"
    else:
        raise ValueError(f"不明なタスクタイプです: {intent}")

# ==========================================
# グラフ構築
# ==========================================
builder = StateGraph(AppState)

# ノードの登録
builder.add_node("OCRNode", ocr_agent_node)
builder.add_node("QANode", qa_agent_node)
builder.add_node("MathNode", math_agent_node)
builder.add_node("CitationNode", citation_agent_node)
builder.add_node("ChartNode", chart_agent_node)
builder.add_node("CodeNode", code_agent_node)

# STARTからの条件分岐
builder.add_conditional_edges(
    START, 
    route_task,
    {
        "OCRNode": "OCRNode",
        "QANode": "QANode",
        "MathNode": "MathNode",
        "CitationNode": "CitationNode",
        "ChartNode": "ChartNode",
        "CodeNode": "CodeNode"
    }
)

# 🌟 魔法のルーティング: OCRNodeが終わったら、もう一度 Supervisor(route_task) に戻して再評価する
builder.add_conditional_edges(
    "OCRNode",
    route_task,
    {
        "QANode": "QANode",
        "MathNode": "MathNode",
        "CitationNode": "CitationNode",
        "ChartNode": "ChartNode",
        "CodeNode": "CodeNode"
    }
)

# 終端の定義
builder.add_edge("QANode", END)
builder.add_edge("MathNode", END)
builder.add_edge("CitationNode", END)
builder.add_edge("ChartNode", END)
builder.add_edge("CodeNode", END)

app_graph = builder.compile()