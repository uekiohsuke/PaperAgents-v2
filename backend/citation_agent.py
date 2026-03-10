import os
import requests
import urllib.parse
from functools import lru_cache
from typing import TypedDict, Optional
from langgraph.graph import StateGraph, START, END
from langchain_ollama import ChatOllama
from langchain_core.prompts import ChatPromptTemplate
from pydantic import BaseModel, Field
from langchain_core.output_parsers import JsonOutputParser
from dotenv import load_dotenv # 🌟 追加

load_dotenv()
EMAIL = os.environ.get("CROSSREF_EMAIL", "default@example.com")

# ==========================================
# 文献情報抽出ツール
# ==========================================
class CitationData(BaseModel):
    title: str = Field(description="論文や本のタイトル、またはWeb記事のタイトル（英語の場合はそのまま）")
    authors: str = Field(description="著者名のリスト（カンマ区切り）。不明な場合は空文字")
    type: str = Field(description="文献の種類。学術論文や本なら 'paper', WebサイトやURLなら 'website'")
    url: Optional[str] = Field(description="参照テキスト内にURL（http...）が含まれていれば抽出。なければnull")

parser = JsonOutputParser(pydantic_object=CitationData)

prompt_extraction = ChatPromptTemplate.from_messages([
    ("system", "あなたは書誌情報の抽出スペシャリストです。\nユーザーから渡された参考文献の生テキスト（OCRのノイズやページ番号が含まれる場合あり）から、タイトルと著者名を正確に抽出してください。\n\n{format_instructions}"),
    ("human", "{raw_citation_text}")
])

# ==========================================
# APIツール（Crossref + Unpaywall）
# ==========================================
def generate_fallback(color: str, title: str, status_msg: str, abstract: str = "要約データなし", doi: str = None):
    """🟠有料・⚪エラー時にCiNiiとScholar両方のURLを生成"""
    scholar_url = f"https://scholar.google.com/scholar?q={urllib.parse.quote(title)}"
    cinii_url = f"https://cir.nii.ac.jp/all?q={doi}" if doi else f"https://cir.nii.ac.jp/all?q={urllib.parse.quote(title)}"
    message = "無料の公式PDFは見つかりませんでした。" if color == "orange" else "情報の取得に失敗しました。"
    
    return {
        "color": color, "status": status_msg, "url": None,
        "scholar_url": scholar_url, "cinii_url": cinii_url,
        "doi": doi, "abstract": abstract, "message": f"{message}以下のリンクから手動で検索してください。"
    }

@lru_cache(maxsize=100)
def check_paper_availability_keyless(query_title: str, query_authors: str = ""):
    print(f"🔍 APIツール実行中 (Crossref): {query_title[:30]}...")
    crossref_url = f"https://api.crossref.org/works?query.title={urllib.parse.quote(query_title)}"
    if query_authors:
        crossref_url += f"&query.author={urllib.parse.quote(query_authors)}"
    crossref_url += f"&mailto={EMAIL}&select=DOI,title,abstract&rows=1"
    
    try:
        cr_response = requests.get(crossref_url, timeout=10)
        if cr_response.status_code != 200:
            return generate_fallback("gray", query_title, "Crossref APIエラー")
            
        cr_data = cr_response.json()
        items = cr_data.get("message", {}).get("items", [])
        if not items:
            return generate_fallback("gray", query_title, "論文が見つかりませんでした")
            
        top_hit = items[0]
        doi = top_hit.get("DOI")
        raw_abstract = top_hit.get("abstract", "要約データなし")
        abstract = raw_abstract.replace("<jats:p>", "").replace("</jats:p>", "").strip() if raw_abstract else "要約データなし"
        print(top_hit)
        
        if not doi:
             return generate_fallback("gray", query_title, "DOI取得失敗", abstract)

        print(f"🔄 CrossrefでDOI({doi})を取得。UnpaywallでOA判定します...")
        upw_url = f"https://api.unpaywall.org/v2/{doi}?email={EMAIL}"
        upw_response = requests.get(upw_url, timeout=10)
        
        if upw_response.status_code == 200:
            upw_data = upw_response.json()
            if upw_data.get("is_oa") and upw_data.get("best_oa_location"):
                loc = upw_data["best_oa_location"]
                if loc.get("host_type") == "publisher":
                    return {"color": "green", "status": "Open Access (Publisher)", "url": loc.get("url_for_pdf") or loc.get("url"), "doi": doi, "abstract": abstract}
                else:
                    return {"color": "yellow", "status": "Green OA / Repository", "url": loc.get("url_for_pdf") or loc.get("url"), "doi": doi, "abstract": abstract}
                    
        return generate_fallback("orange", query_title, "Paywall / Institutional Access", abstract, doi)
        
    except Exception as e:
        print(f"⚠️ 通信エラー: {e}")
        return generate_fallback("gray", query_title, "通信タイムアウト")

# ==========================================
# State定義
# ==========================================
class CitationState(TypedDict):
    selected_citation: str
    current_context: str
    target_reference_text: str
    paper_info: dict
    relevance_explanation: str

llm = ChatOllama(model="qwen3:14b", temperature=0.2)

# ==========================================
# プロンプト定義
# ==========================================
prompt_citation = ChatPromptTemplate.from_messages([
    ("system", r"""あなたは学術論文の読解をサポートする専門エージェントです。
ユーザーは論文の本文中で引用マークをクリックしました。
提供された【引用元の文脈】と、システムが取得した【引用先論文の情報】（タイトルとアブストラクト）をもとに、「なぜ著者はここでこの論文を引用したのか」を簡潔に解説してください。

【重要なフォーマット指示】
1. アブストラクトの単純な和訳は不要です。現在の文脈において、引用先論文のどのような手法や結論が「根拠・前提」として使われているか（関連性）にフォーカスしてください。
2. 初学者が直感的に理解できるよう、3〜4文程度で分かりやすく説明してください。

【例外処理：アブストラクトが取得できなかった場合】
もし提供されたアブストラクトが「要約データなし」や空欄であった場合、絶対に知ったかぶりをせず、以下の手順で回答を作成してください。
・回答の冒頭に必ず「⚠️ **アブストラクトが取得できなかったため、タイトルと文脈からの推測を含みます:**」と明記してください。
・その上で、引用元の文脈から「著者が何を根拠にしたくて、この位置で引用を行ったと考えられるか」を論理的に推論して解説してください。あなたの事前知識で論文を知っている場合も、あくまで推測として提示してください。
"""),
    ("human", """【引用箇所】
{selected_citation}

【引用元の文脈】
{current_context}

【引用先論文の情報】
タイトル: {title}
アブストラクト: {abstract}
""")
])

# ==========================================
# ノード処理
# ==========================================
def citation_agent_node(state: CitationState):
    raw_text = state["target_reference_text"]
    print(f"📚 Citation Agent起動: 生テキスト '{raw_text[:30]}...' を解析中...")

    # LLMによる構造化とゴミ取り
    chain_extract = prompt_extraction | llm | parser
    try:
        extracted_data = chain_extract.invoke({
            "raw_citation_text": raw_text,
            "format_instructions": parser.get_format_instructions()
        })
        print(f"✨ 抽出成功: {extracted_data['title']} (著者: {extracted_data['authors']}) [Type: {extracted_data['type']}]")
    except Exception as e:
        print(f"⚠️ 抽出失敗（フォールバック）: {e}")
        extracted_data = {"title": raw_text, "authors": "", "type": "paper", "url": None}

    paper_info = {}
    
    # 種類に応じたAPI検索 または Web処理
    if extracted_data["type"] == "website":
        # Webサイトの場合はCrossrefを叩かず、青色の専用カード情報を即座に作る
        paper_info = {
            "color": "blue", 
            "status": "Web Article / URL",
            "url": extracted_data["url"],
            "title": extracted_data["title"],
            "authors": extracted_data["authors"],
            "abstract": "Webサイトの参照です。",
            "scholar_url": None, "cinii_url": None
        }
    else:
        # 論文・本の場合は、抽出したタイトルと著者名を使って検索
        # フロントエンド表示用に抽出データを混ぜ込む
        paper_info = check_paper_availability_keyless(
            extracted_data["title"], 
            extracted_data["authors"]
        )
        paper_info["title"] = extracted_data["title"]
        paper_info["authors"] = extracted_data["authors"]

    # LLMで関連性推論
    print(f"🧠 関連性推論の開始...")
    chain_citation = prompt_citation | llm
    response = chain_citation.invoke({
        "selected_citation": state["selected_citation"],
        "current_context": state["current_context"],
        "title": paper_info.get("title", ""),
        "abstract": paper_info.get("abstract", "要約データなし")
    })
    
    return {
        "paper_info": paper_info,
        "relevance_explanation": response.content.strip()
    }

# グラフ構築
graph_builder = StateGraph(CitationState)
graph_builder.add_node("CitationAgent", citation_agent_node)
graph_builder.add_edge(START, "CitationAgent")
graph_builder.add_edge("CitationAgent", END)
citation_graph = graph_builder.compile()

# ==========================================
# 実行テスト
# ==========================================
if __name__ == "__main__":
    print("\n=== Citation Agent 実行テスト ===")
    
    # ノイズ（ページ番号や年号）混じりの学術論文
    test_state_paper = {
        "selected_citation": "[1]",
        "current_context": "特殊相対性理論は、光速度不変の原理と相対性原理を基礎として構築された[1]。これにより、時間と空間の概念は根本的に見直されることとなった。",
        "target_reference_text": "A. Einstein, \"Zur Elektrodynamik bewegter Körper,\" Annalen der Physik, vol. 322, no. 10, pp. 891-921, 1905.",
        "paper_info": {},
        "relevance_explanation": ""
    }

    # URLが含まれるWebサイトの引用
    test_state_web = {
        "selected_citation": "[2]",
        "current_context": "Pythonの公式ドキュメントによれば、リスト内包表記は通常のforループよりも高速に動作する場合がある[2]。",
        "target_reference_text": "Python Software Foundation, \"Data Structures — Python 3.12.2 documentation\", Available: https://docs.python.org/3/tutorial/datastructures.html",
        "paper_info": {},
        "relevance_explanation": ""
    }

    print("\n\n=== 🧪 テストA: 学術論文の抽出と検索 ===")
    result_paper = citation_graph.invoke(test_state_paper)
    
    print("\n■ 【システム用】抽出・取得された書誌データ")
    print(f"ステータス: {result_paper['paper_info'].get('color', 'gray').upper()} ({result_paper['paper_info'].get('status', 'Unknown')})")
    print(f"抽出タイトル: {result_paper['paper_info'].get('title')}")
    print(f"抽出著者: {result_paper['paper_info'].get('authors')}")
    print(f"直接PDF URL: {result_paper['paper_info'].get('url')}")
    if result_paper['paper_info'].get('scholar_url'):
        print(f"Scholar URL: {result_paper['paper_info'].get('scholar_url')}")
    
    print("\n■ 【ユーザー表示用】関連性の解説")
    print(result_paper['relevance_explanation'])


    print("\n\n=== 🧪 テストB: Webサイトの自動判定 ===")
    result_web = citation_graph.invoke(test_state_web)
    
    print("\n■ 【システム用】抽出・取得された書誌データ")
    print(f"ステータス: {result_web['paper_info'].get('color', 'gray').upper()} ({result_web['paper_info'].get('status', 'Unknown')})")
    print(f"抽出タイトル: {result_web['paper_info'].get('title')}")
    print(f"抽出著者: {result_web['paper_info'].get('authors')}")
    print(f"直接Web URL: {result_web['paper_info'].get('url')}")
    
    print("\n■ 【ユーザー表示用】関連性の解説")
    print(result_web['relevance_explanation'])