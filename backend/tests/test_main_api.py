import json
import os
import sys
import pytest
from fastapi.testclient import TestClient
import main


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(main.asyncio, "sleep", _no_sleep)  # 1文字ごとの待機を省略
    monkeypatch.setattr(main, "pdf_parsers", {})
    monkeypatch.setattr(main, "last_pdf_id", None)
    return TestClient(main.app)


async def _no_sleep(_):
    return None


@pytest.fixture
def graph_spy(monkeypatch):
    """app_graph.invoke を差し替え、受け取ったStateを記録して固定の結果を返す"""
    seen = {}

    def install(result):
        def fake_invoke(state):
            seen["state"] = state
            return result
        monkeypatch.setattr(main.app_graph, "invoke", fake_invoke)
        return seen
    return install


def read_sse(resp):
    events = [json.loads(line[6:]) for line in resp.text.splitlines() if line.startswith("data: ")]
    text = "".join(e.get("chunk", "") for e in events)
    return events, text


def agent_request(task_type, **payload):
    return {"task_type": task_type, "context": {"current_context": "front ctx"}, "payload": payload}


@pytest.mark.parametrize("task_type,key", [
    ("qa", "qa_answer"), ("library", "qa_answer"), ("chart", "qa_answer"),
    ("math", "math_result"), ("citation", "relevance_explanation"), ("code", "code_result"),
])
def test_agent_streams_result_for_each_task(client, graph_spy, task_type, key):
    graph_spy({key: "答え", "dict_suggestions": '{"terms": []}'})
    resp = client.post("/api/agent", json=agent_request(task_type, selected_text="sel"))
    events, text = read_sse(resp)
    assert resp.status_code == 200
    assert events[0]["status"] == "info"
    assert text == "答え"
    assert events[-1] == {"done": True, "dict_suggestions": '{"terms": []}'}


def test_agent_builds_state_from_request(client, graph_spy):
    seen = graph_spy({"qa_answer": ""})
    client.post("/api/agent", json={
        **agent_request("qa", selected_text="sel", user_intent="explain"),
        "chat_history": [{"role": "user", "content": "q"}],
    })
    s = seen["state"]
    assert s["intent"] == "qa" and s["raw_text"] == "sel" and s["raw_image"] is None
    assert s["current_context"] == "front ctx"
    assert s["chat_history"] == [{"role": "user", "content": "q"}]
    assert s["references_dict"] == {}


def test_agent_uses_backend_context_when_pdf_loaded(client, graph_spy, monkeypatch):
    class P:
        references = {"[1]": "ref"}
        def get_context_around(self, text, window_size):
            return f"...wide {text} context..."
    monkeypatch.setattr(main, "pdf_parsers", {"a.pdf": P()})
    monkeypatch.setattr(main, "last_pdf_id", "a.pdf")
    seen = graph_spy({"qa_answer": ""})
    client.post("/api/agent", json=agent_request("qa", selected_text="sel"))
    assert seen["state"]["current_context"] == "...wide sel context..."
    assert seen["state"]["references_dict"] == {"[1]": "ref"}


def test_agent_rejects_unknown_task(client):
    assert client.post("/api/agent", json=agent_request("nope")).status_code == 422


def test_library_rag_query_is_user_question(client, graph_spy, monkeypatch):
    queries = []

    class P:
        vectorstore = object()
        references = {}
        def search_with_scores(self, q, k):
            queries.append(q)
            return []
    monkeypatch.setattr(main, "pdf_parsers", {"a.pdf": P()})
    graph_spy({"qa_answer": ""})
    # App.tsx の handleGlobalChat と同じペイロード
    client.post("/api/agent", json=agent_request("library", selected_text="粘度は？",
                                                 user_intent="粘度は？", action_type="library"))
    assert queries == ["粘度は？"]


def test_agent_error_is_reported_in_stream(client, monkeypatch):
    def boom(state):
        raise RuntimeError("LLM down")
    monkeypatch.setattr(main.app_graph, "invoke", boom)
    resp = client.post("/api/agent", json=agent_request("qa", selected_text="s"))
    events, _ = read_sse(resp)
    assert events[-1]["status"] == "error" and "LLM down" in events[-1]["message"]


def test_summarize_thread(client, graph_spy):
    seen = graph_spy({"qa_answer": "まとめ"})
    resp = client.post("/api/summarize_thread", json={"messages": [{"role": "user", "content": "x"}]})
    assert resp.json() == {"summary": "まとめ"}
    assert seen["state"]["intent"] == "thread_summary"


def test_summarize_thread_error(client, monkeypatch):
    monkeypatch.setattr(main.app_graph, "invoke", lambda s: (_ for _ in ()).throw(RuntimeError("x")))
    assert "要約エラー" in client.post("/api/summarize_thread", json={"messages": []}).json()["summary"]


def test_pdf_info_without_upload(client):
    assert client.get("/api/pdf_info").json() == {"toc": [], "references": {}, "citation_pages": {}}


def test_upload_parses_pdf(client, make_pdf, no_vectorstore, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    path = make_pdf([["1 Intro", "see [1]"], ["References", "[1] A. B, Title, 2000."]], name="src.pdf")
    with open(path, "rb") as f:
        resp = client.post("/api/upload", files={"file": ("paper.pdf", f, "application/pdf")})
    body = resp.json()
    assert body["message"] == "success"
    assert body["references"] == {"[1]": "A. B, Title, 2000."}
    assert body["pdf_id"] == "paper.pdf"
    assert (tmp_path / "uploads" / "paper.pdf").exists()
    assert client.get("/api/pdf_info").json()["references"] == body["references"]


def upload(client, path, filename):
    with open(path, "rb") as f:
        return client.post("/api/upload", files={"file": (filename, f, "application/pdf")})


def test_multiple_pdfs_are_kept_separately(client, make_pdf, no_vectorstore, graph_spy, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    upload(client, make_pdf([["alpha body [1]"], ["References", "[1] Alpha ref, 2001."]], name="a_src.pdf"), "a.pdf")
    upload(client, make_pdf([["beta body [1]"], ["References", "[1] Beta ref, 2002."]], name="b_src.pdf"), "b.pdf")

    assert client.get("/api/pdf_info", params={"pdf_id": "a.pdf"}).json()["references"] == {"[1]": "Alpha ref, 2001."}
    assert client.get("/api/pdf_info", params={"pdf_id": "b.pdf"}).json()["references"] == {"[1]": "Beta ref, 2002."}
    assert client.get("/api/pdf_info", params={"pdf_id": "missing.pdf"}).status_code == 404

    # pdf_id を指定すると、最後にアップロードした b.pdf ではなく a.pdf の文脈・参考文献を使う
    seen = graph_spy({"qa_answer": ""})
    req = agent_request("qa", selected_text="alpha body")
    req["context"]["pdf_id"] = "a.pdf"
    client.post("/api/agent", json=req)
    assert seen["state"]["references_dict"] == {"[1]": "Alpha ref, 2001."}
    assert "alpha body" in seen["state"]["current_context"]

    # 未指定なら最後にアップロードしたPDF
    client.post("/api/agent", json=agent_request("qa", selected_text="beta body"))
    assert seen["state"]["references_dict"] == {"[1]": "Beta ref, 2002."}


def test_library_search_spans_all_pdfs(client, make_pdf, graph_spy, tmp_path, monkeypatch):
    import pdf_parser
    from langchain_core.embeddings import DeterministicFakeEmbedding
    monkeypatch.setattr(pdf_parser, "create_embeddings", lambda: DeterministicFakeEmbedding(size=16))
    monkeypatch.chdir(tmp_path)
    upload(client, make_pdf([["colloid viscosity"]], name="a_src.pdf"), "a.pdf")
    upload(client, make_pdf([["quantum spin"]], name="b_src.pdf"), "b.pdf")
    seen = graph_spy({"qa_answer": ""})
    client.post("/api/agent", json=agent_request("library", user_intent="colloid viscosity", action_type="library"))
    ctx = seen["state"]["current_context"]
    assert "[参照元: a.pdf p.1]" in ctx and "[参照元: b.pdf p.1]" in ctx
    assert ctx.index("a.pdf") < ctx.index("b.pdf")  # 完全一致する a.pdf が先


@pytest.mark.parametrize("filename", ["../evil.pdf", "..\\evil.pdf", "sub/../../evil.pdf"])
def test_upload_strips_directories_from_filename(client, make_pdf, no_vectorstore, tmp_path, monkeypatch, filename):
    monkeypatch.chdir(tmp_path)
    resp = upload(client, make_pdf([["x"]], name="src.pdf"), filename)
    assert resp.json()["pdf_id"] == "evil.pdf"
    assert (tmp_path / "uploads" / "evil.pdf").exists()
    assert not (tmp_path / "evil.pdf").exists()


def test_upload_rejects_empty_filename(client, make_pdf, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert upload(client, make_pdf([["x"]], name="src.pdf"), "..").status_code == 400


def test_check_oa_delegates(client, monkeypatch):
    monkeypatch.setattr(main, "get_oa_status_from_text", lambda t: {"color": "blue", "raw": t})
    assert client.post("/api/check_oa", json={"raw_citation": "abc"}).json() == {"color": "blue", "raw": "abc"}


# ==========================================
# /api/run_preview（実際にサブプロセスを起動する）
# ==========================================
@pytest.fixture
def preview_env(tmp_path, monkeypatch):
    """venvを有効化したシェルと同じく、PATHの先頭を現在のPythonにする"""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PATH", os.path.dirname(sys.executable) + os.pathsep + os.environ["PATH"])
    return tmp_path


def test_run_preview_text_output(client, preview_env):
    r = client.post("/api/run_preview", json={"code": "print(1 + 1)"}).json()
    assert r == {"status": "success", "output": "2\n"}
    assert not (preview_env / "temp_sim.py").exists()


def test_run_preview_image_output(client, preview_env):
    code = "import matplotlib.pyplot as plt\nplt.plot([0, 1])\nplt.show()"
    r = client.post("/api/run_preview", json={"code": code}).json()
    assert r["status"] == "success" and r["image"].startswith("data:image/png;base64,")
    assert not (preview_env / "temp_preview.png").exists()


def test_run_preview_error(client, preview_env):
    r = client.post("/api/run_preview", json={"code": "raise SystemExit('bad')"}).json()
    assert r["status"] == "error" and "bad" in r["error"]


def test_run_preview_uses_server_python(client, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    r = client.post("/api/run_preview", json={"code": "import sys; print(sys.executable)"}).json()
    assert r.get("output", "").strip() == sys.executable


def test_run_preview_timeout_kills_process(client, preview_env, monkeypatch):
    monkeypatch.setattr(main, "PREVIEW_TIMEOUT", 1.0)
    pid_file = preview_env / "pid"
    code = f"import os, time\nopen({str(pid_file)!r}, 'w').write(str(os.getpid()))\ntime.sleep(30)"
    r = client.post("/api/run_preview", json={"code": code}).json()
    assert r["status"] == "error" and "タイムアウト" in r["error"]
    pid = int(pid_file.read_text())
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)


def test_run_preview_concurrent_requests_do_not_collide(preview_env):
    import asyncio
    import httpx

    async def run_both():
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            codes = [f"import time\ntime.sleep(0.5)\nprint({i})" for i in range(2)]
            return await asyncio.gather(*[ac.post("/api/run_preview", json={"code": c}) for c in codes])

    results = [r.json() for r in asyncio.run(run_both())]
    assert results == [{"status": "success", "output": "0\n"}, {"status": "success", "output": "1\n"}]


# ==========================================
# モデル設定
# ==========================================
def test_settings_api(client, monkeypatch, tmp_path):
    import llm_settings
    monkeypatch.setattr(llm_settings, "SETTINGS_PATH", str(tmp_path / "s.json"))
    monkeypatch.setattr(llm_settings, "_settings", {"model": "m", "vision_model": "", "max_tokens": 4096})
    monkeypatch.setattr(llm_settings, "_llms", [])
    assert client.get("/api/settings").json() == {"model": "m", "vision_model": "", "max_tokens": 4096,
                                                  "effective_vision_model": "m"}
    r = client.put("/api/settings", json={"vision_model": "vl", "max_tokens": 256}).json()
    assert (r["model"], r["vision_model"], r["max_tokens"], r["effective_vision_model"]) == ("m", "vl", 256, "vl")
    assert client.put("/api/settings", json={"max_tokens": 0}).status_code == 400


def test_models_api(client, monkeypatch):
    import llm_settings
    monkeypatch.setattr(llm_settings, "list_models", lambda: ["a", "b"])
    assert client.get("/api/models").json() == {"models": ["a", "b"]}

    def down():
        raise ConnectionError("refused")
    monkeypatch.setattr(llm_settings, "list_models", down)
    body = client.get("/api/models").json()
    assert body["models"] == [] and "refused" in body["error"]
