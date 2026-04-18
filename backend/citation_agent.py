import os, re
import requests
import urllib.parse
from functools import lru_cache
from typing import TypedDict, Optional
from langgraph.graph import StateGraph, START, END
from langchain_core.prompts import ChatPromptTemplate
from pydantic import BaseModel, Field
from langchain_core.output_parsers import JsonOutputParser
from langchain_openai import ChatOpenAI
from dotenv import load_dotenv

load_dotenv()

llm = ChatOpenAI(
    base_url=os.environ.get("LOCAL_OPENAI_BASE_URL", "http://127.0.0.1:1234/v1"),
    api_key=os.environ.get("LOCAL_OPENAI_API_KEY", ""),
    model=os.environ.get("LOCAL_OPENAI_MODEL_NAME", "qwen3:14b"),
    temperature=0.2,
    # streaming=True 
)

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
# ネットワークグラフ用 APIツール (Semantic Scholar)
# ==========================================
def fetch_citation_network(query_title: str, max_nodes: int = 15):
    """
    指定された論文を中心に、引用（References）と被引用（Citations）の
    ネットワークデータを取得し、フロントエンド(D3.js)用の nodes/links 形式で返す。
    """
    print(f"🌐 [Network] Semantic Scholar APIで '{query_title[:30]}...' のネットワークを構築中...")
    
    # Semantic Scholar API (検索と同時に引用・被引用データを取得)
    # 取得フィールド: ID, タイトル, 年, 被引用数, 引用リスト(title, id), 被引用リスト(title, id)
    url = f"https://api.semanticscholar.org/graph/v1/paper/search?query={urllib.parse.quote(query_title)}&limit=1&fields=paperId,title,year,citationCount,references.paperId,references.title,citations.paperId,citations.title"
    
    try:
        print(url)
        response = requests.get(url, timeout=15)
        if response.status_code != 200 or not response.json().get("data"):
            print("⚠️ Semantic Scholarで論文が見つかりませんでした。")
            return {"nodes": [], "links": []}
            
        target_paper = response.json()["data"][0]
        center_id = target_paper.get("paperId", "center_node")
        
        # グラフデータの初期化
        nodes = []
        links = []
        seen_ids = set()
        
        # 中心ノード（今読んでいる論文）を追加
        nodes.append({
            "id": center_id,
            "title": target_paper.get("title", "Unknown Title"),
            "group": "Center", # グループ分け用
            "citations": target_paper.get("citationCount", 10),
            "year": target_paper.get("year", "")
        })
        seen_ids.add(center_id)
        
        # 1. References（この論文が引用している過去の文献）の処理
        references = target_paper.get("references", [])
        for ref in references[:max_nodes // 2]: # 表示数を制限
            ref_id = ref.get("paperId")
            if not ref_id or ref_id in seen_ids: continue
            
            nodes.append({
                "id": ref_id,
                "title": ref.get("title", "Unknown Title"),
                "group": "Reference",
                "citations": 5 # 簡易的なデフォルト値
            })
            # 中心ノードからReferenceへの矢印
            links.append({"source": center_id, "target": ref_id})
            seen_ids.add(ref_id)
            
        # 2. Citations（この論文を引用している未来の文献）の処理
        citations = target_paper.get("citations", [])
        for cit in citations[:max_nodes // 2]:
            cit_id = cit.get("paperId")
            if not cit_id or cit_id in seen_ids: continue
            
            nodes.append({
                "id": cit_id,
                "title": cit.get("title", "Unknown Title"),
                "group": "Citation",
                "citations": 5
            })
            # Citationから中心ノードへの矢印
            links.append({"source": cit_id, "target": center_id})
            seen_ids.add(cit_id)
            
        print(f"✅ ネットワーク構築完了: {len(nodes)}ノード, {len(links)}リンク")
        return {"nodes": nodes, "links": links}
        
    except Exception as e:
        print(f"⚠️ ネットワーク取得エラー: {e}")
        return {"nodes": [], "links": []}

# ==========================================
# State定義
# ==========================================
class CitationState(TypedDict):
    intent: str
    raw_text: Optional[str]
    extracted_text: Optional[str]
    selected_citation: str
    current_context: str
    references_dict: dict
    target_reference_text: str
    paper_info: dict
    relevance_explanation: str

# ==========================================
# プロンプト定義
# ==========================================
# 🌟 変更: ギャップ分析と批判的読み取りを強調したプロンプト
prompt_citation = ChatPromptTemplate.from_messages([
    ("system", r"""あなたは学術論文の批判的読解（Critical Reading）をサポートする専門エージェントです。
ユーザーは論文の本文中で引用されている文献について調査を依頼しました。

提供された【現在読んでいる論文の文脈】と、【引用先論文の情報（タイトルとアブストラクト）】を比較し、以下の3つの観点から分析レポートを作成してください。

【出力フォーマット】
### 1. 引用先論文の概要
（アブストラクトから読み取れる、元論文の主な主張や手法を2〜3文で簡潔に）

### 2. 本論文での使われ方と対応関係
（現在の文脈において、元論文のどの要素が「根拠・前提・比較対象」として使われているか。もし変数や用語の対応関係が推測できる場合はそれも記載）

### 3. 🔍 ギャップ分析・批判的視点
（ここが最も重要です。以下の点について考察してください）
- 著者は元論文の主張をそのまま鵜呑みにしているか、それとも一部を批判・拡張しているか？
- 元論文の前提条件（実験環境や制約など）が、現在の論文の文脈に無理なく適用できるか？（飛躍や過度の一般化がないか）
- もしアブストラクトから読み取れる元論文の主張と、現在の論文での引用のされ方に「ズレ」や「都合の良い解釈」の可能性があれば指摘してください。

【例外処理：アブストラクトが取得できなかった場合】
アブストラクトが「要約データなし」の場合は、その旨を明記した上で、タイトルと文脈のみから「なぜここで引用されたと考えられるか」の推測のみを提供してください。
また、回答の冒頭に必ず「⚠️ **アブストラクトが取得できなかったため、タイトルと文脈からの推測を含みます:**」と明記してください。
"""),
    ("human", """【現在読んでいる論文の文脈】
{current_context}

【引用先論文の情報】
タイトル: {title}
アブストラクト: {abstract}
""")
])

# ==========================================
# OAステータス確認専用の軽量関数（main.py等から呼ばれる）
# ==========================================
def get_oa_status_from_text(raw_citation_text: str) -> dict:
    print(f"🚦 [OA Check] テキスト抽出を開始: {raw_citation_text[:30]}...")
    chain_extract = prompt_extraction | llm | parser
    
    try:
        extracted = chain_extract.invoke({
            "raw_citation_text": raw_citation_text,
            "format_instructions": parser.get_format_instructions()
        })
        
        # Webサイトの場合は即座に青信号を返す
        if extracted.get("type") == "website":
             return {
                 "color": "blue", 
                 "status": "Web Article", 
                 "title": extracted.get("title", ""),
                 "url": extracted.get("url") # ← これを追加！
             }
        
        # 論文の場合はAPIを叩いて調査
        info = check_paper_availability_keyless(extracted.get("title", ""), extracted.get("authors", ""))
        info["title"] = extracted.get("title", "") # UI表示用にタイトルを付与
        return info
        
    except Exception as e:
        print(f"⚠️ [OA Check] エラー発生: {e}")
        return {"color": "gray", "status": "Error", "message": str(e)}

# ==========================================
# ノード処理
# ==========================================
def citation_agent_node(state: CitationState):
    # 1. OCR結果（画像からの読み取り）、または生の選択テキストを取得
    input_text = state.get("extracted_text") or state.get("raw_text") or state.get("selected_citation") or ""
    refs_dict = state.get("references_dict", {})
    
    if state.get("extracted_text"):
        original_context = state.get("current_context", "").strip()
        state["current_context"] = f"【画像から抽出された正確な対象テキスト】\n{input_text}\n\n【ページ周辺の広い文脈】\n{original_context}"
        print("🔍 OCR抽出テキストとページ文脈を合成")

    target_reference_text = ""
    
    # 🌟 新機能: テキスト内から "[n]" という引用番号を正規表現で自動探索
    found_refs = re.findall(r'\[\d+\]', input_text)
    
    if found_refs:
        target_num = found_refs[0] # 最初に見つかった番号を採用
        target_reference_text = refs_dict.get(target_num, "")
        print(f"🔍 抽出テキストから引用番号 {target_num} を発見しました。")
    
    # 辞書から引けなかった場合は、入力されたテキスト自体が書誌情報だとみなす
    if not target_reference_text:
        print("⚠️ 辞書からの特定に失敗したため、テキストを直接解析します。")
        target_reference_text = input_text

    print(f"📚 Citation Agent起動: 生テキスト '{target_reference_text[:30]}...' を解析中...")

    # LLMによる構造化とゴミ取り
    chain_extract = prompt_extraction | llm | parser
    try:
        extracted_data = chain_extract.invoke({
            "raw_citation_text": target_reference_text, # 🌟 変更: 特定したテキストを渡す
            "format_instructions": parser.get_format_instructions()
        })
        print(f"✨ 抽出成功: {extracted_data['title']} (著者: {extracted_data['authors']}) [Type: {extracted_data['type']}]")
    except Exception as e:
        print(f"⚠️ 抽出失敗（フォールバック）: {e}")
        extracted_data = {"title": state.get("raw_text"), "authors": "", "type": "paper", "url": None}

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

    # print("\n\n=== 🧪 テストA: 学術論文の抽出と検索 ===")
    # result_paper = citation_graph.invoke(test_state_paper)
    
    # print("\n■ 【システム用】抽出・取得された書誌データ")
    # print(f"ステータス: {result_paper['paper_info'].get('color', 'gray').upper()} ({result_paper['paper_info'].get('status', 'Unknown')})")
    # print(f"抽出タイトル: {result_paper['paper_info'].get('title')}")
    # print(f"抽出著者: {result_paper['paper_info'].get('authors')}")
    # print(f"直接PDF URL: {result_paper['paper_info'].get('url')}")
    # if result_paper['paper_info'].get('scholar_url'):
    #     print(f"Scholar URL: {result_paper['paper_info'].get('scholar_url')}")
    
    # print("\n■ 【ユーザー表示用】関連性の解説")
    # print(result_paper['relevance_explanation'])


    # print("\n\n=== 🧪 テストB: Webサイトの自動判定 ===")
    # result_web = citation_graph.invoke(test_state_web)
    
    # print("\n■ 【システム用】抽出・取得された書誌データ")
    # print(f"ステータス: {result_web['paper_info'].get('color', 'gray').upper()} ({result_web['paper_info'].get('status', 'Unknown')})")
    # print(f"抽出タイトル: {result_web['paper_info'].get('title')}")
    # print(f"抽出著者: {result_web['paper_info'].get('authors')}")
    # print(f"直接Web URL: {result_web['paper_info'].get('url')}")
    
    # print("\n■ 【ユーザー表示用】関連性の解説")
    # print(result_web['relevance_explanation'])

    # print("\n\n=== 🧪 テストC: 引用ネットワークの構築テスト ===")
    # # アインシュタインの相対性理論の論文タイトルでネットワークテスト
    # network_data = fetch_citation_network("Zur Elektrodynamik bewegter Körper")
    
    # print(f"\n■ 【システム用】生成されたD3.js用グラフデータ (Nodes: {len(network_data['nodes'])})")
    # for node in network_data['nodes'][:5]: # 長いので5件だけ表示
    #     print(f"  - [{node['group']}] {node['title'][:50]}...")
        
    # print(f"\n■ 【システム用】生成されたエッジ/リンク (Links: {len(network_data['links'])})")
    # for link in network_data['links'][:5]:
    #     print(f"  - {link['source'][:8]}... -> {link['target'][:8]}...")