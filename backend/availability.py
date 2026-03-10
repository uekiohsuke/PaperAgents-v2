import requests
import urllib.parse
from functools import lru_cache

@lru_cache(maxsize=100)
def check_paper_availability_keyless(query_title: str):
    print(f"\n🔍 検索開始 (Crossref): {query_title}")
    
    # ==========================================
    # Step 1: Crossref API (タイトル -> DOIとアブスト)
    # ==========================================
    crossref_url = f"https://api.crossref.org/works?query.title={urllib.parse.quote(query_title)}&mailto={EMAIL}&select=DOI,title,abstract&rows=1"
    
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
        print(abstract)
        
        if not doi:
             return generate_fallback("gray", query_title, "DOIが取得できませんでした", abstract)

        # ==========================================
        # Step 2: Unpaywall API (DOI -> OA判定とPDFリンク)
        # ==========================================
        print(f"🔄 CrossrefでDOI({doi})を取得。UnpaywallでOA判定します...")
        upw_url = f"https://api.unpaywall.org/v2/{doi}?email={EMAIL}"
        
        upw_response = requests.get(upw_url, timeout=10)
        if upw_response.status_code == 200:
            upw_data = upw_response.json()
            
            if upw_data.get("is_oa") and upw_data.get("best_oa_location"):
                location = upw_data["best_oa_location"]
                
                # 🟢/🟡 OAが見つかった場合は直接リンク(url)を返す
                if location.get("host_type") == "publisher":
                    return {"color": "green", "status": "Open Access (Publisher)", "url": location.get("url_for_pdf") or location.get("url"), "doi": doi, "abstract": abstract}
                else:
                    return {"color": "yellow", "status": "Green OA / Repository", "url": location.get("url_for_pdf") or location.get("url"), "doi": doi, "abstract": abstract}
                    
        # 🟠 OAではない場合（オレンジ判定）
        return generate_fallback("orange", query_title, "Paywall / Institutional Access", abstract, doi)
        
    except Exception as e:
        print(f"⚠️ 通信エラー: {e}")
        return generate_fallback("gray", query_title, "通信タイムアウト")

def generate_fallback(color: str, title: str, status_msg: str, abstract: str = "要約データなし", doi: str = None):
    """🟠オレンジと⚪グレーの時に、CiNiiとScholar両方のURLを生成する共通関数"""
    scholar_url = f"https://scholar.google.com/scholar?q={urllib.parse.quote(title)}"
    cinii_url = f"https://cir.nii.ac.jp/all?q={doi}" if doi else f"https://cir.nii.ac.jp/all?q={urllib.parse.quote(title)}"
    
    message = "無料の公式PDFは見つかりませんでした。" if color == "orange" else "情報の取得に失敗しました。"
    
    return {
        "color": color,
        "status": status_msg,
        "url": None, # 直接のPDFリンクはないためNone
        "scholar_url": scholar_url, # 野良PDF用
        "cinii_url": cinii_url,     # 図書館ルート用
        "doi": doi,
        "abstract": abstract,
        "message": f"{message} 以下のリンクから手動で検索してください。"
    }

# --- 実行テスト ---
if __name__ == "__main__":
    # テストA: OAの論文（今まで通り）
    res1 = check_paper_availability_keyless("Attention Is All You Need")
    print(f"\n[Test A] OA論文: {res1['color']} | URL: {res1.get('url')}")
    
    # テストB: わざとエラーを起こすか、有料論文を探す想定（オレンジ/グレーの挙動確認）
    res2 = check_paper_availability_keyless("ThisIsAFakePaperTitleThatDoesNotExist2026")
    print(f"\n[Test B] 不明な論文: {res2['color']} | {res2['status']}")
    print(f"  -> Scholarリンク: {res2.get('scholar_url')}")
    print(f"  -> CiNiiリンク:   {res2.get('cinii_url')}")