from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from dotenv import load_dotenv
from llm_settings import make_llm

load_dotenv()

llm = make_llm(temperature=0.2)

def library_agent_node(state: dict) -> dict:
    print("🧠 [Library Agent] RAGとネットワーク情報を解析中...")
    
    query = state.get("raw_text", "")
    rag_context = state.get("current_context", "") # main.pyで検索した結果がここに入ります
    library_data = state.get("library_context", {}) # フロントから送られるネットワーク情報
    
    # 未読ノードのリストを文字列にフォーマット
    unloaded_nodes = library_data.get("unloaded_references", [])
    unloaded_str = "\n".join([f"- ID: {n.get('id')}, タイトル: {n.get('title')}, 引用回数: {n.get('citations', 0)}" for n in unloaded_nodes])
    
    # 既読PDFのリスト
    loaded_pdfs = library_data.get("loaded_pdfs", [])
    loaded_str = "\n".join([f"- ID: {p}" for p in loaded_pdfs])

    system_prompt = """あなたはユーザーの優秀な研究パートナー「Sui」です。
ユーザーの質問に対し、提供された【ローカル知識】と【ライブラリ情報】を元に回答・ナビゲートしてください。

【重要なルール】
1. あなたの回答の中で特定の文献（既読・未読問わず）に言及する際は、必ず `[node:文献ID]` というタグを含めてください。
   （例：「これについては [node:sample.pdf] で詳しく解説されています。」）
   （例：「未読の [node:もっとも身近な粒子の化学] という文献が役立つかもしれません。」）
2. まずは【ローカル知識】から答えを探してください。
3. もし【ローカル知識】に十分な情報がない場合は、【未読の参考文献リスト】の中から引用回数やタイトルをヒントに最も有望なものを推測し、「これを実体化（OA確認）してみてはどうでしょう？」と提案してください。
"""

    user_prompt = f"""
質問: {query}

【ローカル知識（RAG検索結果）】
{rag_context if rag_context else "検索結果なし"}

【ライブラリ情報】
■ 現在読み込み済みのPDF（ID一覧）
{loaded_str if loaded_str else "なし"}

■ 未読の参考文献リスト（有望な候補）
{unloaded_str if unloaded_str else "なし"}
"""

    prompt = ChatPromptTemplate.from_messages([
        ("system", system_prompt),
        ("human", "{user_prompt}")
    ])

    chain = prompt | llm | StrOutputParser()
    
    # ストリーミング対応のために yield できるように直接返すのではなく、
    # 実際は main.py のストリーミング機構が文字単位で拾うため、ここで一括生成して dict に詰めます。
    # （LangGraphの非同期ストリーミングの作りに合わせて出力します）
    
    # ※本番環境では astream 等を使いますが、現状のコードベースに合わせて invoke します
    result = chain.invoke({"user_prompt": user_prompt})
    
    return {"qa_answer": result}