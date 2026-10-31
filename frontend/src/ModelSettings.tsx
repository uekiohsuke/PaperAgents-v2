import { useState } from 'react';

const API = "http://127.0.0.1:8000";

type LLMSettings = {
  model: string;
  vision_model: string; // 空なら通常のモデルを使う
  max_tokens: number;
};

const labelStyle = { display: "block", fontSize: "0.75em", fontWeight: "600" as const, color: "var(--text-muted)", margin: "12px 0 4px" };
const inputStyle = { width: "100%", boxSizing: "border-box" as const, padding: "6px 8px", fontSize: "0.85em", border: "1px solid var(--border-light)", borderRadius: "var(--radius-sm)", outline: "none", background: "var(--bg-hover)", color: "var(--text-main)" };

// ヘッダーの ⚙️ から開く、LLMのモデルと出力上限の設定パネル
export const ModelSettingsButton = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [settings, setSettings] = useState<LLMSettings | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const open = async () => {
    setIsOpen(true);
    setStatus(null);
    try {
      const [settingsRes, modelsRes] = await Promise.all([fetch(`${API}/api/settings`), fetch(`${API}/api/models`)]);
      const current = await settingsRes.json();
      setSettings({ model: current.model, vision_model: current.vision_model, max_tokens: current.max_tokens });
      const list = await modelsRes.json();
      setModels(list.models || []);
      setModelsError(list.error || null);
    } catch (error) {
      console.error("モデル設定の取得エラー:", error);
      setStatus("⚠️ バックエンドに接続できません。");
    }
  };

  const save = async () => {
    if (!settings) return;
    setIsSaving(true);
    try {
      const res = await fetch(`${API}/api/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `保存に失敗しました (${res.status})`);
      setSettings({ model: data.model, vision_model: data.vision_model, max_tokens: data.max_tokens });
      setStatus("✅ 保存しました。次のリクエストから反映されます。");
    } catch (error: any) {
      setStatus(`⚠️ ${error.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <button
        onClick={() => (isOpen ? setIsOpen(false) : open())}
        style={{ background: isOpen ? "var(--border-light)" : "transparent", color: "var(--text-muted)", border: "none", cursor: "pointer", fontSize: "1.1em", padding: "2px 8px", marginRight: "4px", borderRadius: "4px", transition: "all 0.2s" }}
        title="モデル設定"
      >
        ⚙️
      </button>

      {isOpen && (
        <div style={{ position: "fixed", top: "40px", right: "16px", width: "320px", zIndex: 1000, background: "var(--bg-panel)", border: "1px solid var(--border-light)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-float)", padding: "16px", color: "var(--text-main)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontWeight: "bold", fontSize: "0.95em" }}>⚙️ モデル設定</span>
            <button onClick={() => setIsOpen(false)} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text-muted)" }}>✕</button>
          </div>

          {settings ? (
            <>
              {/* 一覧から選ぶことも、一覧に無い名前を手入力することもできる */}
              <datalist id="llm-model-options">
                {models.map(m => <option key={m} value={m} />)}
              </datalist>

              <label style={labelStyle}>モデル（QA・数式・引用・コード・ライブラリ）</label>
              <input list="llm-model-options" value={settings.model} onChange={e => setSettings({ ...settings, model: e.target.value })} style={inputStyle} />

              <label style={labelStyle}>Vision用モデル（図表解説・画像の文字起こし）</label>
              <input list="llm-model-options" value={settings.vision_model} placeholder={`空欄なら ${settings.model || "上のモデル"} を使用`} onChange={e => setSettings({ ...settings, vision_model: e.target.value })} style={inputStyle} />

              <label style={labelStyle}>最大出力トークン数</label>
              <input type="number" min={1} max={131072} value={settings.max_tokens} onChange={e => setSettings({ ...settings, max_tokens: Number(e.target.value) })} style={inputStyle} />
              <div style={{ fontSize: "0.7em", color: "var(--text-muted)", marginTop: "4px" }}>
                出力が止まらずローカルLLMを占有するのを防ぎます。導出など長い回答が途中で切れる場合は増やしてください。
              </div>

              {modelsError && (
                <div style={{ fontSize: "0.7em", color: "var(--text-muted)", marginTop: "8px" }}>
                  モデル一覧を取得できませんでした（手入力できます）: {modelsError}
                </div>
              )}

              <button
                onClick={save}
                disabled={isSaving || !settings.model.trim()}
                style={{ width: "100%", marginTop: "14px", padding: "8px", background: "var(--text-main)", color: "var(--bg-panel)", border: "none", borderRadius: "var(--radius-sm)", cursor: isSaving ? "wait" : "pointer", fontWeight: "600", fontSize: "0.85em", opacity: !settings.model.trim() ? 0.5 : 1 }}
              >
                {isSaving ? "保存中..." : "保存"}
              </button>
            </>
          ) : (
            !status && <div style={{ fontSize: "0.85em", color: "var(--text-muted)", marginTop: "12px" }}>読み込み中...</div>
          )}

          {status && <div style={{ fontSize: "0.8em", marginTop: "10px" }}>{status}</div>}
        </div>
      )}
    </>
  );
};
