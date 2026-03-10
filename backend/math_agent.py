from typing import TypedDict
from langgraph.graph import StateGraph, START, END
from langchain_ollama import ChatOllama
from langchain_core.prompts import ChatPromptTemplate

class MathState(TypedDict):
    selected_tex: str
    action_type: str
    current_context: str
    math_result: str

llm = ChatOllama(model="qwen3:14b", temperature=0)

# ==========================================
# プロンプトの定義
# ==========================================
# パターンA：全体の導出（derivation）
prompt_derivation = ChatPromptTemplate.from_messages([
    ("system", r"""あなたは物理学と数学の専門エージェントです。
与えられた数式の一般的な導出過程を、初学者がつまずかないようステップバイステップで出力してください。

【重要なフォーマット指示】
1. 数式は必ずブロック形式のTeX（$$数式$$）で独立した行に出力してください。
2. Step 1には必ず「出発点となる実際の数式」を出力してください。「(出発点となる式)」のような文字列は絶対に出力せず、具体的な数式に置き換えてください。
3. 最後に「補足説明」としてまとめるのではなく、解説は必ず各ステップの「■ 解説:」の後に含めてください。

【出力例】
[Step 1]
$$P^\mu = (E/c, \mathbf{{p}})$$
■ 解説: 4元運動量の定義です。これはどの慣性系から見ても変わらない不変量を作るための出発点となります。

[Step 2] 《操作: 4元運動量の内積（ローレンツ不変量）を計算する》
$$P^\mu P_\mu = (E/c)^2 - p^2 = (mc)^2$$
■ 解説: 具体的に内積を計算し整理すると、右辺は $(mc)^2$ になります。

[Step 3] 《操作: 静止系（p = 0）の条件を代入する》
$$E = mc^2$$
■ 解説: 物体が静止している状態を代入することで得られます。

---
上記に従い、以下の数式の導出過程を出力してください。
"""),
    ("human", "以下の数式の導出過程を教えてください。\n数式: {selected_tex}")
])

# パターンB：行間の解説・文脈からの推論（explain_step）
prompt_explain_step = ChatPromptTemplate.from_messages([
    ("system", r"""あなたは物理学と数学の専門エージェントです。
ユーザーは、提示された数式の「変形操作そのもの」や「行間の飛躍」に躓いています。

【前提の推論ルール】
1. ユーザーが単一の式のみを選択している場合、提供された【周辺の文脈】から、直前の式や前提条件を推論して出発点（Step 1）に設定してください。
2. 文脈に明記されていない場合でも、物理・数学の一般的な基本法則（定義式など）であれば、あなたの知識を用いてそれをStep 1として補足して解説を始めてください。
3. ユーザーが2つの式を選択している（「式Aから式B」という指定がある）場合は、その2式間の行間を埋めることに専念してください。

【重要なフォーマット指示】
1. 最後に「まとめ」「結論」「補足」などの項目を絶対に作らないでください。すべての解説は各ステップの「■ 解説:」の中に収め、Stepが終わったら直ちに出力を終了してください。
2. 数式は必ずブロック形式のTeX（$$数式$$）で独立した行に出力してください。
3. 飛躍している計算過程を、非常に細かいStepに分割して提示してください。

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
    ("human", "【選択された数式】\n{selected_tex}\n\n【周辺の文脈（参考）】\n{current_context}")
])

# ==========================================
# エージェントのノード処理
# ==========================================
def math_agent_node(state: MathState):
    print(f"🧮 Math Agent起動中... (モード: {state['action_type']})")
    
    if state["action_type"] == "derivation":
        target_prompt = prompt_derivation
    elif state["action_type"] == "explain_step":
        target_prompt = prompt_explain_step
    else:
        target_prompt = prompt_derivation
        
    chain = target_prompt | llm
    
    # 辞書型で変数を渡す。current_context が無い場合はデフォルト文字を入れる
    response = chain.invoke({
        "selected_tex": state["selected_tex"],
        "current_context": state.get("current_context", "特に文脈情報なし")
    })
    
    return {"math_result": response.content}

# グラフ構築
graph_builder = StateGraph(MathState)
graph_builder.add_node("MathAgent", math_agent_node)
graph_builder.add_edge(START, "MathAgent")
graph_builder.add_edge("MathAgent", END)
math_graph = graph_builder.compile()

# ==========================================
# 実行テスト
# ==========================================
if __name__ == "__main__":
    # テストA：論文で「前提の式が省略されている」ケース
    test_context_infer = {
        "selected_tex": r"E_n = \frac{n^2 h^2}{8mL^2}", 
        "action_type": "explain_step",
        "current_context": r"1次元の無限に深い井戸型ポテンシャル（幅 $L$）の中の電子を考える。境界条件 $\psi(0) = \psi(L) = 0$ を適用すると、エネルギー準位は次のように量子化されることが容易にわかる。",
        "math_result": ""
    }

    # テストB：ユーザーが「式Aから式B」を明示的に選択したケース
    test_explicit_jump = {
        "selected_tex": r"e^{ix} = \cos x + i \sin x から \cos x = \frac{e^{ix} + e^{-ix}}{2} への変形", 
        "action_type": "explain_step",
        "current_context": r"オイラーの公式を用いると、三角関数は指数関数で表現できる。",
        "math_result": ""
    }

    print("\n=== テストA：文脈からの前提推論テスト ===")
    result_a = math_graph.invoke(test_context_infer)
    print(result_a["math_result"])
    
    print("\n\n=== テストB：式Aから式Bへの明示的な行間補完テスト ===")
    result_b = math_graph.invoke(test_explicit_jump)
    print(result_b["math_result"])