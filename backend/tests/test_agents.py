import qa_agent
import math_agent
import chart_agent
import library_agent
from qa_agent import format_history_to_messages
from langchain_core.messages import HumanMessage, AIMessage


# ==========================================
# QA Agent
# ==========================================
def test_format_history_keeps_recent_turns():
    history = [{"role": "user" if i % 2 == 0 else "ai", "content": str(i)} for i in range(14)]
    msgs = format_history_to_messages(history, max_turns=5)
    assert len(msgs) == 10
    assert msgs[0].content == "4"
    assert isinstance(msgs[0], HumanMessage) and isinstance(msgs[1], AIMessage)
    assert format_history_to_messages([]) == []


def test_qa_splits_answer_and_dict(fake_llm):
    fake_llm(qa_agent, '[回答]\n本文\n\n[辞書データ]\n{"terms": [{"term": "a", "description": "b"}]}')
    out = qa_agent.qa_agent_node({"user_intent": "explain", "raw_text": "sel", "current_context": "ctx"})
    assert out["qa_answer"] == "本文"
    assert '"terms"' in out["dict_suggestions"]


def test_qa_without_dict_section_falls_back(fake_llm):
    fake_llm(qa_agent, "区切りのない回答")
    out = qa_agent.qa_agent_node({"user_intent": "explain", "raw_text": "sel"})
    assert out["qa_answer"] == "区切りのない回答"
    assert out["dict_suggestions"] == "[]"


def test_qa_preset_intent_is_expanded(fake_llm):
    llm = fake_llm(qa_agent, "[回答]\nx\n[辞書データ]\n{}")
    qa_agent.qa_agent_node({"user_intent": "summarize", "raw_text": "sel"})
    assert qa_agent.INTENT_INSTRUCTIONS["summarize"] in llm.all_text()


def test_qa_free_text_and_history_passed(fake_llm):
    llm = fake_llm(qa_agent, "[回答]\nx\n[辞書データ]\n{}")
    qa_agent.qa_agent_node({"user_intent": "この式の意味は？", "raw_text": "",
                            "chat_history": [{"role": "user", "content": "前の質問"}]})
    text = llm.all_text()
    assert "この式の意味は？" in text and "前の質問" in text


def test_qa_translate_mode(fake_llm):
    fake_llm(qa_agent, '[回答]\n翻訳文\n[辞書データ]\n{"terms": []}')
    out = qa_agent.qa_agent_node({"user_intent": "translate", "raw_text": "Hello"})
    assert out == {"qa_answer": "翻訳文", "dict_suggestions": '{"terms": []}'}


def test_qa_thread_summary_mode(fake_llm):
    llm = fake_llm(qa_agent, "  要約  ")
    out = qa_agent.qa_agent_node({"user_intent": "thread_summary",
                                  "chat_history": [{"role": "user", "content": "量子とは"}]})
    assert out["qa_answer"] == "要約"
    assert "量子とは" in llm.all_text()


def test_qa_extra_dict_marker_breaks_split(fake_llm):
    # "[辞書データ]" が2回出ると split が3要素になり ValueError → 全文が回答扱いになる
    raw = "[回答]\n[辞書データ]という語\n[辞書データ]\n{}"
    fake_llm(qa_agent, raw)
    assert qa_agent.qa_agent_node({"user_intent": "explain", "raw_text": "s"})["qa_answer"] == raw


# ==========================================
# Math Agent
# ==========================================
def test_math_derivation_vs_explain_prompt(fake_llm):
    llm = fake_llm(math_agent, '{"extracted_content": "x", "variables": [{"symbol": "x"}]}', "導出")
    out = math_agent.math_agent_node({"action_type": "derivation", "raw_text": "x^2"})
    assert out["math_result"] == "導出"
    assert "導出過程" in llm.all_text(-1)

    llm = fake_llm(math_agent, '{"extracted_content": "x", "variables": []}', "意味")
    math_agent.math_agent_node({"action_type": "explain", "raw_text": "x^2"})
    assert "意味を解説" in llm.all_text(-1)


def test_math_variable_extraction_failure_is_tolerated(fake_llm):
    llm = fake_llm(math_agent, "JSONではない応答", "解説")
    out = math_agent.math_agent_node({"action_type": "explain", "raw_text": "x"})
    assert out["math_result"] == "解説"
    assert "抽出なし" in llm.all_text(-1)


# ==========================================
# Chart Agent
# ==========================================
def test_chart_with_image_uses_multimodal(fake_llm):
    llm = fake_llm(chart_agent, "図の解説")
    out = chart_agent.chart_agent_node({"action_type": "axes", "selected_image": "data:image/png;base64,xx"})
    assert out == {"qa_answer": "図の解説"}
    human = llm.calls[-1][1]
    assert any(c.get("type") == "image_url" for c in human.content)
    assert "X軸" in llm.calls[-1][0].content


def test_chart_llm_error_returns_message(monkeypatch):
    class Boom:
        def invoke(self, _):
            raise RuntimeError("down")
    monkeypatch.setattr(chart_agent, "llm", Boom())
    assert "down" in chart_agent.chart_agent_node({"action_type": "explain"})["qa_answer"]


# ==========================================
# Library Agent
# ==========================================
def test_library_formats_network_info(fake_llm):
    llm = fake_llm(library_agent, "回答 [node:ref1]")
    out = library_agent.library_agent_node({
        "raw_text": "粘度について",
        "current_context": "【RAG検索結果】...",
        "library_context": {"loaded_pdfs": ["sample.pdf"],
                            "unloaded_references": [{"id": "ref1", "title": "Colloids", "citations": 3}]},
    })
    assert out["qa_answer"] == "回答 [node:ref1]"
    text = llm.all_text()
    assert "粘度について" in text and "sample.pdf" in text and "Colloids" in text
