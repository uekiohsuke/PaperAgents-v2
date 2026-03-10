import { useState, useRef, useEffect } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import './App.css';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const pdfOptions = {
  cMapUrl: `https://unpkg.com/pdfjs-dist@${pdfjs.version}/cmaps/`,
  cMapPacked: true,
};

// チャットメッセージ型定義
type Message = {
  id: string;
  role: "user" | "ai";
  taskType?: "qa" | "math" | "citation";
  content: string; // ユーザーの質問や、AIの回答テキスト
  sourceText?: string; // 参照したテキスト（チップ表示用）
  sourceImage?: string; // 参照した画像（チップ表示用）
  paperInfo?: any; // Citation時のメタデータ
};

function App() {
  // PDFページ番号state
  const [numPages, setNumPages] = useState<number>();
  const [pageNumber, setPageNumber] = useState<number>(1);
  
  // 選択文章と周辺文脈state
  const [selectedText, setSelectedText] = useState<string>("");
  const [currentContext, setCurrentContext] = useState<string>(""); 

  // ユーザ/LLMのメッセージ履歴state
  const [messages, setMessages] = useState<Message[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  // ユーザーが自由にテキストを打ち込む用のState
  const [inputText, setInputText] = useState("");
  
  // 処理state
  const [currentTask, setCurrentTask] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);

  // 矩形選択用state
  const [isSnipMode, setIsSnipMode] = useState<boolean>(false);
  const [snipStart, setSnipStart] = useState<{ x: number, y: number } | null>(null);
  const [snipBox, setSnipBox] = useState<{ x: number, y: number, w: number, h: number } | null>(null);
  const [croppedImage, setCroppedImage] = useState<string | null>(null);

  function onDocumentLoadSuccess({ numPages }: { numPages: number }) {
    setNumPages(numPages);
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

// テキスト選択
  const handleMouseUp = () => {
    // 切り抜きモード中はテキスト選択イベントを無視
    if (isSnipMode) return;

    const selection = window.getSelection();
    const text = selection?.toString() || "";

    if (text.trim().length > 0) {
      setSelectedText(text);
      setCroppedImage(null);

      const textLayer = document.querySelector('.react-pdf__Page__textContent');
      const pageText = textLayer?.textContent || "";
      const matchIndex = pageText.indexOf(text);

      if (matchIndex !== -1) {
        const start = Math.max(0, matchIndex - 400);
        const end = Math.min(pageText.length, matchIndex + text.length + 400);
        setCurrentContext(pageText.substring(start, end));
      } else {
        setCurrentContext(text);
      }
    } else {
      setSelectedText("");
    }
  };

  const handleSnipMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();

    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setSnipStart({ x, y });
    setSnipBox({ x, y, w: 0, h: 0 });
    setCroppedImage(null); // 前の画像をクリア
  };

  const handleSnipMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();

    if (!snipStart) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const currentX = e.clientX - rect.left;
    const currentY = e.clientY - rect.top;
    
    setSnipBox({
      x: Math.min(snipStart.x, currentX),
      y: Math.min(snipStart.y, currentY),
      w: Math.abs(currentX - snipStart.x),
      h: Math.abs(currentY - snipStart.y)
    });
  };

// 画像切り抜き
  const handleSnipMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();

    if (!snipBox || snipBox.w < 10 || snipBox.h < 10) {
      setSnipStart(null);
      setSnipBox(null);
      setIsSnipMode(false);
      return; 
    }

    const pdfCanvas = document.querySelector('.react-pdf__Page canvas') as HTMLCanvasElement;
    const overlay = document.getElementById('snip-overlay');
    
    if (pdfCanvas && overlay) {
      const rect = overlay.getBoundingClientRect();
      const scaleX = pdfCanvas.width / rect.width;
      const scaleY = pdfCanvas.height / rect.height;

      const sourceX = snipBox.x * scaleX;
      const sourceY = snipBox.y * scaleY;
      const sourceW = snipBox.w * scaleX;
      const sourceH = snipBox.h * scaleY;

      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = sourceW;
      tempCanvas.height = sourceH;
      const ctx = tempCanvas.getContext('2d');
      
      if (ctx) {
        ctx.drawImage(
          pdfCanvas, sourceX, sourceY, sourceW, sourceH, 0, 0, sourceW, sourceH
        );
        const base64Image = tempCanvas.toDataURL('image/png');
        setCroppedImage(base64Image);
        
        setSelectedText("");
        window.getSelection()?.removeAllRanges();
      }
    }
    setSnipStart(null);
    setSnipBox(null);
    setIsSnipMode(false); // 自動オフ
  };

  const toggleSnipMode = () => {
    setIsSnipMode(prev => {
      if (prev) {
        setSnipStart(null);
        setSnipBox(null);
      }
      return !prev;
    });
  };

  const askAgent = async (taskType: "qa" | "math" | "citation", subOption?: string, customText?: string) => {
    // 選択テキスト、画像、自由入力のいずれかが無いと発火しない
    if (!selectedText && !croppedImage && !customText) return; 
    setIsLoading(true);
    setCurrentTask(taskType);

    // ユーザーのメッセージを配列に追加
    const userMsgId = Date.now().toString();
    const userMsg: Message = {
      id: userMsgId,
      role: "user",
      taskType: taskType,
      content: customText || `[${subOption}] をリクエストしました`, 
      sourceText: selectedText,
      sourceImage: croppedImage || undefined,
    };

    // AIの返答用空枠を配列に追加
    const aiMsgId = (Date.now() + 1).toString();
    const aiMsg: Message = {
      id: aiMsgId,
      role: "ai",
      taskType: taskType,
      content: "",
    };

    setMessages((prev) => [...prev, userMsg, aiMsg]);
    setInputText(""); // 入力欄をクリア

    // ペイロードの構築
    let payload: any = {
      selected_text: null, user_intent: null,
      selected_tex: null, selected_image: null, action_type: null,
      selected_citation: null, target_reference_text: null
    };

    if (taskType === "qa") {
      payload.selected_text = selectedText;
      payload.user_intent = customText || subOption || "explain"; 
    } else if (taskType === "math") {
      payload.selected_image = croppedImage; 
      payload.action_type = customText || subOption || "explain"; 
    } else if (taskType === "citation") {
      payload.selected_citation = selectedText; 
    }

    const historyForBackend = messages.map(msg => ({
      role: msg.role,
      content: msg.content
    }));

    try {
      const response = await fetch("http://127.0.0.1:8000/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_type: taskType,
          context: { paper_metadata: "Sample Physics Report", current_context: currentContext },
          payload: payload,
          chat_history: historyForBackend
        })
      });

      if (!response.ok) throw new Error("APIエラー");
      if (!response.body) throw new Error("ストリームがサポートされていません");

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunkStr = decoder.decode(value, { stream: true });
        const lines = chunkStr.split('\n');
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6);
            if (!dataStr.trim()) continue;

            const data = JSON.parse(dataStr);
            if (data.done) break;
            if (data.status === "info") continue;

            if (data.paper_info) {
              setMessages((prev) => prev.map(msg => 
                msg.id === aiMsgId ? { ...msg, paperInfo: data.paper_info } : msg
              ));
            }

            if (data.chunk) {
              setMessages((prev) => prev.map(msg => 
                msg.id === aiMsgId ? { ...msg, content: msg.content + data.chunk } : msg
              ));
            }
          }
        }
      }
    } catch (error) {
      console.error(error);
      setMessages((prev) => prev.map(msg => 
        msg.id === aiMsgId ? { ...msg, content: "⚠️ 通信エラーが発生しました。" } : msg
      ));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="app-container">
      <div className="pdf-pane" onMouseUp={handleMouseUp}>
        <div className="pdf-controls">
          <button disabled={pageNumber <= 1} onClick={() => setPageNumber(pageNumber - 1)}>◀ 前へ</button>
          <span>{pageNumber} / {numPages} ページ</span>
          <button disabled={pageNumber >= (numPages || 1)} onClick={() => setPageNumber(pageNumber + 1)}>次へ ▶</button>
          <button 
            onClick={toggleSnipMode}
            style={{ marginLeft: "15px", background: isSnipMode ? "#e65100" : "#ccc", color: isSnipMode ? "#fff" : "#333", border: "none", padding: "5px 10px", borderRadius: "4px", cursor: "pointer" }}
          >
            {isSnipMode ? "✂️ 切り抜きモードON" : "📐 切り抜きモードOFF"}
          </button>
        </div>
        <div className="pdf-document" style={{ display: "flex", justifyContent: "center" }}>
          <Document file="/sample.pdf" onLoadSuccess={onDocumentLoadSuccess} options={pdfOptions}>
            <Page pageNumber={pageNumber} width={600}>
              {isSnipMode && (
                <div 
                  id="snip-overlay"
                  style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 10, cursor: "crosshair", background: "rgba(0,0,0,0.05)" }}
                  onMouseDown={handleSnipMouseDown}
                  onMouseMove={handleSnipMouseMove}
                  onMouseUp={handleSnipMouseUp}
                  onMouseLeave={() => setSnipStart(null)}
                >
                  {/* ドラッグ中の赤い点線の四角形 */}
                  {snipBox && (
                    <div style={{ position: "absolute", left: snipBox.x, top: snipBox.y, width: snipBox.w, height: snipBox.h, border: "2px dashed #e65100", backgroundColor: "rgba(230, 81, 0, 0.1)", pointerEvents: "none" }} />
                  )}
                </div>
              )}
            </Page>
          </Document>
        </div>
      </div>

      {/* 右側のペイン */}
      <div className="agent-pane">
        <h2>🤖 Paper Agent (Main Thread)</h2>
        
        {/* 上部：会話履歴エリア*/}
        <div className="chat-history" style={{ flex: 1, overflowY: "auto", padding: "20px", background: "#f8f9fa" }}>
          {messages.length === 0 ? (
            <div style={{ textAlign: "center", color: "#888", marginTop: "50px" }}>
              PDFのテキストを選択するか、数式を切り抜いて質問してください。
            </div>
          ) : (
            messages.map((msg) => (
              <div key={msg.id} style={{ marginBottom: "20px", display: "flex", flexDirection: "column", alignItems: msg.role === "user" ? "flex-end" : "flex-start" }}>
                
                <div style={{ maxWidth: "80%", background: msg.role === "user" ? "#e3f2fd" : "#fff", padding: "12px", borderRadius: "8px", border: "1px solid #dee2e6", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
                  
                  {/* ユーザーの質問に紐づく参照チップ */}
                  {msg.sourceText && (
                    <div style={{ fontSize: "0.8em", background: "rgba(0,0,0,0.05)", padding: "4px 8px", borderRadius: "4px", borderLeft: "3px solid #1976d2", marginBottom: "8px", color: "#555" }}>
                      📝 {msg.sourceText.length > 50 ? msg.sourceText.substring(0, 50) + "..." : msg.sourceText}
                    </div>
                  )}
                  {msg.sourceImage && (
                    <div style={{ marginBottom: "8px" }}>
                      <img src={msg.sourceImage} alt="ref" style={{ maxHeight: "60px", border: "1px solid #ccc", borderRadius: "4px" }} />
                    </div>
                  )}

                  {/* Citationのメタデータカード */}
                  {msg.paperInfo && (
                    <div style={{ 
                      fontSize: "0.9em", 
                      // Webサイト用の青色を追加
                      background: msg.paperInfo.color === "green" ? "#e8f5e9" : 
                                  msg.paperInfo.color === "yellow" ? "#fffde7" : 
                                  msg.paperInfo.color === "orange" ? "#fff3e0" : 
                                  msg.paperInfo.color === "blue" ? "#e3f2fd" : "#f5f5f5", 
                      padding: "12px", 
                      borderRadius: "6px", 
                      marginBottom: "12px", 
                      border: "1px solid #ccc",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.05)"
                    }}>
                      <div style={{ 
                        color: msg.paperInfo.color === "blue" ? "#0277bd" : "#1b5e20", 
                        fontWeight: "bold", 
                        marginBottom: "6px",
                        borderBottom: "1px solid rgba(0,0,0,0.1)",
                        paddingBottom: "4px"
                      }}>
                        {msg.paperInfo.color === "blue" ? "🌐 Webサイト参照" : "📚 文献調査結果"}
                      </div>
                      
                      {/* LLMが抽出したタイトルと著者名を表示 */}
                      {msg.paperInfo.title && (
                        <div style={{ fontWeight: "bold", fontSize: "1.05em", color: "#333", marginTop: "4px" }}>
                          {msg.paperInfo.title}
                        </div>
                      )}
                      {msg.paperInfo.authors && (
                        <div style={{ color: "#555", fontSize: "0.9em", marginBottom: "8px" }}>
                          👤 {msg.paperInfo.authors}
                        </div>
                      )}

                      <div style={{ marginTop: "8px" }}>
                        <span style={{ 
                          background: "rgba(255,255,255,0.7)", 
                          padding: "2px 6px", 
                          borderRadius: "4px", 
                          border: "1px solid rgba(0,0,0,0.1)" 
                        }}>
                          ステータス: <strong>{msg.paperInfo.status}</strong>
                        </span>
                      </div>
                      
                      <div style={{ marginTop: "10px", display: "flex", gap: "12px", flexWrap: "wrap" }}>
                        {msg.paperInfo.url && (
                          <a href={msg.paperInfo.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none", color: "#0277bd", fontWeight: "bold" }}>
                            {msg.paperInfo.color === "blue" ? "🔗 サイトを開く" : "📄 PDFを開く"}
                          </a>
                        )}
                        {/* Webサイトの場合はScholar/CiNii検索ボタンは出さない */}
                        {msg.paperInfo.color !== "blue" && msg.paperInfo.scholar_url && (
                          <a href={msg.paperInfo.scholar_url} target="_blank" rel="noreferrer" style={{ textDecoration: "none", color: "#0277bd", fontWeight: "500" }}>🔍 Scholar</a>
                        )}
                        {msg.paperInfo.color !== "blue" && msg.paperInfo.cinii_url && (
                          <a href={msg.paperInfo.cinii_url} target="_blank" rel="noreferrer" style={{ textDecoration: "none", color: "#0277bd", fontWeight: "500" }}>🏛️ CiNii</a>
                        )}
                      </div>
                    </div>
                  )}

                  {/* メッセージ本文 */}
                  <div style={{ whiteSpace: "pre-wrap", color: "#333" }}>{msg.content}</div>
                  
                  {/* ローディング表示 */}
                  {isLoading && msg.role === "ai" && !msg.content && (
                    <span style={{ color: "#888", fontSize: "0.9em" }}>考え中...</span>
                  )}
                </div>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* 入力・操作エリア */}
        <div className="chat-input-area" style={{ flexShrink: 0, borderTop: "1px solid #dee2e6", padding: "15px", background: "#fff" }}>
          
          {/* 選択中のターゲット表示 */}
          {(selectedText || croppedImage) && (
            <div style={{ marginBottom: "10px", fontSize: "0.9em", display: "flex", alignItems: "center", gap: "10px", background: "#f1f3f5", padding: "8px", borderRadius: "4px" }}>
              <strong style={{ color: "#555" }}>🎯 選択中:</strong>
              {croppedImage ? (
                <img src={croppedImage} alt="crop" style={{ height: "30px", border: "1px solid #ccc" }} />
              ) : (
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "300px" }}>{selectedText}</span>
              )}
            </div>
          )}

          {/* クイックアクションボタン群 */}
          {selectedText && !croppedImage && (
            <div style={{ display: "flex", gap: "5px", marginBottom: "10px", flexWrap: "wrap" }}>
              <button onClick={() => askAgent("qa", "explain")} disabled={isLoading} style={{ padding: "4px 8px", fontSize: "0.85em", background: "#e3f2fd", border: "1px solid #90caf9", borderRadius: "4px", cursor: "pointer" }}>解説</button>
              <button onClick={() => askAgent("qa", "intent")} disabled={isLoading} style={{ padding: "4px 8px", fontSize: "0.85em", background: "#e3f2fd", border: "1px solid #90caf9", borderRadius: "4px", cursor: "pointer" }}>意図</button>
              <button onClick={() => askAgent("qa", "example")} disabled={isLoading} style={{ padding: "4px 8px", fontSize: "0.85em", background: "#e3f2fd", border: "1px solid #90caf9", borderRadius: "4px", cursor: "pointer" }}>具体例</button>
              <button onClick={() => askAgent("qa", "summarize")} disabled={isLoading} style={{ padding: "4px 8px", fontSize: "0.85em", background: "#e3f2fd", border: "1px solid #90caf9", borderRadius: "4px", cursor: "pointer" }}>要約</button>
              <button onClick={() => askAgent("qa", "evidence")} disabled={isLoading} style={{ padding: "4px 8px", fontSize: "0.85em", background: "#e3f2fd", border: "1px solid #90caf9", borderRadius: "4px", cursor: "pointer" }}>根拠</button>
              <button onClick={() => askAgent("citation", "citation")} disabled={isLoading} style={{ padding: "4px 8px", fontSize: "0.85em", background: "#e8f5e9", border: "1px solid #a5d6a7", borderRadius: "4px", cursor: "pointer" }}>引用調査</button>
            </div>
          )}
          {croppedImage && (
            <div style={{ display: "flex", gap: "5px", marginBottom: "10px" }}>
              <button onClick={() => askAgent("math", "derivation")} disabled={isLoading} style={{ padding: "4px 8px", fontSize: "0.85em", background: "#fff3e0", border: "1px solid #ffcc80", borderRadius: "4px", cursor: "pointer" }}>式の導出</button>
              <button onClick={() => askAgent("math", "explain")} disabled={isLoading} style={{ padding: "4px 8px", fontSize: "0.85em", background: "#fff3e0", border: "1px solid #ffcc80", borderRadius: "4px", cursor: "pointer" }}>式の意味</button>
            </div>
          )}

          {/* 自由入力フォーム */}
          <div style={{ display: "flex", gap: "10px" }}>
            <input 
              type="text" 
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => { 
                // Enter かつ Shiftキーが押されている時だけ送信
                if (e.key === "Enter" && e.shiftKey) { 
                  e.preventDefault(); // デフォルトの挙動を念のためストップ
                  askAgent(croppedImage ? "math" : "qa", undefined, inputText); 
                } 
              }}
              placeholder={croppedImage ? "この数式について質問... (Shift+Enterで送信)" : "選択したテキストについて質問... (Shift+Enterで送信)"}
              disabled={isLoading}
              style={{ flex: 1, padding: "10px", borderRadius: "4px", border: "1px solid #ccc" }}
            />
            <button 
              onClick={() => askAgent(croppedImage ? "math" : "qa", undefined, inputText)}
              disabled={isLoading || !inputText.trim()}
              style={{ padding: "10px 20px", background: "#0d47a1", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", whiteSpace: "nowrap" }}
            >
              送信
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}

export default App;