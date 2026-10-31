# code_agent.py
import os
from typing import TypedDict, Optional, List, Dict
from langgraph.graph import StateGraph, START, END
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.messages import SystemMessage, HumanMessage
from langchain_openai import ChatOpenAI
from dotenv import load_dotenv
from qa_agent import format_history_to_messages

load_dotenv()

llm = ChatOpenAI(
    base_url=os.environ.get("LOCAL_OPENAI_BASE_URL", "http://127.0.0.1:1234/v1"),
    api_key=os.environ.get("LOCAL_OPENAI_API_KEY", ""),
    model=os.environ.get("LOCAL_OPENAI_MODEL_NAME", "qwen3:14b"),
    temperature=0.1, # コード生成なのでハルシネーションを防ぐため低めに設定
)

class CodeState(TypedDict):
    intent: str
    raw_text: Optional[str]
    extracted_text: Optional[str]
    selected_text: Optional[str]
    user_intent: str
    current_context: str
    chat_history: List[Dict[str, str]]  # 修正依頼時に前回のコードをLLMへ渡すため
    code_result: str

# ==========================================
# コード生成用プロンプト
# ==========================================
prompt_code = ChatPromptTemplate.from_messages([
    ("system", r"""あなたは物理学と数値計算に精通した「Systemic Narrator (Sui)」のコード生成エージェントです。
ユーザーから与えられた数式や物理現象の説明に基づき、それをシミュレーションまたは可視化するPythonコードを生成してください。

【制約事項】
1. 使用ライブラリ: NumPy, SciPy, Matplotlib を優先して使用すること。
2. 物理定数・変数: コードの冒頭で明示的に定義し、単位系（SI単位など）をコメントで記載すること。
3. グラフ化: 軸ラベル、タイトル、凡例を必ず含めること。
4. 出力形式: 最初に簡単な解説（力学的な構造のメタファーを含む）を述べた後、必ず ```python と ``` で囲んだコードブロックを出力すること。
5. コードはコピペしてすぐに実行できる完全なスクリプトにすること。
6. 会話履歴に以前生成したコードがあり、ユーザーが修正を求めている場合は、そのコードを土台に修正した完全なスクリプトを出力すること。
"""),
    MessagesPlaceholder(variable_name="chat_history"),
    ("human", "【対象の数式・テキスト】\n{clean_text}\n\n【周辺の文脈】\n{current_context}\n\n【ユーザーの意図】\n{user_intent}\n\n上記の物理現象や数式をシミュレーション・可視化するPythonコードを生成してください。")
])

# ==========================================
# エージェントのノード処理
# ==========================================
def code_agent_node(state: CodeState):
    # OCRエージェントからの抽出結果（なければ生テキスト）を優先して取得
    clean_text = state.get("extracted_text") or state.get("raw_text") or state.get("selected_text") or ""
    user_intent = state.get("user_intent", "シミュレーションコードを作成して")
    current_context = state.get("current_context", "特に文脈情報なし")

    print(f"💻 Code Agent起動中...")
    print(f"  => 対象テキスト: {clean_text[:30]}...")

    chain = prompt_code | llm
    
    response = chain.invoke({
        "clean_text": clean_text,
        "current_context": current_context,
        "user_intent": user_intent,
        "chat_history": format_history_to_messages(state.get("chat_history", []))
    })

    print("💻 Code Agent 作業終了")

    return {"code_result": response.content}

# グラフ構築（単体テスト用）
graph_builder = StateGraph(CodeState)
graph_builder.add_node("CodeAgent", code_agent_node)
graph_builder.add_edge(START, "CodeAgent")
graph_builder.add_edge("CodeAgent", END)
code_graph = graph_builder.compile()