from typing import TypedDict, Optional
from langgraph.graph import StateGraph, START, END
from langchain_core.messages import SystemMessage, HumanMessage
from llm_settings import make_llm
from dotenv import load_dotenv

load_dotenv()

# ※注意: 画像を処理するため、Vision用モデル（UIの設定、または LOCAL_OPENAI_VISION_MODEL_NAME）にVision対応モデルを指定してください
llm = make_llm(temperature=0.2, vision=True)

class ChartState(TypedDict):
    intent: str
    selected_image: Optional[str] # フロントから送られてくるBase64画像
    action_type: str
    current_context: str
    qa_answer: str # 最終的な出力テキスト

# アクションに応じたシステムプロンプトの定義
prompt_templates = {
    "explain": """あなたは論文の図表（グラフ、構成図、表）を読み解く専門エージェントです。
提供された画像と文脈について、以下の観点で構造的に解説してください。
1. 図表の全体的な目的（何を示しているか）
2. 読み取れる重要な傾向や結論
専門用語を噛み砕き、初学者にもわかりやすく説明してください。""",
    
    "trend": """あなたはデータ解析に特化した専門エージェントです。
提供された画像（グラフや表）から、データの傾向、相関関係、特異点などを読み取り、
この図表から導き出せる「科学的・客観的な結論」を論理的に解説してください。""",
    
    "axes": """あなたはグラフの構造解析エージェントです。
提供された画像について、X軸、Y軸、凡例、カラーマップなどの「構成要素」がそれぞれ何を意味しているかを詳細に解説してください。
単位やスケール（対数グラフなど）に注意して説明してください。"""
}

def chart_agent_node(state: ChartState):
    action_type = state.get("action_type", "explain")
    selected_image = state.get("selected_image")
    current_context = state.get("current_context", "特に文脈情報なし")

    print(f"📊 Chart Agent起動中... (モード: {action_type})")

    sys_prompt_text = prompt_templates.get(action_type, prompt_templates["explain"])
    
    messages = [SystemMessage(content=sys_prompt_text)]

    # 画像があればマルチモーダルとしてメッセージを構築
    if selected_image:
        human_content = [
            {"type": "text", "text": f"【周辺の文脈】\n{current_context}\n\nこの画像について解説してください。"},
            {"type": "image_url", "image_url": {"url": selected_image}}
        ]
        messages.append(HumanMessage(content=human_content))
    else:
         messages.append(HumanMessage(content=f"【周辺の文脈】\n{current_context}\n\n画像が提供されていませんが、文脈からわかる範囲で解説してください。"))

    try:
        response = llm.invoke(messages)
        result_text = response.content
        print("  ✨ 解析成功")
    except Exception as e:
        print(f"  ⚠️ Chart Agent エラー: {e}")
        result_text = f"エラーが発生しました: {str(e)}"

    # Supervisorに戻すための共通キーに格納
    return {"qa_answer": result_text}

# グラフ構築
graph_builder = StateGraph(ChartState)
graph_builder.add_node("ChartAgent", chart_agent_node)
graph_builder.add_edge(START, "ChartAgent")
graph_builder.add_edge("ChartAgent", END)
chart_graph = graph_builder.compile()