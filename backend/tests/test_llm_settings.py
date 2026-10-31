import json
import pytest
import llm_settings
import chart_agent
import ocr_agent
import qa_agent


@pytest.fixture
def settings(monkeypatch, tmp_path):
    """保存先を一時ファイルにし、テスト後に設定を元へ戻す"""
    path = tmp_path / "llm_settings.json"
    monkeypatch.setattr(llm_settings, "SETTINGS_PATH", str(path))
    original = llm_settings.get_settings()
    yield path
    llm_settings._settings.update({k: original[k] for k in ("model", "vision_model", "max_tokens")})
    for ref, vision in llm_settings._llms:
        llm = ref()
        if llm is not None:
            llm.model_name = llm_settings._model_for(vision)
            llm.extra_body = llm_settings._max_tokens_body()


def test_defaults_from_env(monkeypatch):
    monkeypatch.setenv("LOCAL_OPENAI_MODEL_NAME", "text-model")
    monkeypatch.delenv("LOCAL_OPENAI_VISION_MODEL_NAME", raising=False)
    monkeypatch.delenv("LOCAL_OPENAI_MAX_TOKENS", raising=False)
    assert llm_settings._defaults() == {"model": "text-model", "vision_model": "", "max_tokens": 4096}


def test_empty_api_key_falls_back_to_dummy(monkeypatch):
    """新しい openai は api_key="" を拒否するため、未設定・空文字でもダミー値で起動できること"""
    monkeypatch.setenv("LOCAL_OPENAI_API_KEY", "")
    assert llm_settings.make_llm(temperature=0).openai_api_key.get_secret_value() == "dummy"


def request_payload(llm):
    return llm._get_request_payload([("human", "x")])


def test_agents_send_max_tokens():
    for llm in (qa_agent.llm, chart_agent.llm, ocr_agent.vlm):
        payload = request_payload(llm)
        # Ollama は max_completion_tokens を無視するため、max_tokens として送る
        assert payload["extra_body"] == {"max_tokens": llm_settings.get_settings()["max_tokens"]}
        assert "max_completion_tokens" not in payload


def test_update_applies_to_existing_agents_and_is_saved(settings):
    llm_settings.update_settings({"model": "new-text", "vision_model": "", "max_tokens": 512})
    payload = request_payload(qa_agent.llm)
    assert (payload["model"], payload["extra_body"]["max_tokens"]) == ("new-text", 512)
    # Vision用モデルが空なら通常のモデルを使う
    assert chart_agent.llm.model_name == ocr_agent.vlm.model_name == "new-text"

    llm_settings.update_settings({"vision_model": "vl"})
    assert (qa_agent.llm.model_name, chart_agent.llm.model_name, ocr_agent.vlm.model_name) == ("new-text", "vl", "vl")
    assert json.loads(settings.read_text()) == {"model": "new-text", "vision_model": "vl", "max_tokens": 512}


def test_saved_settings_override_env(settings, monkeypatch):
    monkeypatch.setenv("LOCAL_OPENAI_MODEL_NAME", "env-model")
    settings.write_text(json.dumps({"model": "saved-model", "max_tokens": 1000}))
    assert llm_settings._load() == {"model": "saved-model", "vision_model": "", "max_tokens": 1000}
    settings.write_text("{broken")
    assert llm_settings._load()["model"] == "env-model"


@pytest.mark.parametrize("changes", [{"model": " "}, {"max_tokens": 0}, {"max_tokens": 10**7}])
def test_invalid_settings_are_rejected(settings, changes):
    before = llm_settings.get_settings()
    with pytest.raises(ValueError):
        llm_settings.update_settings(changes)
    assert llm_settings.get_settings() == before
