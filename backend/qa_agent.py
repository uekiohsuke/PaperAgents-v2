import json
from typing import TypedDict, List, Dict, Optional
from langgraph.graph import StateGraph, START, END
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage

import os
from langchain_openai import ChatOpenAI
from dotenv import load_dotenv

load_dotenv()

llm = ChatOpenAI(
    base_url=os.environ.get("LOCAL_OPENAI_BASE_URL", "http://127.0.0.1:1234/v1"),
    api_key=os.environ.get("LOCAL_OPENAI_API_KEY") or "dummy",  # 空文字は新しい openai が拒否する
    model=os.environ.get("LOCAL_OPENAI_MODEL_NAME", "qwen3:14b"),
    temperature=0.2,
    # streaming=True 
)

# Stateの定義
class QAState(TypedDict):
    intent: str
    raw_text: Optional[str]
    extracted_text: Optional[str]
    paper_metadata: str
    selected_text: str
    current_context: str
    chat_history: List[Dict[str, str]]
    user_intent: str      
    qa_answer: str
    dict_suggestions: str

# ==========================================
# 意図（カテゴリ）から具体的な指示へのマッピング
# ==========================================
INTENT_INSTRUCTIONS = {
    "explain": "この文章に含まれる専門用語や難解な概念を、初学者向けに噛み砕いて解説してください。",
    "intent": "前後の文脈から、著者がなぜここでこの文章を述べたのか、論理展開上の意図や背景を解説してください。",
    "example": "この文章で述べられている抽象的な概念について、直感的に理解できる具体的な物理・数学的モデルや例を挙げて説明してください。",
    "summarize": "専門用語や回りくどい表現を削ぎ落とし、この文章が言わんとしている結論を簡潔にシンプルに要約してください。",
    "evidence": "著者の主張を支える暗黙の前提条件や、背景にある一般的な物理法則・定理などの根拠を推論して提示してください。",
    "translate": "提供された文章を、前後の文脈を踏まえて自然な学術的日本語に翻訳してください。また、その文脈で特に重要、あるいは難解な専門用語や熟語を数個抽出し、解説を添えてください。"
}

# ==========================================
# プロンプトの定義（辞書抽出の改良版）
# ==========================================
# 履歴をLangChainのメッセージオブジェクトに変換
def format_history_to_messages(history_dicts, max_turns=5):
    messages = []
    # トークン溢れ対策で直近のN往復取得
    recent_history = history_dicts[-(max_turns * 2):] if history_dicts else []
    
    for msg in recent_history:
        if msg["role"] == "user":
            messages.append(HumanMessage(content=msg["content"]))
        elif msg["role"] == "ai":
            messages.append(AIMessage(content=msg["content"]))
            
    return messages

# ==========================================
# ノード処理
# ==========================================
def qa_agent_node(state: QAState):
    intent_key = state.get("user_intent") or state.get("intent") or "explain"
    selected_text = state.get("extracted_text") or state.get("raw_text") or ""
    current_context = state.get("current_context", "")
    chat_history_msgs = format_history_to_messages(state.get("chat_history", []))

    # 🌟 1. 翻訳タスク（translate）の分岐
    if intent_key == "translate":
        print("💬 QA Agent: 翻訳・語彙抽出モード実行中...")
        
        sys_prompt_translate = SystemMessage(content=r"""あなたは学術論文の専門翻訳家および物理学・数学の教育者です。
提供された【周辺の文脈】を考慮して、選択された文章を自然で正確な日本語に翻訳してください。

また、文章に含まれる重要な専門用語や物理概念を抽出し、その文脈における意味を解説してください。

【出力フォーマット】
以下のレイアウトを厳守してください。

[回答]
（ここに翻訳文を記述）

[辞書データ]
{{
  "terms": [
    {{"term": "抽出用語", "description": "この文脈での意味・定義"}}
  ],
  "variables": []
}}
""")
        
        human_content = f"""【周辺の文脈】\n{current_context}\n\n【選択された文章】\n{selected_text}\n\nこの文章を翻訳し、重要単語を抽出してください。"""
        
        response = llm.invoke([sys_prompt_translate, HumanMessage(content=human_content)])
        
        # 🌟 追加: 翻訳結果をパースして、すぐに return で終了させる！
        raw_output = response.content
        try:
            answer_part, dict_part = raw_output.split("[辞書データ]")
            answer_text = answer_part.replace("[回答]", "").strip()
            dict_json_str = dict_part.strip()
        except ValueError:
            answer_text = raw_output
            dict_json_str = "[]"
            
        print("QA Agent 作業終了 (翻訳モード)")
        return {
            "qa_answer": answer_text,
            "dict_suggestions": dict_json_str
        }    
    # スレッド引き継ぎ用の要約モード
    elif intent_key == "thread_summary":
        print("💬 QA Agent起動中... (スレッド引き継ぎ要約モード)")
        chat_history_msgs = format_history_to_messages(state.get("chat_history", []))
        
        # システムプロンプトは役割の定義だけに留める
        sys_prompt = SystemMessage(content="あなたは優秀な研究アシスタントです。")
        
        # 🌟 変更: 要約の指示を「最後のユーザー発言」として追加する
        summary_instruction = HumanMessage(content="""
        ここまでのチャット履歴を振り返り、私が何について疑問を持ち、どのような重要な結論や理解が得られたかを要約してください。
        目的は「他のスレッドに文脈として引き継ぐこと」です。箇条書きで3〜4行程度に極めて簡潔にまとめてください。
        """)
        
        # メッセージ配列を [システム] + [履歴] + [要約してという指示] の順にする
        messages = [sys_prompt] + chat_history_msgs + [summary_instruction]
        
        response = llm.invoke(messages)
        return {
            "qa_answer": response.content.strip(),
            "dict_suggestions": "[]" # このモードでは辞書データは不要
        }
        pass
    else:
        # 自由入力か定型ボタンか判定
        if intent_key in INTENT_INSTRUCTIONS:
            intent_instruction = INTENT_INSTRUCTIONS[intent_key]
            print(f"💬 QA Agent起動中... (定型コマンド: 【{intent_key}】)")
        else:
            intent_instruction = intent_key if intent_key else "解説してください"
            print(f"💬 QA Agent起動中... (自由入力: 【{intent_key}】)")
        
        chat_history_msgs = format_history_to_messages(state.get("chat_history", []))
        
        if selected_text.strip():
            human_prompt_template = """【文献情報】
    {paper_metadata}

    【前後の文脈】
    {current_context}

    【選択された文章】
    {selected_text}

    【ユーザーの要求（意図）】
    {intent_instruction}"""
        else:
            human_prompt_template = """【文献情報】
    {paper_metadata}

    【前後の文脈】
    {current_context}

    【ユーザーの要求（質問）】
    {intent_instruction}"""

        prompt_qa = ChatPromptTemplate.from_messages([
            ("system", r"""あなたは学術論文の読解をサポートする対話型アシスタントです。
    ユーザーが論文の一部を選択し、特定のアクション（意図）を要求しています。提供された【文献情報】と【前後の文脈】を踏まえ、以下の2つのセクションに分けて出力してください。

    【重要なフォーマット指示】
    1. まとめや結論などの堅苦しい挨拶は不要です。対話スレッドの返信として、簡潔で自然なトーンで回答してください。
    2. 出力は必ず以下のレイアウトを厳守し、[回答]セクションと[辞書データ]セクションを明確に分けてください。

    【出力レイアウト】
    [回答]
    （ここにユーザーの要求に対する自然な回答テキストを記述。数式が含まれる場合は $$数式$$ または $数式$ を使用してください）

    [辞書データ]
    （※重要※ あなたの[回答]の長さや内容（要約など）には一切影響されず、提供された【前後の文脈】と【選択された文章】そのものを深く分析し、以下のJSON形式で出力してください。
    ・terms: 文章表面の単語だけでなく、この文脈の背後にある最も重要な物理的・数学的概念（例：不確定性原理など）をあなたの専門知識を用いて推論し、必ず3〜5個抽出してください。
    ・variables: 文章や数式に登場する固有の変数や記号を独立して抽出してください。）
    {{
    "terms": [
        {{"term": "抽出した用語や概念", "description": "その文脈における簡潔な意味や定義"}}
    ],
    "variables": [
        {{"symbol": "抽出した変数や記号", "description": "それが表す物理量や数学的意味"}}
    ]
    }}
    """),
            MessagesPlaceholder(variable_name="chat_history"),
            ("human", human_prompt_template)
        ])
    
    chain = prompt_qa | llm
    
    response = chain.invoke({
        "paper_metadata": state.get("paper_metadata", ""),
        "current_context": state.get("current_context", ""),
        "selected_text": selected_text,
        "intent_instruction": intent_instruction,
        "chat_history": chat_history_msgs
    })
    
    raw_output = response.content
    try:
        answer_part, dict_part = raw_output.split("[辞書データ]")
        answer_text = answer_part.replace("[回答]", "").strip()
        dict_json_str = dict_part.strip()
    except ValueError:
        answer_text = raw_output
        dict_json_str = "[]"
        
    print("QA Agent 作業終了")

    return {
        "qa_answer": answer_text,
        "dict_suggestions": dict_json_str
    }

# グラフ構築
graph_builder = StateGraph(QAState)
graph_builder.add_node("QAAgent", qa_agent_node)
graph_builder.add_edge(START, "QAAgent")
graph_builder.add_edge("QAAgent", END)
qa_graph = graph_builder.compile()

# ==========================================
# 実行テスト
# ==========================================
if __name__ == "__main__":
    test_metadata = "Title: Foundations of Quantum Mechanics, Authors: W. Heisenberg"
    test_context = "古典力学では粒子の位置と運動量は同時に正確に決定できると仮定される。しかし、ミクロな世界では状況が異なる。観察という行為自体が対象に不可避の擾乱を与えるからである。この性質により、粒子の位置 $x$ と運動量 $p$ を同時に正確に測定することは原理的に不可能となる。"
    test_selected = "この性質により、粒子の位置 $x$ と運動量 $p$ を同時に正確に測定することは原理的に不可能となる。"

    # テストA：「具体例」ボタンが押された場合
    state_example = {
        "paper_metadata": test_metadata,
        "current_context": test_context,
        "selected_text": test_selected,
        "user_intent": "具体例", # UIのボタンに該当
        "qa_answer": "", "dict_suggestions": ""
    }

    # テストB：「要約」ボタンが押された場合
    state_summary = {
        "paper_metadata": test_metadata,
        "current_context": test_context,
        "selected_text": test_selected,
        "user_intent": "要約", # UIのボタンに該当
        "qa_answer": "", "dict_suggestions": ""
    }

    print("\n=== テストA：【具体例】を要求 ===")
    res_a = qa_graph.invoke(state_example)
    print("[UI表示用 回答]\n" + res_a["qa_answer"])
    print("\n[システム用 辞書データ]\n" + res_a["dict_suggestions"])
    
    print("\n\n=== テストB：【要約】を要求 ===")
    res_b = qa_graph.invoke(state_summary)
    print("[UI表示用 回答]\n" + res_b["qa_answer"])
    print("\n[システム用 辞書データ]\n" + res_b["dict_suggestions"])