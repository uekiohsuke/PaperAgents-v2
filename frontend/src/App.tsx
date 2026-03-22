import { useState, useRef, useEffect } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import './App.css';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import remarkBreaks from 'remark-breaks';

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
  sourcePage?: number; // 参照対象のページ
};

// チャットスレッド型定義
type Thread = {
  id: string;
  title: string;        // スレッドのタイトル
  isMain: boolean;      // メインスレッドかどうかの判定用
  isCollapsed: boolean; // UIで折り畳まれているかどうか
  messages: Message[];  // このスレッド内のチャット履歴
};

function App() {
  // PDFページ番号state
  const [numPages, setNumPages] = useState<number>();
  const [pageNumber, setPageNumber] = useState<number>(1);

  const [outline, setOutline] = useState<any[]>([]); // PDFから抽出した目次データ
  const [isTocOpen, setIsTocOpen] = useState<boolean>(false); // 目次ペインの開閉状態
  
  // 選択文章と周辺文脈state
  const [selectedText, setSelectedText] = useState<string>("");
  const [currentContext, setCurrentContext] = useState<string>(""); 

  // チャットスレッドstate
  const [threads, setThreads] = useState<Thread[]>([
    {
      id: "main-thread",
      title: "メインスレッド",
      isMain: true,
      isCollapsed: false,
      messages: []
    }
  ]);
  const [activeThreadId, setActiveThreadId] = useState<string>("main-thread");
  
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

  // フローティングメニューstate
  const [menuPos, setMenuPos] = useState<{ x: number, y: number } | null>(null);
  const [menuCategory, setMenuCategory] = useState<"root" | "qa" | "math">("root");
  const [selectedTargetThread, setSelectedTargetThread] = useState<string>("main-thread");

  const [activeTab, setActiveTab] = useState<"toc" | "refs">("toc"); // タブ切り替え用
  const [references, setReferences] = useState<{ [key: string]: string }>({}); // 参考文献データ

  // ペイン幅とリサイズ状態を管理
  const [agentPaneWidth, setAgentPaneWidth] = useState<number>(400); // 初期幅は400px
  const isResizingRef = useRef<boolean>(false);

  // 各文献のOAステータスを保持する辞書
  const [oaStatuses, setOaStatuses] = useState<{ [refNum: string]: any }>({});

  // 各引用番号が出現するページ番号の配列
  const [citationPages, setCitationPages] = useState<{ [key: string]: number[] }>({});

  // 通信のキャンセルを管理するコントローラー
  const abortControllerRef = useRef<AbortController | null>(null);

  // メッセージを履歴から削除する関数
  const deleteMessage = (targetMsgId: string) => {
    setThreads(prevThreads => 
      prevThreads.map(thread => ({
        ...thread,
        messages: thread.messages.filter(msg => msg.id !== targetMsgId)
      }))
    );
  };

  // 生成を強制ストップする関数
  const stopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  // スレッド折りたたみ
  const toggleThreadCollapse = (threadId: string) => {
    setThreads(prev => prev.map(t => 
      t.id === threadId ? { ...t, isCollapsed: !t.isCollapsed } : t
    ));
    // ついでにフォーカスも移しておく
    setActiveThreadId(threadId);
  };

  // スレッドごとの末尾要素を管理する辞書（オブジェクト）にする
  const messagesEndRefs = useRef<{ [threadId: string]: HTMLDivElement | null }>({});

  // threadsが更新されたら、アクティブなスレッドの末尾へスクロール
  useEffect(() => {
    if (activeThreadId && messagesEndRefs.current[activeThreadId]) {
      messagesEndRefs.current[activeThreadId]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [threads, activeThreadId]);

  // ペイン幅をマウスドラッグで変更する処理
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;
      
      // 画面の右端（window.innerWidth）からマウスの現在X座標を引いて幅を計算
      const newWidth = window.innerWidth - e.clientX;
      
      // 最小幅300px、最大幅は画面の60%までに制限してレイアウト崩れを防ぐ
      if (newWidth > 300 && newWidth < window.innerWidth * 0.6) {
        setAgentPaneWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      if (isResizingRef.current) {
        isResizingRef.current = false;
        document.body.style.cursor = 'default'; // カーソルを元に戻す
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const jumpToPage = (pageStr: string | number) => {
    // pdf.js の getOutline が返す dest は文字列の場合があるため安全に数値化
    let targetPage = typeof pageStr === "string" ? parseInt(pageStr.replace(/[^0-9]/g, "")) : pageStr;
    if (targetPage && targetPage > 0 && numPages && targetPage <= numPages) {
      setPageNumber(targetPage);
    }
  };

// ハイブリッド目次抽出ロジック
  async function onDocumentLoadSuccess(pdf: any) {
    setNumPages(pdf.numPages);
    try {
      const outlineData = await pdf.getOutline();
      
      if (outlineData && outlineData.length > 0) {
        // メタデータが存在すればそれをセット
        setOutline(outlineData);
      } else {
        console.log("PDFに目次メタデータがありません。バックエンドの自前パーサーを呼び出します...");
        const res = await fetch("http://127.0.0.1:8000/api/pdf_info");
        const data = await res.json();
        
        // Pythonのフォーマット [level, title, page_num] をフロントエンド用にマッピング
        const fallbackOutline = data.toc.map((item: any[]) => ({
          title: item[1], // "1 はじめに" などの文字列
          dest: item[2],  // ページ番号
          level: item[0]  // インデント表示などに使える階層レベル
        }));
        
        setOutline(fallbackOutline);
        setReferences(data.references || {});
        setCitationPages(data.citation_pages || {});
      }
    } catch (error) {
      console.error("目次の抽出に失敗しました:", error);
    }
  }

// テキスト選択
  const handleMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    // 切り抜きモード中はテキスト選択イベントを無視
    if (isSnipMode) return;

    const selection = window.getSelection();
    const text = selection?.toString() || "";

    if (text.trim().length > 0) {
      setSelectedText(text);
      setCroppedImage(null);
      setMenuPos({ x: e.clientX, y: e.clientY });

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
      setMenuPos(null);
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

        const textLayer = document.querySelector('.react-pdf__Page__textContent');
        if (textLayer) {
          setCurrentContext(textLayer.textContent || "");
        }

        setSelectedText("");
        setMenuPos({ x: e.clientX, y: e.clientY });

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

  // フローティングメニューからの実行をハンドリングする関数
  const handleMenuAction = (taskType: "qa" | "math" | "citation", actionStr: string) => {
    let targetId = selectedTargetThread;

    if (targetId === "new") {
      // 1. 新規スレッドの作成
      const newThreadId = "thread-" + Date.now();
      targetId = newThreadId;
      
      // スレッドの仮タイトル（テキストの冒頭、または「数式」）
      const newTitle = croppedImage ? "📐 数式の解説" : `📝 ${selectedText.substring(0, 10)}...`;

      setThreads(prev => [
        { id: newThreadId, title: newTitle, isMain: false, isCollapsed: false, messages: [] },
        ...prev // 新しいものを一番上に追加
      ]);
    } else {
      // 2. 既存スレッドを使う場合、閉じていたら開く
      setThreads(prev => prev.map(t => t.id === targetId ? { ...t, isCollapsed: false } : t));
    }

    // フォーカスを移してメニューを閉じる
    setActiveThreadId(targetId);
    setMenuPos(null);
    setMenuCategory("root");

    // 3. エージェントに質問を投げる
    askAgent(taskType, targetId, actionStr);
  };

  const askAgent = async (taskType: "qa" | "math" | "citation",targetThreadId: string, subOption?: string, customText?: string) => {
    // 選択テキスト、画像、自由入力のいずれかが無いと発火しない
    if (!selectedText && !croppedImage && !customText) return; 
    setIsLoading(true);
    setCurrentTask(taskType);
    abortControllerRef.current = new AbortController();

    // ユーザーのメッセージを配列に追加
    const userMsgId = Date.now().toString();
    const userMsg: Message = {
      id: userMsgId,
      role: "user",
      taskType: taskType,
      content: customText || `[${subOption}] をリクエストしました`, 
      sourceText: selectedText,
      sourceImage: croppedImage || undefined,
      sourcePage: pageNumber,
    };

    // AIの返答用空枠を配列に追加
    const aiMsgId = (Date.now() + 1).toString();
    const aiMsg: Message = {
      id: aiMsgId,
      role: "ai",
      taskType: taskType,
      content: "",
    };

    // スレッドに追加
    setThreads(prevThreads => 
      prevThreads.map(thread => 
        thread.id === targetThreadId
          ? { ...thread, messages: [...thread.messages, userMsg, aiMsg] }
          : thread
      )
    );

    setInputText(""); // 入力欄をクリア

    // ペイロードの構築
    let payload: any = {
      selected_text: selectedText || null,
      selected_image: croppedImage || null, // 画像があれば常に送る（バックエンドのSupervisorがOCRに回してくれます）
      user_intent: customText || subOption || "explain",
      action_type: customText || subOption || "explain",
      selected_citation: selectedText || null,
    };

    const currentThread = threads.find(t => t.id === targetThreadId);
    const historyForBackend = currentThread ? currentThread.messages.map(msg => ({
      role: msg.role,
      content: msg.content
    })) : [];

    try {
      const response = await fetch("http://127.0.0.1:8000/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortControllerRef.current.signal,
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
              setThreads(prevThreads => prevThreads.map(thread => 
                thread.id === targetThreadId
                  ? {
                      ...thread,
                      messages: thread.messages.map(msg => 
                        msg.id === aiMsgId ? { ...msg, paperInfo: data.paper_info } : msg
                      )
                    }
                  : thread
              ));
            }

            if (data.chunk) {
              setThreads(prevThreads => prevThreads.map(thread => 
                thread.id === targetThreadId
                  ? {
                      ...thread,
                      messages: thread.messages.map(msg => 
                        msg.id === aiMsgId ? { ...msg, content: msg.content + data.chunk } : msg
                      )
                    }
                  : thread
              ));
            }
          }
        }
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log("生成が中断されました");
        setThreads(prevThreads => prevThreads.map(thread => 
          thread.id === targetThreadId
            ? {
                ...thread,
                messages: thread.messages.filter(msg => msg.id !== userMsgId && msg.id !== aiMsgId)
              }
            : thread
        ));
      } else {
        console.error(error);
        setThreads(prevThreads => prevThreads.map(thread => 
          thread.id === targetThreadId
            ? {
                ...thread,
                messages: thread.messages.map(msg => 
                  msg.id === aiMsgId ? { ...msg, content: "⚠️ 通信エラーが発生しました。" } : msg
                )
              }
            : thread
        ));
      }
    } finally {
      setIsLoading(false);
      abortControllerRef.current = null;
    }
  };

  return (
    <div className="app-container" style={{ 
      display: "flex", 
      height: "100vh", 
      width: "100vw", 
      position: "absolute", 
      top: 0, 
      left: 0, 
      overflow: "hidden" // 画面全体でのスクロールを禁止し、各ペインに任せる
    }}>
      {/* 格納可能な目次(TOC)ペイン */}
      <div style={{ 
        width: isTocOpen ? "250px" : "40px", 
        height: "100%",
        background: "#e9ecef", 
        borderRight: "1px solid #ccc",
        transition: "width 0.3s ease",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden"
      }}>
        <div 
          onClick={() => setIsTocOpen(!isTocOpen)} 
          style={{ padding: "15px 10px", cursor: "pointer", fontWeight: "bold", background: "#dee2e6", display: "flex", justifyContent: "center", alignItems: "center", borderBottom: "1px solid #ccc", whiteSpace: "nowrap" }}
        >
          {isTocOpen ? "📑 目次を閉じる" : "📑"}
        </div>
        
        {isTocOpen && (
          <>
            <div style={{ display: "flex", borderBottom: "1px solid #ccc", background: "#f8f9fa" }}>
              <div onClick={() => setActiveTab("toc")} style={{ flex: 1, padding: "10px", textAlign: "center", cursor: "pointer", fontWeight: activeTab === "toc" ? "bold" : "normal", borderBottom: activeTab === "toc" ? "2px solid #0d47a1" : "none", color: activeTab === "toc" ? "#0d47a1" : "#555" }}>📑 目次</div>
              <div onClick={() => setActiveTab("refs")} style={{ flex: 1, padding: "10px", textAlign: "center", cursor: "pointer", fontWeight: activeTab === "refs" ? "bold" : "normal", borderBottom: activeTab === "refs" ? "2px solid #0d47a1" : "none", color: activeTab === "refs" ? "#0d47a1" : "#555" }}>📚 参考文献</div>
            </div>
            <div style={{ padding: "10px", overflowY: "auto", flex: 1, fontSize: "0.9em" }}>
              
              {/* === 目次タブ === */}
              {activeTab === "toc" && (
                <div style={{ padding: "10px", overflowY: "auto", flex: 1, fontSize: "0.9em" }}>
                {outline && outline.length > 0 ? (
                  <ul style={{ listStyleType: "none", padding: 0, margin: 0 }}>
                    {outline.map((item, index) => {
                      // Pythonバックエンドから来た level 情報があれば字下げする
                      const indent = item.level ? (item.level - 1) * 15 : 0;
                      
                      return (
                        <li key={index} style={{ marginBottom: "8px", marginLeft: `${indent}px` }}>
                          <span 
                            onClick={() => {
                              const target = Array.isArray(item.dest) ? item.dest[0] : item.dest;
                              if(target) jumpToPage(target);
                            }} 
                            style={{ color: "#0056b3", cursor: "pointer", textDecoration: "underline" }}
                          >
                            {item.title}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <div style={{ color: "#777", textAlign: "center", marginTop: "20px" }}>目次データを抽出中です...</div>
                )}
              </div>
              )}

              {/* === 参考文献タブ === */}
              {activeTab === "refs" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  {Object.keys(references).length > 0 ? (
                    Object.entries(references).map(([refNum, refText]) => {
                      const status = oaStatuses[refNum]; // この文献のステータスを取得
                      
                      // ステータスに応じた信号機カラーの設定
                      let statusColor = "#ccc"; // デフォルト（未確認）
                      if (status?.color === "green") statusColor = "#4caf50";
                      else if (status?.color === "yellow") statusColor = "#ffeb3b";
                      else if (status?.color === "orange") statusColor = "#ff9800";
                      else if (status?.color === "blue") statusColor = "#2196f3";

                      return (
                        <div key={refNum} style={{ background: "#fff", padding: "10px", borderRadius: "6px", border: "1px solid #ddd", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "5px" }}>
                            <div style={{ fontWeight: "bold", color: "#1976d2" }}>{refNum}</div>
                            
                            {/* 🚦 信号機とステータスバッジ */}
                            {status && (
                              <div style={{ fontSize: "0.7em", background: statusColor, color: status?.color === "yellow" ? "#000" : "#fff", padding: "2px 6px", borderRadius: "10px", fontWeight: "bold" }}>
                                {status.status}
                              </div>
                            )}
                          </div>
                          
                          <div style={{ fontSize: "0.85em", color: "#333", marginBottom: "10px", lineHeight: "1.4" }}>
                            {refText.length > 80 ? refText.substring(0, 80) + "..." : refText}
                          </div>
                          
                          <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
                            {/* 🌟 新規: OAステータスを確認するボタン */}
                            <button 
                              onClick={async () => {
                                setOaStatuses(prev => ({ ...prev, [refNum]: { status: "確認中...", color: "gray" } }));
                                try {
                                  const res = await fetch("http://127.0.0.1:8000/api/check_oa", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ raw_citation: refText })
                                  });
                                  const data = await res.json();
                                  setOaStatuses(prev => ({ ...prev, [refNum]: data }));
                                } catch (error) {
                                  setOaStatuses(prev => ({ ...prev, [refNum]: { status: "エラー", color: "gray" } }));
                                }
                              }}
                              disabled={status?.status === "確認中..."}
                              style={{ flex: 1, padding: "6px", background: "#f1f3f4", color: "#333", border: "1px solid #ccc", borderRadius: "4px", cursor: "pointer", fontSize: "0.8em" }}
                            >
                              🚦 OA確認
                            </button>

                            {/* OAでURLがあればダウンロードボタンを表示 */}
                            {status?.url && (
                              <button 
                                onClick={() => window.open(status.url, "_blank")}
                                style={{ width: "100%", padding: "4px", background: "#e8f5e9", color: "#2e7d32", border: "1px solid #c8e6c9", borderRadius: "4px", cursor: "pointer", fontSize: "0.8em", marginTop: "4px" }}
                              >
                                📥 PDFを開く
                              </button>
                            )}
                          </div>

                          {/* ページジャンプボタン群 */}
                          {citationPages[refNum] && citationPages[refNum].length > 0 ? (
                            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "10px" }}>
                              <span style={{ fontSize: "0.8em", color: "#666", display: "flex", alignItems: "center" }}>登場ページ:</span>
                              {citationPages[refNum].map(pageNum => (
                                <button
                                  key={pageNum}
                                  onClick={() => jumpToPage(pageNum)} // 既存のジャンプ関数を流用
                                  style={{ padding: "2px 8px", background: "#e0f7fa", color: "#006064", border: "1px solid #b2ebf2", borderRadius: "12px", cursor: "pointer", fontSize: "0.75em", fontWeight: "bold" }}
                                >
                                  📍 P.{pageNum}
                                </button>
                              ))}
                            </div>
                          ) : (
                            <div style={{ fontSize: "0.8em", color: "#aaa", marginTop: "10px" }}>本文中の引用箇所が見つかりません</div>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    <div style={{ color: "#777", textAlign: "center", marginTop: "20px" }}>参考文献データを抽出中です...</div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {/* PDFペイン */}
      <div className="pdf-pane" onMouseUp={handleMouseUp} style={{ flex: 1, height: "100%", overflowY: "auto", display: "flex", flexDirection: "column" }}>
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

      {/* リサイズ用のドラッグハンドル */}
      <div 
        onMouseDown={(e) => {
          e.preventDefault(); // ドラッグ中にテキストが選択されるのを防ぐ
          isResizingRef.current = true;
          document.body.style.cursor = 'col-resize'; // カーソルを「左右矢印」に変更
        }}
        style={{
          width: "6px",
          cursor: "col-resize",
          backgroundColor: "#dee2e6",
          zIndex: 50,
          transition: "background-color 0.2s ease"
        }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#90caf9")}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "#dee2e6")}
      />

      {/* 右側のペイン */}
      <div className="agent-pane" style={{ width: `${agentPaneWidth}px`, height: "100%", background: "#f0f2f5", overflowY: "auto", display: "flex", flexDirection: "column" }}>
        <h2 style={{ fontSize: "1.2em", margin: "15px", color: "#333" , flexShrink: 0 }}>🤖 Paper Agent (Threads)</h2>

        {/* スレッドの配列をループしてレンダリング */}
        <div style={{ padding: "0 15px 15px 15px" }}>
        {threads.map((thread) => (
          <div 
            key={thread.id} 
            onClick={() => {
              // スレッド内の「どこをクリックしても」フォーカスを移す
              if (activeThreadId !== thread.id) {
                setActiveThreadId(thread.id);
                // フォーカスした時に閉じていた場合は、自動でパカッと開く
                setThreads(prev => prev.map(t => 
                  t.id === thread.id ? { ...t, isCollapsed: false } : t
                ));
              }
            }}
            style={{ 
              marginBottom: "15px", 
              background: "#fff", 
              borderRadius: "8px", 
              boxShadow: thread.id === activeThreadId ? "0 4px 15px rgba(25, 118, 210, 0.2)" : "0 2px 5px rgba(0,0,0,0.05)", 
              border: thread.id === activeThreadId ? "2px solid #90caf9" : "1px solid #e0e0e0",
              transition: "all 0.2s ease"
            }}
          >
            
            {/* ▼ スレッドのヘッダー ▼ */}
            <div 
              onClick={(e) => {
                // 🌟 変更: 「すでにアクティブなスレッド」のヘッダーをクリックした時のみ開閉させる
                if (activeThreadId === thread.id) {
                  e.stopPropagation(); // 親のonClickと二重発火するのを防ぐ
                  toggleThreadCollapse(thread.id);
                }
              }}
              style={{ 
                padding: "12px 15px", 
                background: thread.isMain ? "#e3f2fd" : "#f8f9fa", 
                borderBottom: thread.isCollapsed ? "none" : "1px solid #e0e0e0", 
                cursor: "pointer", 
                display: "flex", 
                justifyContent: "space-between", 
                alignItems: "center",
                position: "sticky", 
                top: 0, 
                zIndex: 20,
                borderTopLeftRadius: "7px",
                borderTopRightRadius: "7px"
              }}
            >
              <span style={{ fontWeight: "bold", color: "#1565c0", fontSize: "0.95em" }}>
                {thread.isMain && "📌 "} {thread.title}
              </span>
              <span style={{ color: "#888", fontSize: "0.8em" }}>
                {activeThreadId !== thread.id ? "クリックでフォーカス" : (thread.isCollapsed ? "▼ 開く" : "▲ 閉じる")}
              </span>
            </div>

            {/* ▼ スレッドのボディ（展開時のみ表示） ▼ */}
            {!thread.isCollapsed && (
              <div style={{ 
                display: "flex", 
                flexDirection: "column",
                opacity: thread.id === activeThreadId ? 1 : 0.4, 
                transition: "opacity 0.2s ease",
                pointerEvents: thread.id === activeThreadId ? "auto" : "none" 
              }}>
                
                {/* 1. チャット履歴エリア */}
                <div className="chat-history" style={{ padding: "15px", maxHeight: "400px", overflowY: "auto", background: "#fafafa" }}>
                  {thread.messages.length === 0 ? (
                    <div style={{ textAlign: "center", color: "#aaa", fontSize: "0.9em", padding: "20px 0" }}>
                      まだやり取りがありません。
                    </div>
                  ) : (
                    thread.messages.map((msg) => (
                      /* ーーー ここから：元の msg レンダリング（変更なし） ーーー */
                      <div key={msg.id} style={{ marginBottom: "20px", display: "flex", flexDirection: "column", alignItems: msg.role === "user" ? "flex-end" : "flex-start" }}>
                        <div style={{ position: "relative", maxWidth: "85%", background: msg.role === "user" ? "#e3f2fd" : "#fff", padding: "12px", borderRadius: "8px", border: "1px solid #dee2e6", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
                          
                          <button onClick={() => deleteMessage(msg.id)} style={{ position: "absolute", top: "-10px", right: "-10px", background: "#ffcdd2", color: "#c62828", border: "1px solid #ef9a9a", borderRadius: "50%", width: "24px", height: "24px", cursor: "pointer", fontSize: "0.8em", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 5 }}>×</button>

                          {msg.sourceText && (
                            <div style={{ fontSize: "0.8em", background: "rgba(0,0,0,0.05)", padding: "4px 8px", borderRadius: "4px", borderLeft: "3px solid #1976d2", marginBottom: "8px", color: "#555", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                              <span>📝 {msg.sourceText.length > 50 ? msg.sourceText.substring(0, 50) + "..." : msg.sourceText}</span>
                              {msg.sourcePage && (
                                <button onClick={() => jumpToPage(msg.sourcePage!)} style={{ marginLeft: "10px", background: "#1976d2", color: "white", border: "none", borderRadius: "3px", padding: "2px 6px", cursor: "pointer", fontSize: "0.9em", whiteSpace: "nowrap" }}>📍 P.{msg.sourcePage}</button>
                              )}
                            </div>
                          )}

                          {msg.sourceImage && (
                            <div style={{ marginBottom: "8px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(230, 81, 0, 0.05)", padding: "8px", borderRadius: "4px", borderLeft: "3px solid #e65100" }}>
                              <img src={msg.sourceImage} alt="ref" style={{ maxHeight: "60px", border: "1px solid #ccc", borderRadius: "4px", background: "#fff" }} />
                              {msg.sourcePage && (
                                <button onClick={() => jumpToPage(msg.sourcePage!)} style={{ marginLeft: "10px", background: "#e65100", color: "white", border: "none", borderRadius: "3px", padding: "4px 8px", cursor: "pointer", fontSize: "0.85em", whiteSpace: "nowrap" }}>📍 P.{msg.sourcePage}</button>
                              )}
                            </div>
                          )}

                          <div style={{ color: "#333", fontSize: "0.95em", lineHeight: "1.6", overflowX: "auto", maxWidth: "100%" }}>
                            <ReactMarkdown remarkPlugins={[remarkBreaks, remarkMath]} rehypePlugins={[rehypeKatex]}>
                              {msg.content}
                            </ReactMarkdown>
                          </div>
                          
                          {isLoading && msg.role === "ai" && !msg.content && (
                            <span style={{ color: "#888", fontSize: "0.9em" }}>考え中...</span>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                  <div ref={(el) => {messagesEndRefs.current[thread.id] = el}} style={{ scrollMarginTop: "60px", scrollMarginBottom: "20px" }} />
                </div>

                {/* 2. このスレッド専用の入力エリア */}
                <div 
                    className="chat-input-area" 
                    style={{ 
                      padding: "12px", 
                      borderTop: "1px solid #eee", 
                      background: "#fff", 
                      position: "relative", 
                      borderBottomLeftRadius: "7px", 
                      borderBottomRightRadius: "7px",
                      scrollMarginTop: "60px"
                    }}
                  >
                  {isLoading && activeThreadId === thread.id && (
                    <div style={{ display: "flex", justifyContent: "center", marginBottom: "10px" }}>
                      <button onClick={stopGeneration} style={{ background: "#d32f2f", color: "white", border: "none", padding: "6px 12px", borderRadius: "15px", cursor: "pointer", boxShadow: "0 2px 5px rgba(0,0,0,0.2)", fontSize: "0.85em", fontWeight: "bold" }}>⏹️ 中断</button>
                    </div>
                  )}

                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <input 
                      type="text" 
                      value={activeThreadId === thread.id ? inputText : ""}
                      onChange={(e) => {
                        setInputText(e.target.value);
                        setActiveThreadId(thread.id);
                      }}
                      onKeyDown={(e) => { 
                        if (e.key === "Enter" && e.shiftKey) { 
                          e.preventDefault(); 
                          askAgent("qa", thread.id, undefined, inputText); 
                        } 
                      }}
                      placeholder="このスレッドで質問... (Shift+Enter)"
                      disabled={isLoading}
                      style={{ width: "100%", padding: "10px", borderRadius: "4px", border: "1px solid #ccc", fontSize: "0.9em", boxSizing: "border-box" }}
                    />
                    
                    <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                      <button 
                        onClick={() => askAgent("qa", thread.id, undefined, inputText)}
                        disabled={isLoading || (activeThreadId === thread.id && !inputText.trim())}
                        style={{ padding: "8px 12px", background: "#0d47a1", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "0.85em", whiteSpace: "nowrap" }}
                      >💬 送信</button>
                      
                      <button 
                        onClick={() => askAgent("math", thread.id, undefined, inputText)}
                        disabled={isLoading || (activeThreadId === thread.id && !inputText.trim())}
                        style={{ padding: "8px 12px", background: "#e65100", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "0.85em", whiteSpace: "nowrap" }}
                      >📐 Math送信</button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
        </div>
      </div>
      {/* フローティングメニュー */}
      {menuPos && (selectedText || croppedImage) && (
        <div style={{
          position: "absolute", 
          left: menuPos.x > window.innerWidth - 250 ? "auto" : menuPos.x + 15,
          right: menuPos.x > window.innerWidth - 250 ? window.innerWidth - menuPos.x + 15 : "auto",
          
          top: menuPos.y > window.innerHeight - 250 ? "auto" : menuPos.y + 15,
          bottom: menuPos.y > window.innerHeight - 250 ? window.innerHeight - menuPos.y + 15 : "auto",
          
          zIndex: 1000, 
          background: "white", 
          padding: "15px",
          borderRadius: "8px", 
          boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
          border: "1px solid #ddd", 
          display: "flex", 
          flexDirection: "column", 
          gap: "10px",
          minWidth: "220px",
          // 念のためメニュー自体が大きすぎた時のスクロール対応
          maxHeight: "80vh",
          overflowY: "auto"
        }}>
          {/* 送信先スレッドの選択 */}
          <div style={{ fontSize: "0.85em", color: "#555", fontWeight: "bold" }}>送信先:</div>
          <select
            value={selectedTargetThread}
            onChange={(e) => setSelectedTargetThread(e.target.value)}
            style={{ padding: "6px", borderRadius: "4px", border: "1px solid #aaa", fontSize: "0.9em", width: "100%", cursor: "pointer", background: "#f8f9fa" }}
          >
            <option value="new">✨ 新規スレッドを作成</option>
            <option disabled>──────────</option>
            {threads.map(t => (
              <option key={t.id} value={t.id}>{t.isMain ? "📌 " : ""}{t.title}</option>
            ))}
          </select>

          {/* アクションボタン群 */}
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "5px" }}>
            {/* 🌟 階層1: ルートメニュー（最初に出る画面） */}
            {menuCategory === "root" && (
              <>
                <button onClick={() => setMenuCategory("qa")} style={{ flex: 1, padding: "8px", background: "#0d47a1", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "0.85em", fontWeight: "bold", whiteSpace: "nowrap" }}>💬 テキスト分析</button>
                <button onClick={() => setMenuCategory("math")} style={{ flex: 1, padding: "8px", background: "#e65100", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "0.85em", fontWeight: "bold", whiteSpace: "nowrap" }}>📐 数式・図表解析</button>
                {/* 引用調査はアクションが1つなので、そのまま直接実行させる */}
                <button onClick={() => handleMenuAction("citation", "citation")} style={{ flex: 1, padding: "8px", background: "#2e7d32", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "0.85em", fontWeight: "bold", whiteSpace: "nowrap" }}>📚 引用を調査</button>
              </>
            )}
            {/* 🌟 階層2: テキスト分析（QA）のサブメニュー */}
            {menuCategory === "qa" && (
              <>
                <button onClick={() => setMenuCategory("root")} style={{ padding: "8px", background: "#f1f3f4", color: "#5F6368", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "0.85em", fontWeight: "bold" }}>◀ 戻る</button>
                <button onClick={() => handleMenuAction("qa", "explain")} style={{ flex: 1, padding: "8px", background: "#e3f2fd", color: "#0d47a1", border: "1px solid #90caf9", borderRadius: "4px", cursor: "pointer", fontSize: "0.85em", fontWeight: "bold" }}>📖 基本解説</button>
                <button onClick={() => handleMenuAction("qa", "intent")} style={{ flex: 1, padding: "8px", background: "#e3f2fd", color: "#0d47a1", border: "1px solid #90caf9", borderRadius: "4px", cursor: "pointer", fontSize: "0.85em", fontWeight: "bold" }}>🎯 著者の意図</button>
                <button onClick={() => handleMenuAction("qa", "example")} style={{ flex: 1, padding: "8px", background: "#e3f2fd", color: "#0d47a1", border: "1px solid #90caf9", borderRadius: "4px", cursor: "pointer", fontSize: "0.85em", fontWeight: "bold" }}>💡 具体例</button>
                <button onClick={() => handleMenuAction("qa", "summarize")} style={{ flex: 1, padding: "8px", background: "#e3f2fd", color: "#0d47a1", border: "1px solid #90caf9", borderRadius: "4px", cursor: "pointer", fontSize: "0.85em", fontWeight: "bold" }}>📝 要約</button>
                <button onClick={() => handleMenuAction("qa", "evidence")} style={{ flex: 1, padding: "8px", background: "#e3f2fd", color: "#0d47a1", border: "1px solid #90caf9", borderRadius: "4px", cursor: "pointer", fontSize: "0.85em", fontWeight: "bold" }}>🔎 根拠・前提</button>
              </>
            )}
            {/* 🌟 階層2: 数式解析（Math）のサブメニュー */}
            {menuCategory === "math" && (
              <>
                <button onClick={() => setMenuCategory("root")} style={{ padding: "8px", background: "#f1f3f4", color: "#5F6368", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "0.85em", fontWeight: "bold" }}>◀ 戻る</button>
                <button onClick={() => handleMenuAction("math", "explain")} style={{ flex: 1, padding: "8px", background: "#fff3e0", color: "#e65100", border: "1px solid #ffb74d", borderRadius: "4px", cursor: "pointer", fontSize: "0.85em", fontWeight: "bold" }}>❓ 式の意味</button>
                <button onClick={() => handleMenuAction("math", "derivation")} style={{ flex: 1, padding: "8px", background: "#fff3e0", color: "#e65100", border: "1px solid #ffb74d", borderRadius: "4px", cursor: "pointer", fontSize: "0.85em", fontWeight: "bold" }}>🔄 式の導出</button>
              </>
            )}
          </div>
          
          {/* メニューを閉じるボタン（選択解除） */}
          <div style={{ textAlign: "right", marginTop: "5px" }}>
             <span onClick={() => {setMenuPos(null); setMenuCategory("root");}} style={{ fontSize: "0.8em", color: "#888", cursor: "pointer", textDecoration: "underline" }}>キャンセル</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;