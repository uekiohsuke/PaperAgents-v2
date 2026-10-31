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


def test_route_chart_image_skips_ocr():
    assert route_task({"intent": "chart", "raw_image": "data:image/png;base64,xx"}) == "ChartNode"


def test_graph_chart_sends_image_without_ocr(fake_llm):
    import chart_agent
    ocr = fake_llm(ocr_agent, "OCR結果", attr="vlm")
    chart = fake_llm(chart_agent, "図の解説")
    result = supervisor.app_graph.invoke(base_state(intent="chart", raw_image="data:image/png;base64,xx",
                                                    selected_image="data:image/png;base64,xx", action_type="explain"))
    assert result["qa_answer"] == "図の解説"
    assert ocr.calls == []
    assert chart.calls[0][-1].content[1]["image_url"]["url"] == "data:image/png;base64,xx"


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


def test_graph_ocr_empty_result(fake_llm):
    fake_llm(ocr_agent, "", attr="vlm")
    fake_llm(qa_agent, "[回答]\nx\n[辞書データ]\n{}")
    result = supervisor.app_graph.invoke(base_state(intent="qa", raw_image="xx"))
    assert result["extracted_text"] == "" and result["qa_answer"] == "x"


def test_code_fix_request_sees_previous_code(fake_llm):
    llm = fake_llm(code_agent, "```python\nprint(2)\n```")
    history = [{"role": "ai", "content": "```python\nprint('PREVIOUS_CODE')\n```"}]
    supervisor.app_graph.invoke(base_state(intent="code", user_intent="バグを直して", chat_history=history))
    assert "PREVIOUS_CODE" in llm.all_text()


def test_math_free_question_reaches_llm(fake_llm):
    llm = fake_llm(math_agent, '{"extracted_content": "", "variables": []}', "回答")
    supervisor.app_graph.invoke(base_state(intent="math", raw_text="E=mc^2",
                                           user_intent="なぜcの2乗なのか", action_type="なぜcの2乗なのか"))
    assert "なぜcの2乗なのか" in llm.all_text(-1)


def test_math_preset_button_uses_preset_prompt(fake_llm):
    llm = fake_llm(math_agent, '{"extracted_content": "", "variables": []}', "回答")
    supervisor.app_graph.invoke(base_state(intent="math", raw_text="E=mc^2",
                                           user_intent="derivation", action_type="derivation"))
    assert "導出過程" in llm.all_text(-1) and "【ユーザーの質問】" not in llm.all_text(-1)


def test_math_selected_tex_and_history_reach_llm(fake_llm):
    llm = fake_llm(math_agent, '{"extracted_content": "", "variables": []}', "回答")
    history = [{"role": "user", "content": "PREVIOUS_QUESTION"}]
    supervisor.app_graph.invoke(base_state(intent="math", selected_tex="a^2+b^2=c^2",
                                           user_intent="explain", action_type="explain", chat_history=history))
    assert "a^2+b^2=c^2" in llm.all_text(-1) and "PREVIOUS_QUESTION" in llm.all_text(-1)


@pytest.mark.parametrize("node", [
    code_agent.code_agent_node, math_agent.math_agent_node, qa_agent.qa_agent_node,
    supervisor.chart_agent_node, supervisor.citation_agent_node,
])
def test_node_state_declares_every_key_it_reads(node):
    """LangGraphはノードの型注釈に宣言されたキーしか渡さないため、読むキーは全て宣言が必要"""
    import inspect, re, typing
    state_type = typing.get_type_hints(node)["state"]
    read_keys = set(re.findall(r'state(?:\.get\(|\[)"(\w+)"', inspect.getsource(node)))
    assert read_keys - set(state_type.__annotations__) == set()
