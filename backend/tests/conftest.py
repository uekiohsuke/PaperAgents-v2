import os
import tempfile

# 開発者がUIで保存したモデル設定を読まないよう、agent を import する前に保存先をテスト用に差し替える
os.environ["PAPER_AGENT_SETTINGS_PATH"] = os.path.join(tempfile.mkdtemp(), "llm_settings.json")

import fitz
import pytest
from typing import Any, List, Optional
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult


# ==========================================
# LLMのモック（応答を順番に返し、受け取ったメッセージを記録する）
# ==========================================
class RecordingFakeLLM(BaseChatModel):
    responses: List[str]
    calls: List[List[BaseMessage]] = []
    index: int = 0
    finish_reason: Optional[str] = None  # "length" で出力上限による打ち切りを再現する

    @property
    def _llm_type(self) -> str:
        return "recording-fake"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs: Any) -> ChatResult:
        self.calls.append(list(messages))
        text = self.responses[min(self.index, len(self.responses) - 1)]
        self.index += 1
        metadata = {"finish_reason": self.finish_reason} if self.finish_reason else {}
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=text, response_metadata=metadata))])

    def all_text(self, call_index: int = -1) -> str:
        """指定した呼び出しで渡された全メッセージの本文を連結して返す"""
        parts = []
        for m in self.calls[call_index]:
            if isinstance(m.content, str):
                parts.append(m.content)
            else:
                parts.extend(c.get("text", "") for c in m.content if isinstance(c, dict))
        return "\n".join(parts)


@pytest.fixture
def fake_llm(monkeypatch):
    """fake_llm(module, *responses) でそのモジュールの llm を差し替える"""
    def _install(module, *responses, attr="llm", finish_reason=None):
        llm = RecordingFakeLLM(responses=list(responses), calls=[], finish_reason=finish_reason)
        monkeypatch.setattr(module, attr, llm)
        return llm
    return _install


# ==========================================
# テスト用PDFの生成
# ==========================================
@pytest.fixture
def make_pdf(tmp_path):
    """各要素が1ページ分のテキスト（行のリスト）であるPDFを作る"""
    def _make(pages: List[List[str]], name="paper.pdf", toc=None):
        doc = fitz.open()
        for lines in pages:
            page = doc.new_page()
            y = 72
            for line in lines:
                page.insert_text((72, y), line, fontsize=10)
                y += 14
        if toc:
            doc.set_toc(toc)
        path = tmp_path / name
        doc.save(path)
        doc.close()
        return str(path)
    return _make


@pytest.fixture
def no_vectorstore(monkeypatch):
    """Embedding APIに依存しないよう、ベクトルDB構築を無効化する"""
    import pdf_parser
    monkeypatch.setattr(pdf_parser.PaperParser, "_build_vectorstore", lambda self: None)
