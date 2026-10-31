import os
from typing import Dict, Any
from langchain_core.messages import HumanMessage
from langchain_openai import ChatOpenAI
from dotenv import load_dotenv

load_dotenv()

vlm = ChatOpenAI(
    base_url=os.environ.get("LOCAL_OPENAI_BASE_URL", "http://127.0.0.1:1234/v1"),
    api_key=os.environ.get("LOCAL_OPENAI_API_KEY") or "dummy",  # 空文字は新しい openai が拒否する
    # Vision用モデルが未設定なら通常のモデルを使う
    model=os.environ.get("LOCAL_OPENAI_VISION_MODEL_NAME") or os.environ.get("LOCAL_OPENAI_MODEL_NAME", "qwen3:14b"),
    temperature=0.0, # 抽出タスクは完全にゼロでOK
)

def ocr_agent_node(state: Dict[str, Any]) -> Dict[str, Any]:
    print("\n📷 [OCR Agent] 画像入力を検知。Markdown + LaTeX形式への変換を開始します...")
    
    raw_image = state.get("raw_image")
    
    if not raw_image:
        return {"extracted_text": "エラー: 画像データがありません"}

    image_url = raw_image if raw_image.startswith("data:image") else f"data:image/png;base64,{raw_image}"

    # 🌟 変更: 全インテント共通の、最強の文字起こしプロンプト
    prompt_text = """
    提供された画像の内容を正確にテキスト化してください。
    学術論文の一部であるため、以下のルールに厳密に従ってください：

    1. 通常の文章は、見たまま正確に抽出すること。
    2. 数式が含まれている場合は必ずLaTeX形式で記述し、文章中のインライン数式は $...$ 、独立したディスプレイ数式は $$...$$ で囲むこと。
    3. 引用番号（例: [1], [12-15] など）や図表の参照も、省略せずにそのまま残すこと。
    4. 挨拶や「画像には〜と書かれています」といった余分な説明は一切不要です。抽出したマークダウンテキストのみを直接出力してください。
    """

    message = HumanMessage(
        content=[
            {"type": "text", "text": prompt_text},
            {"type": "image_url", "image_url": {"url": image_url}}
        ]
    )

    try:
        response = vlm.invoke([message])
        extracted_text = response.content.strip()
        print(f"✨ [OCR Agent] 抽出完了:\n{extracted_text}")
        
    except Exception as e:
        print(f"⚠️ [OCR Agent] 画像解析エラー: {e}")
        extracted_text = f"画像解析エラー: {e}"

    return {"extracted_text": extracted_text}