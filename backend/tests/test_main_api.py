import json
import os
import sys
import pytest
from fastapi.testclient import TestClient
import main


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(main.asyncio, "sleep", _no_sleep)  # 1文字ごとの待機を省略
    monkeypatch.setattr(main, "pdf_parser", None)
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
    monkeypatch.setattr(main, "pdf_parser", P())
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
        def similarity_search(self, q):
            queries.append(q)
            return "hit"
    monkeypatch.setattr(main, "pdf_parser", P())
    graph_spy({"qa_answer": ""})
    # App.tsx の handleGlobalChat と同じペイロード
    client.post("/api/agent", json=agent_request("library", selected_text="粘度は？",
                                                 user_intent="粘度は？", action_type="library"))
    assert queries == ["粘度は？"]


@pytest.mark.xfail(reason="グラフ実行中の例外がストリームを途中で切断し、フロントにエラーイベントが届かない", strict=True)
def test_agent_error_is_reported_in_stream(client, monkeypatch):
    def boom(state):
        raise RuntimeError("LLM down")
    monkeypatch.setattr(main.app_graph, "invoke", boom)
    resp = client.post("/api/agent", json=agent_request("qa", selected_text="s"))
    assert "LLM down" in resp.text


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
    assert (tmp_path / "uploads" / "paper.pdf").exists()
    assert client.get("/api/pdf_info").json()["references"] == body["references"]


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


@pytest.mark.xfail(reason="'python' をPATHから探すため、venv未有効化で起動するとvenv外のPythonで実行される（sys.executable を使うべき）", strict=True)
def test_run_preview_uses_server_python(client, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    r = client.post("/api/run_preview", json={"code": "import sys; print(sys.executable)"}).json()
    assert r.get("output", "").strip() == sys.executable
