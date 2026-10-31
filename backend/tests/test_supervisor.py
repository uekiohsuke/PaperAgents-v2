import pytest
import supervisor
import code_agent
import math_agent
import ocr_agent
import qa_agent
from supervisor import route_task


def base_state(**overrides):
    """main.py の /api/agent が組み立てるStateと同じ形"""
    state = {
        "intent": "qa", "raw_image": None, "raw_text": None, "extracted_text": None,
        "current_context": "", "library_context": {}, "paper_metadata": "",
        "chat_history": [], "references_dict": {},
        "selected_text": "", "user_intent": "", "selected_tex": "", "selected_image": "",
        "action_type": "", "selected_citation": "", "target_reference_text": "", "code_result": "",
    }
    state.update(overrides)
    return state


@pytest.mark.parametrize("intent,node", [
    ("qa", "QANode"), ("thread_summary", "QANode"), ("math", "MathNode"),
    ("citation", "CitationNode"), ("chart", "ChartNode"), ("code", "CodeNode"),
    ("library", "LibraryNode"),
])
def test_route_by_intent(intent, node):
    assert route_task({"intent": intent}) == node


def test_route_image_goes_to_ocr_first():
    assert route_task({"intent": "math", "raw_image": "data:image/png;base64,xx"}) == "OCRNode"
    assert route_task({"intent": "math", "raw_image": "x", "extracted_text": "E=mc^2"}) == "MathNode"


def test_route_unknown_intent():
    with pytest.raises(ValueError):
        route_task({"intent": "unknown"})


def test_graph_ocr_then_math(fake_llm):
    fake_llm(ocr_agent, "$$E=mc^2$$", attr="vlm")
    math_llm = fake_llm(math_agent, '{"extracted_content": "E=mc^2", "variables": []}', "解説です")
    result = supervisor.app_graph.invoke(base_state(intent="math", raw_image="data:image/png;base64,xx"))
    assert result["extracted_text"] == "$$E=mc^2$$"
    assert result["math_result"] == "解説です"
    assert "E=mc^2" in math_llm.all_text(-1)


def test_graph_qa(fake_llm):
    fake_llm(qa_agent, '[回答]\nこたえ\n[辞書データ]\n{"terms": [], "variables": []}')
    result = supervisor.app_graph.invoke(base_state(intent="qa", raw_text="text", user_intent="explain"))
    assert result["qa_answer"] == "こたえ"


@pytest.mark.xfail(reason="OCRが空文字を返すと route_task が 'OCRNode' を返すが、OCRNode からの分岐先に存在しない", strict=True)
def test_graph_ocr_empty_result(fake_llm):
    fake_llm(ocr_agent, "", attr="vlm")
    fake_llm(qa_agent, "[回答]\nx\n[辞書データ]\n{}")
    supervisor.app_graph.invoke(base_state(intent="qa", raw_image="xx"))


@pytest.mark.xfail(reason="CodeState に chat_history が無いため、修正依頼時に前回のコードがLLMに渡らない", strict=True)
def test_code_fix_request_sees_previous_code(fake_llm):
    llm = fake_llm(code_agent, "```python\nprint(2)\n```")
    history = [{"role": "ai", "content": "```python\nprint('PREVIOUS_CODE')\n```"}]
    supervisor.app_graph.invoke(base_state(intent="code", user_intent="バグを直して", chat_history=history))
    assert "PREVIOUS_CODE" in llm.all_text()


@pytest.mark.xfail(reason="MathState に user_intent が無いため、Mathボタンの自由入力の質問がLLMに渡らない", strict=True)
def test_math_free_question_reaches_llm(fake_llm):
    llm = fake_llm(math_agent, '{"extracted_content": "", "variables": []}', "回答")
    supervisor.app_graph.invoke(base_state(intent="math", raw_text="E=mc^2",
                                           user_intent="なぜcの2乗なのか", action_type="なぜcの2乗なのか"))
    assert "なぜcの2乗なのか" in llm.all_text(-1)
