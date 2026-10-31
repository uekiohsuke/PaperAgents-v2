import os
import json
from typing import TypedDict, Optional, Any, List, Dict
from pydantic import BaseModel, Field
from langgraph.graph import StateGraph, START, END
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.messages import SystemMessage, HumanMessage
from langchain_openai import ChatOpenAI
from langchain_core.output_parsers import JsonOutputParser
from dotenv import load_dotenv
from qa_agent import format_history_to_messages

load_dotenv()

llm = ChatOpenAI(
    base_url=os.environ.get("LOCAL_OPENAI_BASE_URL", "http://127.0.0.1:1234/v1"),
    api_key=os.environ.get("LOCAL_OPENAI_API_KEY", ""),
    model=os.environ.get("LOCAL_OPENAI_MODEL_NAME", "qwen3:14b"),
    temperature=0.2,
    # streaming=True 
)

class MathState(TypedDict):
    intent: str
    raw_image: Optional[str]
    raw_text: Optional[str]
    extracted_text: Optional[str]
    selected_tex: Optional[str]
    action_type: str
    user_intent: str  # 自由入力の質問（定型ボタンの場合は action_type と同じ値）
    current_context: str
    chat_history: List[Dict[str, str]]
    math_result: str

# ==========================================
# VLMによるOCRと構造化
# ==========================================
class MathData(BaseModel):
    extracted_content: str = Field(description="画像から読み取った文章と数式を統合したテキスト（数式部分は必ずLaTeX形式の $$ または $ を使用）")
    variables: list[dict] = Field(description="数式に含まれる主要な変数（記号）と、その物理的・数学的な意味のリスト")

parser = JsonOutputParser(pydantic_object=MathData)

# ==========================================
# パターンA：式の意味（何を言いたいか、直感的な解剖）
# ==========================================
prompt_explain = ChatPromptTemplate.from_messages([
    ("system", r"""あなたは物理学と数学の専門エージェントです。
ユーザーは、提示された数式が「物理的・数学的に何を意味しているのか」「何を表しているのか」を直感的に理解したいと考えています。

【重要なフォーマット指示】
1. ステップバイステップの計算過程（導出）は絶対に出力しないでください。式の「意味の解剖」に徹してください。
2. 専門用語の羅列を避け、初学者がイメージしやすい具体例や比喩を交えて解説してください。
3. 出力は必ず以下のレイアウト（【全体の意味】、【各項の役割】、【物理的・数学的な意義】）を厳守してください。
4. 数式は必ずブロック形式のTeX（$$数式$$）またはインライン形式のTeX（$数式$）を使用してください。
5. 数式の前後には必ず「空行（改行2回）」を入れて、見やすく出力してください。

【出力例】
（入力がシュレディンガー方程式だった場合）

【全体の意味】
この式は、量子力学における「粒子の波としての振る舞い（波動関数）」が、時間とともにどのように変化するかを表す最も基本的な方程式です。古典力学におけるニュートンの運動方程式（$F=ma$）に相当します。

【各項の役割】
- 左辺 $i\hbar \frac{{\partial}}{{\partial t}}\Psi$ : 波動関数 $\Psi$ の時間変化（エネルギー）を表します。
- 右辺第1項 $-\frac{{\hbar^2}}{{2m}}\nabla^2\Psi$ : 粒子の「運動エネルギー」を表します。波の空間的な曲がり具合から計算されます。
- 右辺第2項 $V\Psi$ : 粒子が受ける「位置エネルギー（ポテンシャル）」を表します。

【物理的・数学的な意義】
この式を解くことで、電子などが空間のどこにどれくらいの確率で存在するかが分かり、原子の構造や化学反応の仕組みを理論的に計算できるようになります。
---
上記に従い、以下の数式の意味を直感的に解説してください。
"""),
    MessagesPlaceholder(variable_name="chat_history"),
    ("human", "【対象の数式】\n$$ {clean_tex} $$\n\n【数式に含まれる変数の情報】\n{variables_info}\n\n【周辺の文脈】\n{current_context}\n\nこの数式が何を言いたいのか、意味を解説してください。")
])

# ==========================================
# パターンB：式の導出（前提からの推論、行間の補完）
# ==========================================
prompt_derivation = ChatPromptTemplate.from_messages([
    ("system", r"""あなたは物理学と数学の専門エージェントです。
ユーザーは、提示された数式の「一般的な導出過程」や「行間の飛躍（式変形）」に躓いています。

【前提の推論ルール】
1. ユーザーが単一の式のみを選択している場合、提供された【周辺の文脈】から、直前の式や前提条件を推論して出発点（Step 1）に設定し、目的の式までの導出を行ってください。
2. 文脈に明記されていない場合でも、物理・数学の一般的な基本法則（定義式など）であれば、あなたの知識を用いてそれをStep 1として補足して解説を始めてください。
3. ユーザーが2つの式を選択している（「式Aから式B」という指定がある）場合は、その2式間の行間を埋めることに専念してください。

【重要なフォーマット指示】
1. 最後に「まとめ」「結論」「補足」などの項目を絶対に作らないでください。すべての解説は各ステップの「■ 解説:」の中に収め、Stepが終わったら直ちに出力を終了してください。
2. 数式は必ずブロック形式のTeX（$$数式$$）で独立した行に出力してください。
3. Step 1には必ず「出発点となる実際の数式」を出力してください。「(出発点となる式)」のような文字列は絶対に出力しないでください。
4. 飛躍している計算過程を、非常に細かいStepに分割して提示してください。
5. 各Stepの区切りや、数式の前後には必ず「空行（改行2回）」を入れて、見やすく出力してください。

【出力例】
（入力が「 \int x e^x dx から x e^x - e^x への変形 」だった場合）

【適用されている主な定理・法則】
部分積分法 (Integration by parts)

[Step 1] 《操作: 部分積分の公式への当てはめ》
$$ \int u v' dx = u v - \int u' v dx $$
■ 解説: 部分積分の公式です。与式に対し $u = x$, $v' = e^x$ と設定します。

[Step 2] 《操作: 必要な微分と積分の実行》
$$ u' = 1, \quad v = e^x $$
■ 解説: 設定した $u$ を $x$ で微分し、$v'$ を $x$ で積分して各要素を求めます。

[Step 3] 《操作: 公式への代入》
$$ \int x e^x dx = x e^x - \int 1 \cdot e^x dx $$
■ 解説: 各要素を部分積分の公式に代入します。

[Step 4] 《操作: 残った積分の実行》
$$ x e^x - e^x $$
■ 解説: 第2項の $\int e^x dx$ を実行し、最終的な変形結果が得られます。（積分定数は省略）
---
上記に従い、以下の数式・変形の詳細な操作解説を出力してください。
"""),
    MessagesPlaceholder(variable_name="chat_history"),
    ("human", "【対象の数式】\n$$ {clean_tex} $$\n\n【数式に含まれる変数の情報】\n{variables_info}\n\n【周辺の文脈】\n{current_context}\n\n上記の数式の導出過程（式変形）を詳細に教えてください。")
])

# ==========================================
# パターンC：自由入力の質問への回答
# ==========================================
prompt_question = ChatPromptTemplate.from_messages([
    ("system", r"""あなたは物理学と数学の専門エージェントです。
ユーザーは、提示された数式について具体的な質問をしています。提供された【周辺の文脈】と会話の流れを踏まえ、質問に的確に答えてください。

【重要なフォーマット指示】
1. 質問に直接答えることを最優先し、質問されていない一般的な解説で水増ししないでください。
2. 必要に応じて式変形や具体例を用いて構いません。
3. 数式は必ずブロック形式のTeX（$$数式$$）またはインライン形式のTeX（$数式$）を使用してください。
4. 数式の前後には必ず「空行（改行2回）」を入れて、見やすく出力してください。
"""),
    MessagesPlaceholder(variable_name="chat_history"),
    ("human", "【対象の数式】\n$$ {clean_tex} $$\n\n【数式に含まれる変数の情報】\n{variables_info}\n\n【周辺の文脈】\n{current_context}\n\n【ユーザーの質問】\n{question}")
])

# 定型ボタンから送られる action_type。これ以外は自由入力の質問として扱う
PRESET_ACTIONS = {"explain", "explain_step", "derivation"}

# ==========================================
# エージェントのノード処理
# ==========================================
def math_agent_node(state: MathState):
    action_type = state.get("action_type") or "explain_step"
    # フロントは自由入力の質問を user_intent と action_type の両方に入れて送る
    question = state.get("user_intent") or action_type
    if action_type not in PRESET_ACTIONS:
        action_type = "question"
    
    # OCRエージェントからの抽出結果（なければ生テキスト）を優先して取得
    clean_tex = state.get("extracted_text") or state.get("raw_text") or state.get("selected_tex") or ""
    
    print(f"🧮 Math Agent起動中... (モード: {action_type})")
    print(f"  => 対象テキスト: {clean_tex[:30]}...")

    print("  => Step 1: 変数情報の抽出（純粋な言語タスク）を開始...")
    target_content = [
        {"type": "text", "text": f"以下のテキスト・数式に含まれる変数の意味を抽出して整理してください。\n\n【対象】\n{clean_tex}\n\n{parser.get_format_instructions()}"}
    ]

    messages_step1 = [
        SystemMessage(content="あなたは数式処理と物理モデルの解析に長けたAIです。"),
        HumanMessage(content=target_content)
    ]

    try:
        response_step1 = llm.invoke(messages_step1)
        math_data = parser.invoke(response_step1)
        variables_info = json.dumps(math_data["variables"], ensure_ascii=False, indent=2)
        print(f"  ✨ 変数抽出成功")
    except Exception as e:
        print(f"  ⚠️ 変数抽出失敗（フォールバック）: {e}")
        variables_info = "抽出なし"

    print("  => Step 2: 導出・解説の生成を開始...")
    
    if action_type == "question":
        target_prompt = prompt_question
    elif action_type == "derivation":
        target_prompt = prompt_derivation
    else:
        target_prompt = prompt_explain
    chain_step2 = target_prompt | llm
    
    response_step2 = chain_step2.invoke({
        "clean_tex": clean_tex,
        "variables_info": variables_info,
        "current_context": state.get("current_context", "特に文脈情報なし"),
        "question": question,
        "chat_history": format_history_to_messages(state.get("chat_history", []))
    })

    print("Math Agent 作業終了")

    return {"math_result": response_step2.content}

# グラフ構築
graph_builder = StateGraph(MathState)
graph_builder.add_node("MathAgent", math_agent_node)
graph_builder.add_edge(START, "MathAgent")
graph_builder.add_edge("MathAgent", END)
math_graph = graph_builder.compile()

# ==========================================
# 実行テスト
# ==========================================
# if __name__ == "__main__":
#     # テストA：論文で「前提の式が省略されている」ケース
#     test_context_infer = {
#         "selected_tex": r"E_n = \frac{n^2 h^2}{8mL^2}", 
#         "action_type": "explain_step",
#         "current_context": r"1次元の無限に深い井戸型ポテンシャル（幅 $L$）の中の電子を考える。境界条件 $\psi(0) = \psi(L) = 0$ を適用すると、エネルギー準位は次のように量子化されることが容易にわかる。",
#         "math_result": ""
#     }

#     # テストB：ユーザーが「式Aから式B」を明示的に選択したケース
#     test_explicit_jump = {
#         "selected_tex": r"e^{ix} = \cos x + i \sin x から \cos x = \frac{e^{ix} + e^{-ix}}{2} への変形", 
#         "action_type": "explain_step",
#         "current_context": r"オイラーの公式を用いると、三角関数は指数関数で表現できる。",
#         "math_result": ""
#     }

#     print("\n=== テストA：文脈からの前提推論テスト ===")
#     result_a = math_graph.invoke(test_context_infer)
#     print(result_a["math_result"])
    
#     print("\n\n=== テストB：式Aから式Bへの明示的な行間補完テスト ===")
#     result_b = math_graph.invoke(test_explicit_jump)
#     print(result_b["math_result"])