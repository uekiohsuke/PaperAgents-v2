import json
import os
import weakref
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from openai import OpenAI

load_dotenv()

# ==========================================
# LLMの接続設定とモデル選択
# モデルと出力上限はUIから実行中に切り替えられ、llm_settings.json に保存される
# ==========================================
SETTINGS_PATH = os.environ.get("PAPER_AGENT_SETTINGS_PATH") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "llm_settings.json")
DEFAULT_MAX_TOKENS = 4096  # 出力が暴走してローカルLLMを長時間占有しないための上限


def _connection() -> dict:
    return {
        "base_url": os.environ.get("LOCAL_OPENAI_BASE_URL", "http://127.0.0.1:1234/v1"),
        "api_key": os.environ.get("LOCAL_OPENAI_API_KEY") or "dummy",  # 空文字は新しい openai が拒否する
    }


def _defaults() -> dict:
    return {
        "model": os.environ.get("LOCAL_OPENAI_MODEL_NAME", "qwen3:14b"),
        "vision_model": os.environ.get("LOCAL_OPENAI_VISION_MODEL_NAME", ""),  # 空なら通常のモデルを使う
        "max_tokens": int(os.environ.get("LOCAL_OPENAI_MAX_TOKENS") or DEFAULT_MAX_TOKENS),
    }


def _validate(changes: dict) -> dict:
    valid = {}
    for key in ("model", "vision_model"):
        if key in changes:
            value = (changes[key] or "").strip()
            if key == "model" and not value:
                raise ValueError("model は空にできません。")
            valid[key] = value
    if "max_tokens" in changes:
        max_tokens = int(changes["max_tokens"])
        if not 1 <= max_tokens <= 131072:
            raise ValueError("max_tokens は 1〜131072 で指定してください。")
        valid["max_tokens"] = max_tokens
    return valid


def _load() -> dict:
    settings = _defaults()
    try:
        with open(SETTINGS_PATH, encoding="utf-8") as f:
            settings.update(_validate(json.load(f)))
    except FileNotFoundError:
        pass
    except (ValueError, TypeError) as e:
        print(f"⚠️ {SETTINGS_PATH} を読めないため、.env の設定を使います: {e}")
    return settings


_settings = _load()
_llms = []  # (ChatOpenAIへの弱参照, Vision用か)。設定変更時にまとめて更新する


def _model_for(vision: bool) -> str:
    return (_settings["vision_model"] or _settings["model"]) if vision else _settings["model"]


def _max_tokens_body() -> dict:
    # ChatOpenAI の max_tokens は max_completion_tokens として送られるが、Ollama はこれを無視するため、
    # 互換サーバーが広く解釈する max_tokens をリクエスト本文に直接載せる
    return {"max_tokens": _settings["max_tokens"]}


def make_llm(temperature: float, vision: bool = False) -> ChatOpenAI:
    llm = ChatOpenAI(
        **_connection(),
        model=_model_for(vision),
        temperature=temperature,
        extra_body=_max_tokens_body(),
    )
    _llms.append((weakref.ref(llm), vision))
    return llm


def get_settings() -> dict:
    return {**_settings, "effective_vision_model": _model_for(True)}


def update_settings(changes: dict) -> dict:
    _settings.update(_validate(changes))
    # model と max_tokens はリクエストごとに送られるだけなので、既存のインスタンスを書き換えれば反映される
    for ref, vision in _llms:
        llm = ref()
        if llm is not None:
            llm.model_name = _model_for(vision)
            llm.extra_body = _max_tokens_body()
    with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
        json.dump(_settings, f, ensure_ascii=False, indent=2)
    return get_settings()


def list_models() -> list:
    """接続先のOpenAI互換APIが提供するモデルIDの一覧"""
    client = OpenAI(**_connection(), timeout=5)
    return sorted(model.id for model in client.models.list())


def truncation_notice(response) -> str:
    """出力上限で打ち切られた応答なら、回答の末尾に付ける注意書きを返す（打ち切られていなければ空文字）"""
    if response.response_metadata.get("finish_reason") != "length":
        return ""
    return (f"\n\n> ⚠️ 最大出力トークン数（{_settings['max_tokens']}）に達したため、回答が途中で切れています。"
            "ヘッダーの ⚙️ モデル設定で上限を増やせます。")
