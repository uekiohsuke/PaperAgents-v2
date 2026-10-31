import pytest
import citation_agent


class FakeResponse:
    def __init__(self, status_code=200, data=None):
        self.status_code = status_code
        self._data = data or {}

    def json(self):
        return self._data


@pytest.fixture
def fake_http(monkeypatch):
    """URLの部分文字列 → FakeResponse の対応で requests.get を差し替える"""
    citation_agent.check_paper_availability_keyless.cache_clear()
    calls = []

    def _install(routes):
        def fake_get(url, timeout=None):
            calls.append(url)
            for key, resp in routes.items():
                if key in url:
                    if isinstance(resp, Exception):
                        raise resp
                    return resp
            return FakeResponse(404)
        monkeypatch.setattr(citation_agent.requests, "get", fake_get)
        return calls
    yield _install
    citation_agent.check_paper_availability_keyless.cache_clear()


def crossref(doi="10.1/abc", abstract="<jats:p>Abs</jats:p>"):
    return FakeResponse(200, {"message": {"items": [{"DOI": doi, "abstract": abstract}]}})


# ==========================================
# OA判定（Crossref + Unpaywall）
# ==========================================
def test_publisher_oa_is_green(fake_http):
    fake_http({"crossref": crossref(), "unpaywall": FakeResponse(200, {
        "is_oa": True, "best_oa_location": {"host_type": "publisher", "url_for_pdf": "http://pdf"}})})
    r = citation_agent.check_paper_availability_keyless("Title", "Author")
    assert (r["color"], r["url"], r["doi"], r["abstract"]) == ("green", "http://pdf", "10.1/abc", "Abs")


def test_repository_oa_is_yellow(fake_http):
    fake_http({"crossref": crossref(), "unpaywall": FakeResponse(200, {
        "is_oa": True, "best_oa_location": {"host_type": "repository", "url": "http://repo"}})})
    r = citation_agent.check_paper_availability_keyless("Title")
    assert (r["color"], r["url"]) == ("yellow", "http://repo")


def test_paywalled_is_orange_with_search_links(fake_http):
    fake_http({"crossref": crossref(), "unpaywall": FakeResponse(200, {"is_oa": False})})
    r = citation_agent.check_paper_availability_keyless("Some Title")
    assert r["color"] == "orange"
    assert r["url"] is None
    assert "scholar.google.com" in r["scholar_url"] and "Some%20Title" in r["scholar_url"]
    assert r["cinii_url"].endswith("10.1/abc")


@pytest.mark.parametrize("routes,status", [
    ({"crossref": FakeResponse(500)}, "Crossref APIエラー"),
    ({"crossref": FakeResponse(200, {"message": {"items": []}})}, "論文が見つかりませんでした"),
    ({"crossref": FakeResponse(200, {"message": {"items": [{"abstract": None}]}})}, "DOI取得失敗"),
    ({"crossref": TimeoutError("t")}, "通信タイムアウト"),
])
def test_failures_are_gray(fake_http, routes, status):
    fake_http(routes)
    r = citation_agent.check_paper_availability_keyless("T")
    assert (r["color"], r["status"]) == ("gray", status)


def test_authors_added_to_query(fake_http):
    calls = fake_http({"crossref": FakeResponse(500)})
    citation_agent.check_paper_availability_keyless("T", "A. Einstein")
    assert "query.author=A.%20Einstein" in calls[0]


def test_results_are_cached(fake_http):
    calls = fake_http({"crossref": FakeResponse(500)})
    citation_agent.check_paper_availability_keyless("Same")
    citation_agent.check_paper_availability_keyless("Same")
    assert len(calls) == 1


# ==========================================
# /api/check_oa 用の関数
# ==========================================
def test_oa_status_website(fake_llm, fake_http):
    calls = fake_http({})
    fake_llm(citation_agent, '{"title": "Docs", "authors": "", "type": "website", "url": "https://x"}')
    r = citation_agent.get_oa_status_from_text("Docs, https://x")
    assert r == {"color": "blue", "status": "Web Article", "title": "Docs", "url": "https://x"}
    assert calls == []


def test_oa_status_paper(fake_llm, fake_http):
    fake_http({"crossref": FakeResponse(500)})
    fake_llm(citation_agent, '{"title": "Paper", "authors": "X", "type": "paper", "url": null}')
    r = citation_agent.get_oa_status_from_text("X, Paper, 2001")
    assert r["color"] == "gray" and r["title"] == "Paper"


def test_oa_status_extraction_error(fake_llm):
    fake_llm(citation_agent, "not json")
    assert citation_agent.get_oa_status_from_text("x")["status"] == "Error"


@pytest.mark.xfail(reason="lru_cache が返す dict を呼び出し側が書き換えるため、キャッシュ値が汚染される", strict=True)
def test_cached_result_not_mutated(fake_llm, fake_http):
    fake_http({"crossref": FakeResponse(500)})
    fake_llm(citation_agent, '{"title": "Paper", "authors": "", "type": "paper", "url": null}')
    citation_agent.get_oa_status_from_text("raw")
    assert "title" not in citation_agent.check_paper_availability_keyless("Paper", "")


# ==========================================
# Citation Agent ノード
# ==========================================
def test_citation_node_resolves_reference_number(fake_llm, fake_http):
    fake_http({"crossref": FakeResponse(500)})
    llm = fake_llm(citation_agent,
                   '{"title": "Brownian", "authors": "Perrin", "type": "paper", "url": null}',
                   "  関連性の解説  ")
    out = citation_agent.citation_agent_node({
        "raw_text": "as shown in [2]", "selected_citation": "[2]", "current_context": "ctx",
        "references_dict": {"[2]": "J. Perrin, Brownian movement, 1909."},
    })
    assert "Perrin, Brownian movement" in llm.all_text(0)
    assert out["relevance_explanation"] == "関連性の解説"
    assert out["paper_info"]["title"] == "Brownian"


def test_citation_node_website_skips_api(fake_llm, fake_http):
    calls = fake_http({})
    fake_llm(citation_agent, '{"title": "Docs", "authors": "", "type": "website", "url": "https://d"}', "解説")
    out = citation_agent.citation_agent_node({"raw_text": "https://d", "selected_citation": "", "current_context": ""})
    assert out["paper_info"]["color"] == "blue"
    assert calls == []


@pytest.mark.xfail(reason="抽出失敗時のフォールバックが raw_text を使うため、画像経由(raw_text=None)だと quote(None) で落ちる", strict=True)
def test_citation_node_extraction_failure_from_image(fake_llm, fake_http):
    fake_http({"crossref": FakeResponse(500)})
    fake_llm(citation_agent, "not json", "解説")
    citation_agent.citation_agent_node({"raw_text": None, "extracted_text": "Perrin 1909",
                                        "selected_citation": "", "current_context": ""})
