from typing import TypedDict, Literal, List, Dict
from langgraph.graph import StateGraph, START, END
from qa_agent import qa_agent_node
from math_agent import math_agent_node
from citation_agent import citation_agent_node

# ==========================================
# アプリ全体の統合State（データ構造）
# ==========================================
class AppState(TypedDict):
    # --- ルーティング用フラグ ---
    task_type: Literal["qa", "math", "citation"] 
    
    # --- 共通の文脈データ ---
    current_context: str
    paper_metadata: str
    chat_history: List[Dict[str, str]]
    
    # --- QA用データ ---
    selected_text: str
    user_intent: str
    qa_answer: str
    dict_suggestions: str
    
    # --- Math用データ ---
    selected_tex: str
    selected_image: str
    action_type: str
    math_result: str
    
    # --- Citation用データ ---
    selected_citation: str
    target_reference_text: str
    paper_info: dict
    relevance_explanation: str

# ==========================================
# ルーティング関数
# ==========================================
def route_task(state: AppState) -> str:
    task = state.get("task_type")
    
    if task == "qa":
        return "QANode"
    elif task == "math":
        return "MathNode"
    elif task == "citation":
        return "CitationNode"
    else:
        raise ValueError(f"不明なタスクタイプです: {task}")

# ==========================================
# グラフ構築
# ==========================================
builder = StateGraph(AppState)

# ノードの登録
builder.add_node("QANode", qa_agent_node)
builder.add_node("MathNode", math_agent_node)
builder.add_node("CitationNode", citation_agent_node)

builder.add_conditional_edges(
    START, 
    route_task,
    {
        "QANode": "QANode",
        "MathNode": "MathNode",
        "CitationNode": "CitationNode"
    }
)

builder.add_edge("QANode", END)
builder.add_edge("MathNode", END)
builder.add_edge("CitationNode", END)

app_graph = builder.compile()

if __name__ == "__main__":
    print("=== 🚀 Supervisor ルーティングテスト ===")
    
    # パターン1: ユーザーがテキストを選択して「要約」ボタンを押した
    print("\n[テスト1] UIからの入力: QAタスク")
    ui_request_qa = {
        "task_type": "qa", 
        "user_intent": "要約",
        "selected_text": "ミクロな世界では状況が異なる。",
        "current_context": "..."
    }
    app_graph.invoke(ui_request_qa)
    
    # パターン2: ユーザーが数式をクリックした
    print("\n[テスト2] UIからの入力: Mathタスク")
    ui_request_math = {
        "task_type": "math",
        "action_type": "explain_step",
        "selected_tex": "E = mc^2",
        "current_context": "..."
    }
    app_graph.invoke(ui_request_math)
    
    # パターン3: ユーザーが引用番号をクリックした
    print("\n[テスト3] UIからの入力: Citationタスク")
    ui_request_citation = {
        "task_type": "citation",
        "selected_citation": "[3]",
        "target_reference_text": "Attention Is All You Need",
        "current_context": "..."
    }
    app_graph.invoke(ui_request_citation)