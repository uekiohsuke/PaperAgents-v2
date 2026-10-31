import { useState, useRef, useEffect, useCallback } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import './App.css';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import remarkBreaks from 'remark-breaks';
import ForceGraph2D from 'react-force-graph-2d';

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
  taskType?: "qa" | "math" | "citation" | "chart" | "code";
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

type TranslationVocab = {
  id: string;
  original: string;
  translated: string;
  page: number;
  terms: { term: string; description: string }[];
};

type GraphNode = {
  id: string;
  title: string;
  type: "loaded" | "unloaded"; // 読み込み済みか、参考文献リストに載っているだけか
  isPinned?: boolean; // 🌟 追加
  group?: string;
  val: number; // ノードの大きさ（被引用数など）
  fileName?: string;
  localCitationCount?: number;
  oaStatus?: "unchecked" | "checking" | "open" | "closed";
  docType?: "pdf" | "web" | "unknown";
};

type GraphLink = {
  source: string;
  target: string;
};

type ViewMode = "reader" | "network";

type NetworkDisplayMode = "graph" | "list";

// バックエンドがSSEで送る {status: "error"} イベントを、通信エラーと区別して表示するための例外
const agentError = (message: string) => {
  const error = new Error(`エージェントでエラーが発生しました: ${message}`);
  error.name = "AgentError";
  return error;
};

function App() {
  // PDFファイルstate
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState<boolean>(false);

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
  const [menuCategory, setMenuCategory] = useState<"root" | "qa" | "math" | "chart">("root");
  const [selectedTargetThread, setSelectedTargetThread] = useState<string>("main-thread");

  const [activeTab, setActiveTab] = useState<"toc" | "refs" | "trans">("toc"); // タブ切り替え用
  const [references, setReferences] = useState<{ [key: string]: string }>({}); // 参考文献データ

  // ペイン幅とリサイズ状態を管理
  const [agentPaneWidth, setAgentPaneWidth] = useState<number>(400);
  const [leftPaneWidth, setLeftPaneWidth] = useState<number>(320); // 左ペインの初期幅を少し広めに設定
  const isResizingRightRef = useRef<boolean>(false); // 右側のドラッグ判定
  const isResizingLeftRef = useRef<boolean>(false);  // 左側のドラッグ判定

  const isDraggingPopupRef = useRef<boolean>(false);
  const popupDragOffsetRef = useRef<{ x: number, y: number }>({ x: 0, y: 0 });

  // 各文献のOAステータスを保持する辞書
  const [oaStatuses, setOaStatuses] = useState<{ [refNum: string]: any }>({});

  // 各引用番号が出現するページ番号の配列
  const [citationPages, setCitationPages] = useState<{ [key: string]: number[] }>({});

  // 通信のキャンセルを管理するコントローラー
  const abortControllerRef = useRef<AbortController | null>(null);

  const [vocabList, setVocabList] = useState<TranslationVocab[]>([]);
  const [translationPopup, setTranslationPopup] = useState<{ text: string; pos: { x: number; y: number } } | null>(null);

  const [codePopup, setCodePopup] = useState<{ 
    text: string; 
    code: string; 
    threadId: string;
    previewImage?: string | null;
    isPreviewLoading?: boolean;
    previewError?: string | null;
  } | null>(null);
  const [codeFeedback, setCodeFeedback] = useState("");

  const [isAddingToc, setIsAddingToc] = useState(false);
  const [newTocTitle, setNewTocTitle] = useState("");
  const [newTocPage, setNewTocPage] = useState("");
  const [newTocLevel, setNewTocLevel] = useState("1");

  const [isAddingRef, setIsAddingRef] = useState(false);
  const [newRefNum, setNewRefNum] = useState("");
  const [newRefText, setNewRefText] = useState("");

  const [pdfFilesMap, setPdfFilesMap] = useState<{ [key: string]: File }>({});

  const [viewMode, setViewMode] = useState<ViewMode>("reader"); // 表示モード切り替え

  const [networkDisplayMode, setNetworkDisplayMode] = useState<NetworkDisplayMode>("graph");

  const [globalGraph, setGlobalGraph] = useState<any>(() => {
    const saved = localStorage.getItem("personal_citation_graph");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        
        // リンクにオブジェクトが混ざっていたら、文字列IDに戻す（浄化）
        const cleanLinks = (parsed.links || []).map((l: any) => ({
          ...l,
          source: typeof l.source === 'object' ? l.source.id : l.source,
          target: typeof l.target === 'object' ? l.target.id : l.target
        }));
        
        // ノードの重複も排除して安全にロードする
        const uniqueNodes = Array.from(new Map((parsed.nodes || []).map((n: any) => [n.id, n])).values());
        
        return { nodes: uniqueNodes, links: cleanLinks };
      } catch (e) {
        return { nodes: [], links: [] };
      }
    }
    return { nodes: [], links: [] };
  });

  // 🌟 追加: フィルターとソートのState
  const [filterStatus, setFilterStatus] = useState<"all" | "unchecked" | "checked" | "oa_open">("all");
  const [filterType, setFilterType] = useState<"all" | "pdf" | "web">("all");
  const [sortBy, setSortBy] = useState<"citation" | "title">("citation");

// 🌟 修正: 親ノードはグラフの基準点なので、フィルタに関わらず常に表示する
  const getProcessedNodes = useCallback((sourceNodes: any[]) => {
    return sourceNodes
      .filter(node => {
        // 🌟 追加: 親（既読）なら無条件で表示
        if (node.type === "loaded") return true; 

        const status = node.oaStatus || "unchecked";
        const type = node.docType || "unknown";

        // 1. 状態（OA）フィルター
        if (filterStatus === "unchecked" && status !== "unchecked") return false;
        if (filterStatus === "checked" && (status === "unchecked" || status === "checking")) return false;
        if (filterStatus === "oa_open" && status !== "open") return false;
        
        // 2. ドキュメント種類フィルター
        if (filterType === "pdf" && type !== "pdf") return false;
        if (filterType === "web" && type !== "web") return false;

        return true;
      })
      .sort((a, b) => {
        if (sortBy === "citation") {
          return (b.localCitationCount || 0) - (a.localCitationCount || 0);
        } else {
          return a.title.localeCompare(b.title);
        }
      });
  }, [filterStatus, filterType, sortBy]);

  const fgRef = useRef<any>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const [graphDim, setGraphDim] = useState({ width: 800, height: 600 });

  const [selectedNode, setSelectedNode] = useState<any>(null);
  const [nodeOaInfo, setNodeOaInfo] = useState<any>(null);
  const [isFetchingOa, setIsFetchingOa] = useState(false);

  const [pinnedNodeIds, setPinnedNodeIds] = useState<string[]>(() => {
    const saved = localStorage.getItem("pinned_nodes");
    return saved ? JSON.parse(saved) : [];
  });

  const [isConfirmingReset, setIsConfirmingReset] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [graphHistory, setGraphHistory] = useState<any[]>([]);

  const pendingNodeIdRef = useRef<string | null>(null);

  // 🌟 追加: グローバル（ネットワーク）用チャットのState
  const [isGlobalChatOpen, setIsGlobalChatOpen] = useState(false);
  const [globalInputText, setGlobalInputText] = useState("");
  const [globalMessages, setGlobalMessages] = useState<Message[]>([]);

  const triggerPdfUpload = (nodeId: string | null = null) => {
    pendingNodeIdRef.current = nodeId; // クリックした瞬間に確実に記憶させる
    document.getElementById('network-pdf-upload')?.click();
  };

  useEffect(() => {
    localStorage.setItem("pinned_nodes", JSON.stringify(pinnedNodeIds));
  }, [pinnedNodeIds]);

  useEffect(() => {
    if (viewMode === "network" && containerRef.current) {
      const observer = new ResizeObserver(entries => {
        if (entries[0]) {
          const { width, height } = entries[0].contentRect;
          setGraphDim({ width, height });
        }
      });
      observer.observe(containerRef.current);
      return () => observer.disconnect();
    }
  }, [viewMode]);

  useEffect(() => {
    if (fgRef.current) {
      // 反発力を弱める (デフォルト -30, 前は -300 だったのを -120 に)
      fgRef.current.d3Force('charge').strength(-120);
      // リンクの距離を少し長めに保つ
      fgRef.current.d3Force('link').distance(80);
      // 中央へ引き戻す力（重力）を少し強める
      fgRef.current.d3Force('center').strength(0.05);
    }
  }, [globalGraph]);

  // グラフが更新されるたびに保存
  useEffect(() => {
    const cleanLinks = globalGraph.links.map((l: any) => ({
      ...l,
      source: typeof l.source === 'object' ? l.source.id : l.source,
      target: typeof l.target === 'object' ? l.target.id : l.target
    }));
    
    localStorage.setItem("personal_citation_graph", JSON.stringify({ nodes: globalGraph.nodes, links: cleanLinks }));
  }, [globalGraph]);

  const saveHistory = useCallback(() => {
    setGlobalGraph((prev: any) => {
      // D3の循環参照（オブジェクト化されたリンク）を浄化して安全にコピーする
      const cleanNodes = prev.nodes.map((n: any) => ({ ...n }));
      const cleanLinks = prev.links.map((l: any) => ({
        ...l,
        source: typeof l.source === 'object' ? l.source.id : l.source,
        target: typeof l.target === 'object' ? l.target.id : l.target
      }));
      setGraphHistory(history => [...history, { nodes: cleanNodes, links: cleanLinks }].slice(-10));
      return prev;
    });
  }, []);

  const undoAction = useCallback(() => {
    setGraphHistory(prev => {
      if (prev.length === 0) return prev;
      const newHistory = [...prev];
      const previousState = newHistory.pop();
      if (previousState) {
        setGlobalGraph(previousState);
        setSelectedNode(null); // 選択状態はリセットする
      }
      return newHistory;
    });
  }, []);

  const unloadPdf = useCallback((nodeId: string) => {
    saveHistory();
    setGlobalGraph((prev: any) => {
      const nodes = [...prev.nodes];
      const links = [...prev.links];
      const targetIdx = nodes.findIndex((n: any) => n.id === nodeId);
      if (targetIdx >= 0) {
        nodes[targetIdx].type = "unloaded";
        nodes[targetIdx].val = 5;
      }
      return { nodes, links };
    });
    setSelectedNode((prev: any) => prev && prev.id === nodeId ? { ...prev, type: "unloaded", val: 5 } : prev);
  }, [saveHistory]);

// 🌟 修正: URLの実データもノードに記録する
  const updateNodeOaStatus = useCallback((nodeId: string, data: any) => {
    setGlobalGraph((prev: any) => {
      const nodes = [...prev.nodes];
      const idx = nodes.findIndex((n: any) => n.id === nodeId);
      if (idx >= 0) {
        let docType = "unknown";
        let oaStatus = "checked";
        
        if (data.url) {
          oaStatus = "open";
          if (data.url.toLowerCase().endsWith('.pdf')) docType = "pdf";
          else docType = "web";
        }
        
        // 🌟 追加: url, scholar_url, cinii_url を保存データに含める
        nodes[idx] = { 
          ...nodes[idx], 
          oaStatus, 
          docType,
          url: data.url,
          scholar_url: data.scholar_url,
          cinii_url: data.cinii_url
        };
      }

      const cleanLinks = prev.links.map((l: any) => ({
        ...l,
        source: typeof l.source === 'object' ? l.source.id : l.source,
        target: typeof l.target === 'object' ? l.target.id : l.target
      }));

      return { nodes, links: cleanLinks };
    });
  }, []);

  // 🌟 修正: グラフを一切触らず、純粋にリストのIDだけを追加・削除する
  const togglePin = useCallback((nodeId: string) => {
    setPinnedNodeIds(prev => {
      if (prev.includes(nodeId)) {
        return prev.filter(id => id !== nodeId); // すでにあれば外す
      } else {
        return [...prev, nodeId]; // なければ追加する
      }
    });
  }, []);

  // 🌟 グラフの結合ロジック
  const mergeToGlobalGraph = (fileName: string, references: { [key: string]: string }, citationPagesData: { [key: string]: number[] } = {}) => {
    // 1. 実行前に確実に ID を確保し、Refをクリア
    const targetId = pendingNodeIdRef.current;
    pendingNodeIdRef.current = null;

    setGlobalGraph((prev: any) => {
      // 履歴を保存
      const cleanNodesForHistory = prev.nodes.map((n: any) => ({ ...n }));
      const cleanLinksForHistory = prev.links.map((l: any) => ({
        ...l,
        source: typeof l.source === 'object' ? l.source.id : l.source,
        target: typeof l.target === 'object' ? l.target.id : l.target
      }));
      setGraphHistory(history => [...history, { nodes: cleanNodesForHistory, links: cleanLinksForHistory }].slice(-10));

      const nodes = [...prev.nodes];
      const links = [...prev.links];

      // 2. 更新対象の検索（実体化 ID があれば優先、なければファイル名）
      const existingIdx = nodes.findIndex(n => (targetId && n.id === targetId) || n.id === fileName);

      let activeNodeId = fileName;

      if (existingIdx >= 0) {
        activeNodeId = nodes[existingIdx].id; 
        
        // 🌟 重要: オブジェクトをスプレッド構文で新しく作り直す（これでReactが検知できる）
        nodes[existingIdx] = { 
          ...nodes[existingIdx],
          title: fileName,
          type: "loaded",
          val: 10,
          fileName: fileName
        };
      } else {
        // 新規追加
        nodes.push({ id: fileName, title: fileName, type: "loaded", val: 10, fileName: fileName });
      }

      // 3. 参考文献の追加とリンク生成
      Object.entries(references).forEach(([refNum, refText]) => {
        const refId = refText.substring(0, 100); 
        const citationCount = citationPagesData[refNum] ? citationPagesData[refNum].length : 1;
        if (!nodes.find(n => n.id === refId)) {
          // 親ノードの近くに配置するための座標計算
          let startPos = {};
          if (existingIdx >= 0 && nodes[existingIdx].x !== undefined) {
            startPos = {
              x: nodes[existingIdx].x + (Math.random() * 20 - 10),
              y: nodes[existingIdx].y + (Math.random() * 20 - 10)
            };
          }
          nodes.push({ 
            id: refId, 
            title: refText, 
            type: "unloaded", 
            val: Math.max(5, citationCount * 3), // 引力（大きさ）
            localCitationCount: citationCount,
            oaStatus: "unchecked",
            docType: "unknown",
            ...startPos 
          });
        }
        
        const linkExists = links.find(l => {
          const sId = typeof l.source === 'object' ? l.source.id : l.source;
          const tId = typeof l.target === 'object' ? l.target.id : l.target;
          return sId === activeNodeId && tId === refId;
        });

        if (!linkExists) {
          links.push({ source: activeNodeId, target: refId });
        }
      });

      return { nodes, links };
    });
  };

  // 🌟 追加: 特定のPDFとその引用関係をネットワークから削除する
  const deletePdfFromGraph = useCallback((pdfName: string) => {
    saveHistory();
    setGlobalGraph((prev: any) => {
      // 1. まず、そのPDF自体のノードを除外する
      const newNodes = prev.nodes.filter((n: any) => n.id !== pdfName);

      // 2. そのPDFに繋がっていた全てのリンク（線）を除外する
      // D3がオブジェクト化している可能性を考慮して判定
      const newLinks = prev.links.filter((l: any) => {
        const sId = typeof l.source === 'object' ? l.source.id : l.source;
        const tId = typeof l.target === 'object' ? l.target.id : l.target;
        return sId !== pdfName && tId !== pdfName;
      });

      // 3. 🌟 お掃除ロジック: 
      // 他に繋がっている「既読PDF」が一つもない「未読ノード」を削除して、グラフを綺麗にする
      const finalNodes = newNodes.filter((n: any) => {
        if (n.type === "loaded") return true; // 既読PDFは残す
        
        // この未読ノードが、残ったリンクのどこかに登場しているか確認
        return newLinks.some((l: any) => {
          const sId = typeof l.source === 'object' ? l.source.id : l.source;
          const tId = typeof l.target === 'object' ? l.target.id : l.target;
          return sId === n.id || tId === n.id;
        });
      });

      // 詳細パネルを閉じる
      setSelectedNode(null);
      
      return { nodes: finalNodes, links: newLinks };
    });
  }, []);

// 🌟 修正: クリック時に保存しておいたURLデータを取り出す
  const handleNodeClick = useCallback((node: any) => {
    setSelectedNode(node);
    
    if (node.oaStatus && node.oaStatus !== "unchecked" && node.oaStatus !== "checking") {
      setNodeOaInfo({
        status: node.oaStatus === "open" ? (node.docType === "pdf" ? "✅ PDFあり" : "🌐 Web記事あり") : "❌ アクセス不可",
        color: node.oaStatus === "open" ? (node.docType === "pdf" ? "green" : "blue") : "gray",
        // 🌟 追加: 記録しておいたURL情報をセットする
        url: node.url,
        scholar_url: node.scholar_url,
        cinii_url: node.cinii_url
      });
    } else {
      setNodeOaInfo(null);
    }
  }, []);

  // 🌟 追加: ネットワーク画面から既読PDFをReaderで開き直す関数
  const handleSwitchPdf = useCallback((node: any) => {
    // ノードに刻まれた fileName（なければid）を使ってファイルを探す
    const targetFileName = node.fileName || node.id;
    const file = pdfFilesMap[targetFileName];
    
    if (!file) {
      alert("このファイルのデータがメモリ上にありません。\n（ブラウザをリロードするとメモリは消去されます。お手数ですが再度アップロードしてください）");
      return;
    }

    if (pdfUrl) URL.revokeObjectURL(pdfUrl);

    // 🌟 そのPDF用のチャット履歴を復元する
    const savedThreads = localStorage.getItem(`pdf_threads_${file.name}`);
    if (savedThreads) {
      setThreads(JSON.parse(savedThreads));
    } else {
      setThreads([{ id: "main-thread", title: "メインスレッド", isMain: true, isCollapsed: false, messages: [] }]);
    }

    setActiveThreadId("main-thread");
    setSelectedText("");
    setCroppedImage(null);
    setMenuPos(null);

    // ファイルをセットしてReaderモードへ遷移！
    setPdfFile(file);
    setPdfUrl(URL.createObjectURL(file));
    setViewMode("reader");
  }, [pdfFilesMap, pdfUrl]);

  const handleFocusNode = useCallback((node: any) => {
    // 🌟 修正: 座標が確定していなくても、詳細パネルは必ず開く
    setSelectedNode(node); 
    setNodeOaInfo(null); // 前の情報をクリア

    if (fgRef.current && node.x !== undefined && node.y !== undefined) {
      // ノードの場所へスムーズに移動
      fgRef.current.centerAt(node.x, node.y, 1000);
      fgRef.current.zoom(3, 1000);
    }
  }, [fgRef]);

  // 🌟 追加: ネスト式リストの描画
  const renderNestedList = () => {
    // 1. まず「既読PDF（loaded）」を親として抽出
    const parentNodes = globalGraph.nodes.filter((n: any) => n.type === "loaded");

    return (
      <div style={{ padding: "20px 40px 40px 320px", color: "var(--text-main)", overflowY: "auto", height: "100%" }}>
        <h3 style={{ fontSize: "1.1em", marginBottom: "20px", borderBottom: "2px solid var(--border-light)", paddingBottom: "10px" }}>
          📂 論文の階層構造（引用ツリー）
        </h3>
        {parentNodes.map((parent: any) => {
          // 2. この親から伸びているリンクを探し、その先のノード（子）を特定
          const childIds = globalGraph.links
            .filter((l: any) => (typeof l.source === 'object' ? l.source.id : l.source) === parent.id)
            .map((l: any) => (typeof l.target === 'object' ? l.target.id : l.target));
          
          const rawChildren = globalGraph.nodes.filter((n: any) => childIds.includes(n.id));
          const children = getProcessedNodes(rawChildren);

          return (
            <div key={parent.id} style={{ marginBottom: "16px", background: "var(--bg-panel)", borderRadius: "var(--radius-md)", border: "1px solid var(--border-light)", overflow: "hidden" }}>
              {/* 親ノード行 */}
              <div 
                onClick={() => handleFocusNode(parent)}
                style={{ padding: "10px 15px", background: "var(--bg-hover)", cursor: "pointer", display: "flex", alignItems: "center", gap: "10px", fontWeight: "bold" }}
              >
                <span>🔵</span>
                <span style={{ flex: 1 }}>{parent.title}</span>
                <span style={{ fontSize: "0.8em", color: "var(--text-muted)" }}>({children.length} citations)</span>
              </div>
              
              {/* 子ノード（参考文献）リスト */}
              <div style={{ padding: "4px 0 4px 35px" }}>
                {children.map((child: any) => (
                  <div 
                    key={child.id} 
                    onClick={() => handleFocusNode(child)}
                    style={{ padding: "6px 12px", fontSize: "0.9em", borderLeft: "1px solid var(--border-light)", cursor: "pointer", transition: "background 0.2s", display: "flex", alignItems: "center", gap: "8px" }}
                    onMouseEnter={e => e.currentTarget.style.background = "var(--bg-hover)"}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                  >
                    <span style={{ color: child.type === "loaded" ? "#1976d2" : "#9ca3af" }}>
                      {child.type === "loaded" ? "●" : "○"}
                    </span>
                    <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {child.title}
                    </span>
                  </div>
                ))}
                {children.length === 0 && (
                  <div style={{ padding: "8px 12px", fontSize: "0.85em", color: "var(--text-muted)", fontStyle: "italic" }}>引用データなし</div>
                )}
              </div>
            </div>
          );
        })}
        {parentNodes.length === 0 && (
          <div style={{ textAlign: "center", marginTop: "50px", color: "var(--text-muted)" }}>
            まだ読み込まれたPDFがありません。
          </div>
        )}
      </div>
    );
  };

  const handleCheckNodeOa = async () => {
    if (!selectedNode || !selectedNode.title) return;
    setIsFetchingOa(true);
    try {
      const res = await fetch("http://127.0.0.1:8000/api/check_oa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw_citation: selectedNode.title }) // タイトルを投げてOA判定
      });
      const data = await res.json();
      setNodeOaInfo(data);
      updateNodeOaStatus(selectedNode.id, data);
    } catch (error) {
      console.error("OAステータス取得エラー:", error);
      setNodeOaInfo({ status: "取得エラー", color: "gray" });
    } finally {
      setIsFetchingOa(false);
    }
  };

  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    return localStorage.getItem("theme") === "dark";
  });

  // 🌟 追加: isDarkMode が切り替わるたびに HTML の属性を書き換え、保存する
  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.setAttribute("data-theme", "dark");
      localStorage.setItem("theme", "dark");
    } else {
      document.documentElement.removeAttribute("data-theme");
      localStorage.setItem("theme", "light");
    }
  }, [isDarkMode]);

  // 🌟 追加: コピー完了のフィードバック用State
  const [copiedThreadId, setCopiedThreadId] = useState<string | null>(null);

  // 🌟 追加: スレッドをMarkdown形式でクリップボードにコピーする関数
  const handleCopyThread = (threadId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // アコーディオンの開閉を防ぐ
    const thread = threads.find(t => t.id === threadId);
    if (!thread) return;

    // Markdownの組み立て
    let mdContent = `# ${thread.title}\n\n`;
    
    thread.messages.forEach(msg => {
      if (msg.role === "user") {
        mdContent += `### 👤 質問・メモ\n${msg.content}\n\n`;
        // 参照したテキストがあれば引用ブロックとして追加
        if (msg.sourceText) {
          const pageStr = msg.sourcePage ? ` (P.${msg.sourcePage})` : "";
          mdContent += `> 📝 引用元${pageStr}:\n> ${msg.sourceText.replace(/\n/g, "\n> ")}\n\n`;
        }
      } else {
        mdContent += `### 🤖 エージェント\n${msg.content}\n\n`;
      }
      mdContent += `---\n\n`; // メッセージ間の区切り線
    });

    // クリップボードに書き込み
    navigator.clipboard.writeText(mdContent).then(() => {
      setCopiedThreadId(threadId);
      // 2秒後に「コピー完了」の表示を元に戻す
      setTimeout(() => setCopiedThreadId(null), 2000);
    }).catch(err => {
      console.error("クリップボードへのコピーに失敗しました", err);
      alert("コピーに失敗しました。");
    });
  };

// 🌟 追加: ファイルをバックエンドに送信し、解析結果を受け取る
  const handleFileUpload = async (file: File) => {
    setPdfFilesMap(prev => ({ ...prev, [file.name]: file }));

    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    
    // 保存されたスレッド履歴を復元、なければ初期化
    const savedThreads = localStorage.getItem(`pdf_threads_${file.name}`);
    if (savedThreads) {
      setThreads(JSON.parse(savedThreads));
    } else {
      setThreads([{ id: "main-thread", title: "メインスレッド", isMain: true, isCollapsed: false, messages: [] }]);
    }
    
    setActiveThreadId("main-thread");
    setOaStatuses({});
    setSelectedText("");
    setCroppedImage(null);
    setMenuPos(null);

    setIsUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    
    try {
      const res = await fetch("http://127.0.0.1:8000/api/upload", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (data.references) {
        mergeToGlobalGraph(file.name, data.references, data.citation_pages);
      }
      
      // 🌟 変更: Pythonのフォーマット [level, title, page_num] をフロントエンド用にマッピングして「仮セット」する
      const fallbackOutline = (data.toc || []).map((item: any[]) => ({
        title: item[1], // "1 はじめに" などの文字列
        dest: item[2],  // ページ番号
        level: item[0]  // インデント表示などに使える階層レベル
      }));
      setOutline(fallbackOutline); // ※State名が setToc の場合は setToc にしてください
      
      // 参考文献とページ情報のセット
      setReferences(data.references || {});
      setCitationPages(data.citation_pages || {});
      
      setPdfFile(file);
      setPdfUrl(URL.createObjectURL(file));
      setViewMode("reader");
      
    } catch (error) {
      console.error("アップロードエラー:", error);
      alert("PDFの解析に失敗しました。");
    } finally {
      setIsUploading(false);
    }
  };

async function onDocumentLoadSuccess(pdf: any) {
    setNumPages(pdf.numPages);
    
    try {
      // PDFネイティブの目次メタデータを取得
      const outlineData = await pdf.getOutline();
      
      if (outlineData && outlineData.length > 0) {
        console.log("🌟 PDFネイティブの目次を検出しました。バックエンドの目次を上書きします。");
        // ネイティブ目次があれば、handleFileUpload でセットしたバックエンドの目次を上書きする
        setOutline(outlineData); 
      } else {
        console.log("ℹ️ PDFに目次メタデータがありません。バックエンドの抽出結果をそのまま使用します。");
        // ※何もしない（handleFileUpload でセットした fallbackOutline がそのまま使われる）
      }
    } catch (error) {
      console.error("目次の抽出に失敗しました:", error);
    }
  }

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

// 🌟 追加: サブスレッドを要約してメインスレッドに引き継ぐ処理
  const handleMergeToMain = async (threadId: string) => {
    const thread = threads.find(t => t.id === threadId);
    if (!thread || thread.messages.length === 0) return;

    // UIを少し変えて待機状態にする（簡易的な実装）
    const originalTitle = thread.title;
    setThreads(prev => prev.map(t => t.id === threadId ? { ...t, title: "⏳ 要約中..." } : t));

    try {
      const res = await fetch("http://127.0.0.1:8000/api/summarize_thread", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: thread.messages })
      });
      const data = await res.json();

      // メインスレッドに「ユーザーからのコンテキストメモ」として追加
      setThreads(prev => prev.map(t => {
        if (t.id === "main-thread") {
          return {
            ...t,
            messages: [...t.messages, {
              id: Date.now().toString(),
              role: "user",
              content: `【💡 スレッド「${originalTitle}」からの引き継ぎメモ】\n${data.summary}`
            }]
          };
        }
        if (t.id === threadId) return { ...t, title: originalTitle }; // タイトルを戻す
        return t;
      }));

      // メインスレッドにフォーカスを移す
      setActiveThreadId("main-thread");
      
    } catch (error) {
      console.error("要約失敗", error);
      setThreads(prev => prev.map(t => t.id === threadId ? { ...t, title: originalTitle } : t));
    }
  };

  // 🌟 追加: threadsが更新されるたびに、現在のPDF名をキーにしてローカル保存
  useEffect(() => {
    if (pdfFile && threads.length > 0) {
      localStorage.setItem(`pdf_threads_${pdfFile.name}`, JSON.stringify(threads));
    }
  }, [threads, pdfFile]);

  // ペイン幅をマウスドラッグで変更する処理
// 🌟 修正: ペイン幅をマウスドラッグで変更する処理（左右対応版）
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      // ▼ 右ペインのリサイズ処理
      if (isResizingRightRef.current) {
        const newWidth = window.innerWidth - e.clientX;
        if (newWidth > 300 && newWidth < window.innerWidth * 0.6) setAgentPaneWidth(newWidth);
      }
      
      // ▼ 左ペインのリサイズ処理
      if (isResizingLeftRef.current) {
        const newWidth = e.clientX; 
        if (newWidth > 240 && newWidth < window.innerWidth * 0.4) setLeftPaneWidth(newWidth);
      }

      // ▼ 🌟 追加: ポップアップのドラッグ移動処理
      if (isDraggingPopupRef.current) {
        setTranslationPopup(prev => {
          if (!prev) return prev;
          return {
            ...prev,
            pos: {
              x: e.clientX - popupDragOffsetRef.current.x,
              y: e.clientY - popupDragOffsetRef.current.y
            }
          };
        });
      }
    };

    const handleMouseUp = () => {
      if (isResizingRightRef.current || isResizingLeftRef.current || isDraggingPopupRef.current) {
        isResizingRightRef.current = false;
        isResizingLeftRef.current = false;
        isDraggingPopupRef.current = false; // 🌟 追加
        document.body.style.cursor = 'default';
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // 🌟 追加: 目次を手動で追加
  const handleAddToc = () => {
    if (!newTocTitle || !newTocPage) return;

    const newItem = {
      title: newTocTitle,
      dest: parseInt(newTocPage),
      level: parseInt(newTocLevel) || 1
    };

    setOutline(prev => {
      // 1. 新しい項目を含めた新しい配列を作成
      const updated = [...prev, newItem];

      // 2. ページ番号(dest)に基づいて昇順にソート
      updated.sort((a, b) => {
        // destが配列（ネイティブ）か数値（手動/フォールバック）かを判定してページ番号を取得
        const getPageNum = (dest: any) => {
          if (Array.isArray(dest)) return dest[0]; // pdf.jsの形式
          if (typeof dest === 'number') return dest; // 手動追加の形式
          return 0;
        };

        return getPageNum(a.dest) - getPageNum(b.dest);
      });

      return updated;
    });

    // 入力フォームをリセット
    setNewTocTitle("");
    setNewTocPage("");
    setNewTocLevel("1");
    setIsAddingToc(false);
  };

  // 🌟 追加: 引用を手動で追加
  const handleAddRef = () => {
    if (!newRefNum || !newRefText) return;
    // 参考文献はオブジェクト（連想配列）なのでキーを追加
    setReferences(prev => ({
      ...prev,
      [newRefNum]: newRefText
    }));
    setNewRefNum("");
    setNewRefText("");
    setIsAddingRef(false);
  };

  // 🌟 追加: 目次の項目を削除
  const handleDeleteToc = (indexToRemove: number, e: React.MouseEvent) => {
    e.stopPropagation(); // クリックしたときにページジャンプが発火するのを防ぐ
    setOutline(prev => prev.filter((_, i) => i !== indexToRemove));
  };

  // 🌟 追加: 引用の項目を削除
  const handleDeleteRef = (refNumToRemove: string) => {
    setReferences(prev => {
      const newRefs = { ...prev };
      delete newRefs[refNumToRemove];
      return newRefs;
    });
  };

  const jumpToPage = (pageStr: string | number) => {
    // pdf.js の getOutline が返す dest は文字列の場合があるため安全に数値化
    let targetPage = typeof pageStr === "string" ? parseInt(pageStr.replace(/[^0-9]/g, "")) : pageStr;
    if (targetPage && targetPage > 0 && numPages && targetPage <= numPages) {
      setPageNumber(targetPage);
    }
  };

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
  const handleMenuAction = (taskType: "qa" | "math" | "citation" | "chart" | "code", actionStr: string) => {
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

    const savedPos = menuPos;

    // フォーカスを移してメニューを閉じる
    setActiveThreadId(targetId);
    setMenuPos(null);
    setMenuCategory("root");

    // 3. エージェントに質問を投げる
    askAgent(taskType, targetId, actionStr, undefined, savedPos);
  };

  // 🌟 追加: Tauri v2 / Web 共通のリンク起動関数
  const handleOpenLink = async (e: React.MouseEvent, url: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!url) return;
    
    const targetUrl = url.startsWith('http') ? url : `https://${url}`;
    const isTauri = '__TAURI_INTERNALS__' in window;
    
    if (isTauri) {
      try {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(targetUrl);
      } catch (err) {
        console.error("リンク起動エラー:", err);
        alert("リンクを開けませんでした: " + err);
      }
    } else {
      window.open(targetUrl, "_blank", "noopener,noreferrer");
    }
  };

  // 🌟 追加: Suiから言及されて「光る」ノードのIDリスト
  const [highlightedNodes, setHighlightedNodes] = useState<string[]>([]);

  // 🌟 追加: Library Agent専用の送信関数
const askLibraryAgent = async (text: string) => {
    if (!text.trim()) return;
    setIsLoading(true);
    setHighlightedNodes([]); // 質問ごとにハイライトをリセット

    const userMsg: Message = { id: Date.now().toString(), role: "user", content: text };
    const aiMsgId = (Date.now() + 1).toString();
    const aiMsg: Message = { id: aiMsgId, role: "ai", content: "" };

    // 🌟 修正: 先に新しい履歴の配列を確定させておく（Reactの非同期遅延を回避！）
    const updatedMessagesForBackend = [...globalMessages, userMsg];
    
    setGlobalMessages([...updatedMessagesForBackend, aiMsg]);
    setGlobalInputText("");

    // 現在のネットワーク状態を収集してSuiに送る準備
    const loaded_pdfs = globalGraph.nodes.filter((n: any) => n.type === "loaded").map((n: any) => n.id);
    const unloaded_references = globalGraph.nodes.filter((n: any) => n.type === "unloaded").map((n: any) => ({
      id: n.id,
      title: n.title,
      citations: n.localCitationCount || 0
    }));

    abortControllerRef.current = new AbortController();

    try {
      const response = await fetch("http://127.0.0.1:8000/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortControllerRef.current.signal,
        body: JSON.stringify({
          task_type: "library",
          context: { 
            current_context: "", // RAGが裏で埋めるので空でOK
            library_context: { loaded_pdfs, unloaded_references } 
          },
          // 🌟 修正: バックエンドが確実に取りこぼさないよう、各種プロパティにテキストを明示する
          payload: { 
            selected_text: text,
            user_intent: text,
            action_type: "library"
          },
          // 🌟 修正: AIの空枠を含まない、最新の質問までの履歴を送る
          chat_history: updatedMessagesForBackend.map(m => ({ role: m.role, content: m.content }))
        })
      });

      if (!response.body) throw new Error("ストリーム非対応");
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      
      let accumulatedResponse = "";

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
            if (data.status === "error") throw agentError(data.message);
            
            if (data.chunk) {
              accumulatedResponse += data.chunk;
              
              // 🌟 魔法のロジック: ストリーム中に [node:xxx] が出たらハイライトをオンにする
              const nodeMatches = [...accumulatedResponse.matchAll(/\[node:(.*?)\]/g)];
              if (nodeMatches.length > 0) {
                const ids = nodeMatches.map(m => m[1]);
                setHighlightedNodes(prev => [...new Set([...prev, ...ids])]); // 重複排除してセット
              }

              setGlobalMessages(prev => prev.map(msg => 
                msg.id === aiMsgId ? { ...msg, content: accumulatedResponse } : msg
              ));
            }
          }
        }
      }
    } catch (error: any) {
      console.error(error);
      setGlobalMessages(prev => prev.map(msg => 
        msg.id === aiMsgId ? { ...msg, content: error.name === "AgentError" ? `⚠️ ${error.message}` : "⚠️ エラーが発生しました。" } : msg
      ));
    } finally {
      setIsLoading(false);
      abortControllerRef.current = null;
    }
  };
    
  const askAgent = async (taskType: "qa" | "math" | "citation" | "chart" | "code",targetThreadId: string, subOption?: string, customText?: string, pos?: {x: number, y: number} | null) => {
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
            if (data.done) {
              if (data.done && payload.action_type === "translate") {
                // 🌟 修正ポイント：setThreads の中で、最新の全スレッド状態（prevThreads）を受け取る
                setThreads(prevThreads => {
                  
                  // 1. 全スレッドの中から、今操作しているスレッド（targetThreadId）を探し出す！
                  const currentThread = prevThreads.find(t => t.id === targetThreadId);
                  
                  // 2. 探し出したスレッド（currentThread）の中から、AIの最新メッセージを探す！
                  const latestAiMsg = currentThread?.messages.find(m => m.id === aiMsgId);
                  
                  if (latestAiMsg) {
                    const suggestions = JSON.parse(data.dict_suggestions || "{\"terms\":[]}");
                    
                    const newEntry: TranslationVocab = {
                      id: Date.now().toString(),
                      original: selectedText,
                      translated: latestAiMsg.content,
                      page: pageNumber,
                      terms: suggestions.terms || []
                    };

                    setVocabList(prev => [newEntry, ...prev]);
                    if (pos) {
                      setTranslationPopup({ 
                        text: latestAiMsg.content, 
                        pos: { x: pos.x, y: Math.max(10, pos.y - 120) } 
                      });
                    }
                  }
                  
                  // 既存のthreads状態はそのまま返す
                  return prevThreads;
                });
              }
              else if (taskType === "code") {
                setThreads(prevThreads => {
                  const currentThread = prevThreads.find(t => t.id === targetThreadId);
                  const latestAiMsg = currentThread?.messages.find(m => m.id === aiMsgId);
                  
                  if (latestAiMsg) {
                    // マークダウンのコードブロックから中身だけを抽出する正規表現
                    const codeMatch = latestAiMsg.content.match(/```[a-zA-Z]*\s*\n([\s\S]*?)```/);
                    if (codeMatch && codeMatch[1]) {
                      setCodePopup({ 
                        text: "シミュレーションコードが生成されました", 
                        code: codeMatch[1].trim(),
                        threadId: targetThreadId
                      });
                    }
                  }
                  return prevThreads;
                });
              }
              break; 
            }
            if (data.status === "info") continue;
            if (data.status === "error") throw agentError(data.message);

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
                  msg.id === aiMsgId ? { ...msg, content: error.name === "AgentError" ? `⚠️ ${error.message}` : "⚠️ 通信エラーが発生しました。" } : msg
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

  // PDFがアップロードされていない時は、ドロップ画面（ホーム）を表示する
  if (!pdfFile) {
    return (
      <div 
        style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", height: "100vh", background: "#f8f9fa" }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleFileUpload(e.dataTransfer.files[0]);
          }
        }}
      >
        <div style={{ background: "white", padding: "50px 80px", borderRadius: "16px", boxShadow: "0 10px 30px rgba(0,0,0,0.1)", textAlign: "center", border: "2px dashed #90caf9", cursor: isUploading ? "wait" : "pointer", transition: "all 0.2s" }}
             onClick={() => !isUploading && document.getElementById('pdf-upload')?.click()}
        >
          <div style={{ fontSize: "4em", marginBottom: "15px" }}>📄</div>
          <h2 style={{ color: "#333", margin: "0 0 10px 0" }}>PDFをドロップして読み込む</h2>
          <p style={{ color: "#666", marginBottom: "20px" }}>またはクリックしてファイルを選択してください</p>
          <input 
            id="pdf-upload" type="file" accept="application/pdf" style={{ display: "none" }} 
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) handleFileUpload(e.target.files[0]);
            }}
          />
          {isUploading && (
            <div style={{ padding: "10px", background: "#e3f2fd", color: "#1976d2", borderRadius: "8px", fontWeight: "bold" }}>
              ⏳ 論文を解析中... (目次や参考文献を抽出しています)
            </div>
          )}
        </div>
      </div>
    );
  }

// ＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝
  // ここから下を、App.tsx の一番下まで全て上書きしてください
  // ＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝＝

  return (
    <div className="app-container" style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      
      {/* 🌟 1. 上部バー (ここは常に表示) */}
      <div className="top-bar" style={{ height: "32px", background: "var(--bg-hover)", display: "flex", alignItems: "center", padding: "0 10px", borderBottom: "1px solid var(--border-light)", flexShrink: 0, zIndex: 100 }}>
        
        {/* モード切り替えスイッチ */}
        <div style={{ display: "flex", background: "var(--bg-app)", borderRadius: "var(--radius-sm)", padding: "2px", gap: "2px", border: "1px solid var(--border-light)" }}>
          <button 
            onClick={() => setViewMode("reader")} 
            style={{ padding: "2px 10px", fontSize: "0.75em", border: "none", borderRadius: "2px", cursor: "pointer", background: viewMode === "reader" ? "var(--text-main)" : "transparent", color: viewMode === "reader" ? "var(--bg-panel)" : "var(--text-muted)", fontWeight: "600" }}
          >
            📖 Reader
          </button>
          <button 
            onClick={() => setViewMode("network")} 
            style={{ padding: "2px 10px", fontSize: "0.75em", border: "none", borderRadius: "2px", cursor: "pointer", background: viewMode === "network" ? "var(--text-main)" : "transparent", color: viewMode === "network" ? "var(--bg-panel)" : "var(--text-muted)", fontWeight: "600" }}
          >
            🕸️ Network
          </button>
        </div>

        <div data-tauri-drag-region style={{ flex: 1, height: "100%" }} /> {/* スペーサー */}

        {/* ダークモード切り替え */}
        <button
          onClick={() => setIsDarkMode(!isDarkMode)}
          style={{ background: "transparent", color: "var(--text-muted)", border: "none", cursor: "pointer", fontSize: "1.1em", padding: "2px 8px", marginRight: "10px", borderRadius: "4px", transition: "all 0.2s" }}
          title={isDarkMode ? "ライトモードに切り替え" : "ダークモードに切り替え"}
          onMouseEnter={(e) => e.currentTarget.style.background = "var(--border-light)"}
          onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
        >
          {isDarkMode ? "☀️" : "🌙"}
        </button>

        {/* ファイル名 */}
        <div style={{ fontSize: "0.75em", color: "var(--text-muted)", pointerEvents: "none", paddingRight: "10px" }}>
          📄 {pdfFile.name}
        </div>
      </div>

      {/* 🌟 2. メインエリア (viewMode で切り替わる) */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden", position: "relative" }}>
        
        {viewMode === "reader" ? (
          <>
            {/* ＝＝＝＝＝ リーダーモード (既存のUI全体) ＝＝＝＝＝ */}
            
            {/* 左端の「付箋」 */}
            {!isTocOpen && (
              <div style={{ position: "absolute", left: 0, top: "20px", zIndex: 90, display: "flex", flexDirection: "column", gap: "10px", alignItems: "flex-start" }}>
                <div onClick={() => { setActiveTab("toc"); setIsTocOpen(true); }} style={{ background: "var(--toc-bg)", border: "1px solid var(--toc-border)", borderLeft: "none", padding: "10px 4px", borderRadius: "0 6px 6px 0", cursor: "pointer", boxShadow: "var(--shadow-sm)", writingMode: "vertical-rl", textOrientation: "upright", fontSize: "0.8em", color: "var(--toc-text)", fontWeight: "bold", letterSpacing: "2px", transition: "background 0.2s" }} onMouseEnter={(e) => e.currentTarget.style.background = "var(--toc-hover)"} onMouseLeave={(e) => e.currentTarget.style.background = "var(--toc-bg)"}>📑 目次</div>
                <div onClick={() => { setActiveTab("refs"); setIsTocOpen(true); }} style={{ background: "var(--ref-bg)", border: "1px solid var(--ref-border)", borderLeft: "none", padding: "10px 4px", borderRadius: "0 6px 6px 0", cursor: "pointer", boxShadow: "var(--shadow-sm)", writingMode: "vertical-rl", textOrientation: "upright", fontSize: "0.8em", color: "var(--ref-text)", fontWeight: "bold", letterSpacing: "2px", transition: "background 0.2s" }} onMouseEnter={(e) => e.currentTarget.style.background = "var(--ref-hover)"} onMouseLeave={(e) => e.currentTarget.style.background = "var(--ref-bg)"}>📚 引用</div>
                <div onClick={() => { setActiveTab("trans"); setIsTocOpen(true); }} style={{ background: "var(--text-main)", border: "1px solid var(--text-main)", borderLeft: "none", padding: "10px 4px", borderRadius: "0 6px 6px 0", cursor: "pointer", boxShadow: "var(--shadow-sm)", writingMode: "vertical-rl", textOrientation: "upright", fontSize: "0.8em", color: "var(--bg-panel)", fontWeight: "bold", letterSpacing: "2px", transition: "opacity 0.2s" }} onMouseEnter={(e) => e.currentTarget.style.opacity = "0.8"} onMouseLeave={(e) => e.currentTarget.style.opacity = "1"}>🌐 翻訳</div>
              </div>
            )}

            {/* 左ペイン (目次/引用/翻訳) */}
            {isTocOpen && (
              <>
                <div className="left-pane" style={{ width: `${leftPaneWidth}px`, borderRight: "1px solid var(--border-light)", display: "flex", flexDirection: "column", background: "var(--bg-app)", zIndex: 10, position: "relative", flexShrink: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid var(--border-light)", padding: "16px 20px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <div style={{ fontWeight: "600", color: "var(--text-main)", fontSize: "0.95em", letterSpacing: "0.5px" }}>
                        {activeTab === "toc" ? "📑 目次" : activeTab === "refs" ? "📚 参考文献" : "🌐 翻訳・語彙"}
                      </div>
                      {activeTab !== "trans" && (
                        <button onClick={() => activeTab === "toc" ? setIsAddingToc(!isAddingToc) : setIsAddingRef(!isAddingRef)} style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: "1.2em", color: "var(--text-muted)", padding: "0 4px", display: "flex", alignItems: "center" }} title="手動で追加">＋</button>
                      )}
                    </div>
                    <button onClick={() => setIsTocOpen(false)} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: "1em", display: "flex", alignItems: "center", padding: "4px 8px", transition: "all 0.2s", borderRadius: "var(--radius-sm)" }} onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-main)"; e.currentTarget.style.background = "var(--border-light)"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "transparent"; }} title="ペインを閉じる">◀</button>
                  </div>

                  <div style={{ padding: "16px", overflowY: "auto", flex: 1, fontSize: "0.9em" }}>
                    {/* 目次タブ */}
                    {activeTab === "toc" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                        {isAddingToc && (
                          <div style={{ padding: "8px", background: "var(--bg-hover)", borderRadius: "var(--radius-sm)", marginBottom: "8px", display: "flex", flexDirection: "column", gap: "6px" }}>
                            <input placeholder="章タイトル" value={newTocTitle} onChange={e => setNewTocTitle(e.target.value)} style={{ width: "100%", padding: "4px 8px", fontSize: "0.85em", border: "1px solid var(--border-light)", borderRadius: "4px", outline: "none" }} />
                            <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: "4px" }}><span style={{ fontSize: "0.7em", color: "var(--text-muted)" }}>P.</span><input type="number" placeholder="1" value={newTocPage} onChange={e => setNewTocPage(e.target.value)} style={{ width: "45px", padding: "4px 4px", fontSize: "0.85em", border: "1px solid var(--border-light)", borderRadius: "4px", outline: "none" }} /></div>
                              <div style={{ display: "flex", alignItems: "center", gap: "4px" }}><span style={{ fontSize: "0.7em", color: "var(--text-muted)" }}>Lv.</span><input type="number" min="1" max="5" value={newTocLevel} onChange={e => setNewTocLevel(e.target.value)} style={{ width: "40px", padding: "4px 4px", fontSize: "0.85em", border: "1px solid var(--border-light)", borderRadius: "4px", outline: "none" }} /></div>
                              <button onClick={handleAddToc} style={{ flex: 1, background: "var(--text-main)", color: "white", border: "none", borderRadius: "4px", fontSize: "0.8em", fontWeight: "bold", cursor: "pointer", padding: "4px 0" }}>追加</button>
                              <button onClick={() => setIsAddingToc(false)} style={{ background: "transparent", border: "1px solid var(--border-light)", color: "var(--text-muted)", borderRadius: "4px", fontSize: "0.8em", padding: "4px 8px" }}>×</button>
                            </div>
                          </div>
                        )}
                        {outline && outline.length > 0 ? (
                          outline.map((item, index) => {
                            const indent = item.level ? (item.level - 1) * 12 : 0;
                            return (
                              <div key={index} style={{ position: "relative", marginLeft: `${indent}px`, borderRadius: "var(--radius-sm)", transition: "background 0.2s", display: "flex", alignItems: "center", justifyContent: "space-between" }} onMouseEnter={(e) => { e.currentTarget.style.background = "var(--border-light)"; const btn = e.currentTarget.querySelector('.toc-delete-btn') as HTMLElement; if (btn) btn.style.opacity = '1'; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; const btn = e.currentTarget.querySelector('.toc-delete-btn') as HTMLElement; if (btn) btn.style.opacity = '0'; }}>
                                <div onClick={() => { const target = Array.isArray(item.dest) ? item.dest[0] : item.dest; if(target) jumpToPage(target); }} style={{ padding: "6px 8px", color: "var(--text-main)", cursor: "pointer", fontSize: "0.95em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{item.title}</div>
                                <button className="toc-delete-btn" onClick={(e) => handleDeleteToc(index, e)} style={{ opacity: 0, background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: "0 8px", fontSize: "1.1em", transition: "color 0.2s, opacity 0.2s" }} onMouseEnter={(e) => e.currentTarget.style.color = "#ef4444"} onMouseLeave={(e) => e.currentTarget.style.color = "var(--text-muted)"} title="この項目を削除">×</button>
                              </div>
                            );
                          })
                        ) : (
                          <div style={{ color: "var(--text-muted)", textAlign: "center", marginTop: "20px", fontSize: "0.9em" }}>目次データを抽出中です...</div>
                        )}
                      </div>
                    )}

                    {/* 参考文献タブ */}
                    {activeTab === "refs" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                        {isAddingRef && (
                          <div style={{ background: "var(--bg-panel)", padding: "12px", borderRadius: "var(--radius-md)", border: "2px dashed var(--border-light)" }}>
                            <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
                              <input placeholder="番号 [3]" value={newRefNum} onChange={e => setNewRefNum(e.target.value)} style={{ width: "70px", padding: "4px 8px", fontSize: "0.85em", border: "1px solid var(--border-light)", borderRadius: "4px", outline: "none" }} />
                              <button onClick={handleAddRef} style={{ flex: 1, background: "var(--text-main)", color: "white", border: "none", borderRadius: "4px", fontSize: "0.8em", fontWeight: "bold", cursor: "pointer" }}>保存</button>
                            </div>
                            <textarea placeholder="文献のテキスト内容..." value={newRefText} onChange={e => setNewRefText(e.target.value)} style={{ width: "100%", height: "60px", padding: "6px 8px", fontSize: "0.85em", border: "1px solid var(--border-light)", borderRadius: "4px", outline: "none", resize: "none" }} />
                          </div>
                        )}
                        {Object.keys(references).length > 0 ? (
                          Object.entries(references).map(([refNum, refText]) => {
                            const refId = refText.substring(0, 100);
                            const graphNode = globalGraph.nodes.find((n: any) => n.id === refId);
                            const currentOaStatus = graphNode ? graphNode.oaStatus : "unchecked";
                            const currentDocType = graphNode ? graphNode.docType : "unknown";

                            // UI表示用の状態変換
                            let statusBg = "var(--bg-hover)"; let statusText = "var(--text-muted)";
                            let displayStatusText = "";
                            
                            if (currentOaStatus === "open") {
                              if (currentDocType === "pdf") { statusBg = "#DCFCE7"; statusText = "#166534"; displayStatusText = "✅ PDF"; }
                              else { statusBg = "#DBEAFE"; statusText = "#1E40AF"; displayStatusText = "🌐 Web"; }
                            } else if (currentOaStatus === "checked") {
                              statusBg = "#F3F4F6"; statusText = "#6B7280"; displayStatusText = "❌ 不可";
                            } else if (currentOaStatus === "checking") {
                              displayStatusText = "⏳ 確認中...";
                            }

                            // ※ oaStatuses (辞書State) は、一時的なURL情報などを保持するためだけに残す
                            const tempStatusData = oaStatuses[refNum];

                            return (
                              <div key={refNum} style={{ position: "relative", background: "var(--bg-panel)", padding: "14px", borderRadius: "var(--radius-md)", border: "1px solid var(--border-light)", boxShadow: "var(--shadow-sm)" }} onMouseEnter={(e) => { const btn = e.currentTarget.querySelector('.ref-delete-btn') as HTMLElement; if (btn) btn.style.opacity = '1'; }} onMouseLeave={(e) => { const btn = e.currentTarget.querySelector('.ref-delete-btn') as HTMLElement; if (btn) btn.style.opacity = '0'; }}>
                                <button className="ref-delete-btn" onClick={() => handleDeleteRef(refNum)} style={{ position: "absolute", top: "-8px", right: "-8px", opacity: 0, background: "var(--bg-panel)", color: "var(--text-muted)", border: "1px solid var(--border-light)", borderRadius: "50%", width: "24px", height: "24px", cursor: "pointer", fontSize: "0.8em", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 5, boxShadow: "var(--shadow-sm)", transition: "all 0.2s" }} onMouseEnter={(e) => { e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.borderColor = "#ef4444"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.borderColor = "var(--border-light)"; }} title="この文献を削除">✕</button>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                                  <div style={{ fontWeight: "600", color: "var(--text-main)", fontSize: "0.9em" }}>{refNum}</div>
                                  {tempStatusData && (<div style={{ fontSize: "0.75em", background: statusBg, color: statusText, padding: "2px 8px", borderRadius: "12px", fontWeight: "600", border: `1px solid ${statusBg}` }}>{tempStatusData.status}</div>)}
                                </div>
                                <div style={{ fontSize: "0.85em", color: "var(--text-muted)", marginBottom: "12px", lineHeight: "1.5" }}>{refText.length > 70 ? refText.substring(0, 70) + "..." : refText}</div>
                                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                                  {(!currentOaStatus || currentOaStatus === "unchecked") && (
                                    <button onClick={async () => { 
                                      setOaStatuses(prev => ({ ...prev, [refNum]: { status: "確認中...", color: "gray" } })); 
                                      try { 
                                        const res = await fetch("http://127.0.0.1:8000/api/check_oa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw_citation: refText }) }); 
                                        const data = await res.json(); 
                                        setOaStatuses(prev => ({ ...prev, [refNum]: data })); 
                                        updateNodeOaStatus(refText.substring(0, 100), data);
                                      } catch (error) { 
                                        setOaStatuses(prev => ({ ...prev, [refNum]: { status: "エラー", color: "gray" } })); }
                                      }
                                    } disabled={currentOaStatus === "checking"} style={{ padding: "4px 10px", background: "var(--bg-hover)", color: "var(--text-main)", border: "1px solid var(--border-light)", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "0.8em", fontWeight: "500" }}>{currentOaStatus === "checking" ? "⏳ 確認中..." : "🚦 OA確認"}</button>
                                  )}
                                  {tempStatusData?.url && (<button onClick={(e) => handleOpenLink(e, tempStatusData.url)} style={{ padding: "4px 10px", background: statusBg, color: statusText, border: "none", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "0.8em", fontWeight: "600" }}>{tempStatusData.color === "blue" ? "🌐 サイトへ" : "📥 PDFを開く"}</button>)}
                                  {(tempStatusData?.color === "orange" || tempStatusData?.color === "gray") && (
                                    <>
                                      {tempStatusData.scholar_url && (<button onClick={(e) => handleOpenLink(e, tempStatusData.scholar_url)} style={{ padding: "4px 10px", background: "transparent", color: "var(--text-main)", border: "1px solid var(--border-light)", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "0.8em", fontWeight: "500" }}>🎓 Scholar</button>)}
                                      {tempStatusData.cinii_url && (<button onClick={(e) => handleOpenLink(e, tempStatusData.cinii_url)} style={{ padding: "4px 10px", background: "transparent", color: "var(--text-main)", border: "1px solid var(--border-light)", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "0.8em", fontWeight: "500" }}>📚 CiNii</button>)}
                                    </>
                                  )}
                                </div>
                                {citationPages[refNum] && citationPages[refNum].length > 0 && (
                                  <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "10px" }}>
                                    {citationPages[refNum].map(pageNum => (<button key={pageNum} onClick={() => jumpToPage(pageNum)} style={{ padding: "2px 8px", background: "var(--bg-hover)", color: "var(--text-muted)", border: "1px solid var(--border-light)", borderRadius: "12px", cursor: "pointer", fontSize: "0.75em", fontWeight: "600" }}>P.{pageNum}</button>))}
                                  </div>
                                )}
                              </div>
                            );
                          })
                        ) : (
                          <div style={{ color: "var(--text-muted)", textAlign: "center", marginTop: "20px", fontSize: "0.9em" }}>参考文献データを抽出中です...</div>
                        )}
                      </div>
                    )}

                    {/* 翻訳・用語帳タブ */}
                    {activeTab === "trans" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                        {vocabList.length === 0 ? (
                          <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: "0.85em", marginTop: "30px" }}>翻訳履歴がありません</div>
                        ) : (
                          vocabList.map(item => (
                            <div key={item.id} onClick={() => jumpToPage(item.page)} style={{ background: "var(--bg-panel)", borderRadius: "var(--radius-lg)", border: "1px solid var(--border-light)", boxShadow: "var(--shadow-sm)", cursor: "pointer", transition: "transform 0.2s, box-shadow 0.2s", overflow: "hidden" }} onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "var(--shadow-md)"; }} onMouseLeave={(e) => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = "var(--shadow-sm)"; }}>
                              <div style={{ padding: "12px 16px", background: "var(--bg-hover)", borderBottom: "1px solid var(--border-light)" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px" }}>
                                  <span style={{ background: "#1976d2", color: "white", fontSize: "0.65em", fontWeight: "bold", padding: "2px 6px", borderRadius: "4px" }}>P.{item.page}</span>
                                  <span style={{ fontSize: "0.7em", color: "var(--text-muted)", fontWeight: "600", textTransform: "uppercase", letterSpacing: "1px" }}>Source</span>
                                </div>
                                <div style={{ fontSize: "0.85em", color: "var(--text-muted)", lineHeight: "1.5", fontStyle: "italic" }}>{item.original}</div>
                              </div>
                              <div style={{ padding: "12px 16px" }}>
                                <div style={{ fontSize: "0.95em", color: "var(--text-main)", fontWeight: "600", lineHeight: "1.6", marginBottom: "12px" }}>{item.translated}</div>
                                {item.terms && item.terms.length > 0 && (
                                  <div style={{ display: "flex", flexDirection: "column", gap: "8px", background: "var(--bg-app)", padding: "12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-light)" }}>
                                    <div style={{ fontSize: "0.65em", color: "var(--text-muted)", fontWeight: "bold", textTransform: "uppercase", letterSpacing: "1px", marginBottom: "2px" }}>Vocabulary</div>
                                    {item.terms.map((t: any, i: number) => (
                                      <div key={i} style={{ fontSize: "0.8em", lineHeight: "1.4", display: "flex", flexDirection: "column", gap: "4px", borderBottom: i !== item.terms.length - 1 ? "1px dashed var(--border-light)" : "none", paddingBottom: i !== item.terms.length - 1 ? "6px" : "0" }}>
                                        <div><span style={{ color: "#1976d2", background: "rgba(25, 118, 210, 0.1)", fontWeight: "700", padding: "2px 6px", borderRadius: "4px" }}>{t.term}</span></div>
                                        <div style={{ color: "var(--text-main)", paddingLeft: "2px" }}>{t.description}</div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* 左ペインのリサイズバー */}
                <div 
                  onMouseDown={(e) => { e.preventDefault(); isResizingLeftRef.current = true; document.body.style.cursor = 'col-resize'; }}
                  style={{ width: "4px", cursor: "col-resize", backgroundColor: "var(--border-light)", zIndex: 50, transition: "background-color 0.2s ease" }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#90caf9")}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "var(--border-light)")}
                />
              </>
            )}

            {/* PDFペイン */}
            <div className="pdf-pane" onMouseUp={handleMouseUp} style={{ flex: 1, height: "100%", overflowY: "auto", display: "flex", flexDirection: "column" }}>
              <div className="pdf-controls" style={{ padding: "12px 20px", display: "flex", alignItems: "center", width: "100%" }}>
                <div style={{ flex: 1 }}></div>
                <div style={{ flex: 1, display: "flex", justifyContent: "center", alignItems: "center", gap: "12px" }}>
                  <button disabled={pageNumber <= 1} onClick={() => setPageNumber(pageNumber - 1)} style={{ background: "transparent", border: "1px solid var(--border-light)", borderRadius: "var(--radius-sm)", padding: "4px 12px", cursor: pageNumber <= 1 ? "not-allowed" : "pointer", color: "var(--text-main)", fontWeight: "500", fontSize: "0.85em", opacity: pageNumber <= 1 ? 0.4 : 1 }}>◀ 前へ</button>
                  <span style={{ fontSize: "0.85em", fontWeight: "600", color: "var(--text-muted)", minWidth: "80px", textAlign: "center", letterSpacing: "1px" }}>{pageNumber} / {numPages}</span>
                  <button disabled={pageNumber >= (numPages || 1)} onClick={() => setPageNumber(pageNumber + 1)} style={{ background: "transparent", border: "1px solid var(--border-light)", borderRadius: "var(--radius-sm)", padding: "4px 12px", cursor: pageNumber >= (numPages || 1) ? "not-allowed" : "pointer", color: "var(--text-main)", fontWeight: "500", fontSize: "0.85em", opacity: pageNumber >= (numPages || 1) ? 0.4 : 1 }}>次へ ▶</button>
                </div>
                <div style={{ flex: 1, display: "flex", justifyContent: "flex-end" }}>
                  <button onClick={toggleSnipMode} style={{ background: isSnipMode ? "var(--text-main)" : "var(--bg-hover)", color: isSnipMode ? "var(--bg-panel)" : "var(--text-main)", border: isSnipMode ? "1px solid var(--text-main)" : "1px solid var(--border-light)", padding: "6px 14px", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "0.85em", fontWeight: "600", transition: "all 0.2s", whiteSpace: "nowrap" }}>{isSnipMode ? "✂️ モードON" : "📐 画像を切り抜く"}</button>
                </div>
              </div>
              <div className="pdf-document" style={{ display: "flex", justifyContent: "center" }}>
                <Document file={pdfUrl} onLoadSuccess={onDocumentLoadSuccess} options={pdfOptions}>
                  <Page pageNumber={pageNumber} width={600}>
                    {isSnipMode && (
                      <div id="snip-overlay" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 10, cursor: "crosshair", background: "rgba(0,0,0,0.05)" }} onMouseDown={handleSnipMouseDown} onMouseMove={handleSnipMouseMove} onMouseUp={handleSnipMouseUp} onMouseLeave={() => setSnipStart(null)}>
                        {snipBox && <div style={{ position: "absolute", left: snipBox.x, top: snipBox.y, width: snipBox.w, height: snipBox.h, border: "2px dashed #e65100", backgroundColor: "rgba(230, 81, 0, 0.1)", pointerEvents: "none" }} />}
                      </div>
                    )}
                  </Page>
                </Document>
              </div>
            </div>

            {/* 右ペインのリサイズバー */}
            <div 
              onMouseDown={(e) => { e.preventDefault(); isResizingRightRef.current = true; document.body.style.cursor = 'col-resize'; }}
              style={{ width: "6px", cursor: "col-resize", backgroundColor: "var(--border-light)", zIndex: 50, transition: "background-color 0.2s ease" }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#90caf9")}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "var(--border-light)")}
            />

            {/* 右側のペイン（Agent Pane） */}
            <div className="agent-pane" style={{ width: `${agentPaneWidth}px`, height: "100%", background: "var(--bg-app)", overflowY: "auto", display: "flex", flexDirection: "column", borderLeft: "1px solid var(--border-light)" }}>
              <div style={{ padding: "20px 20px 10px 20px", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <h2 style={{ fontSize: "1.1em", color: "var(--text-main)", margin: 0, fontWeight: "600", letterSpacing: "0.5px" }}><span style={{ opacity: 0.7, marginRight: "6px" }}>✧</span>Threads</h2>
              </div>

              <div style={{ padding: "0 15px 15px 15px" }}>
              {threads.map((thread) => (
                <div key={thread.id} onClick={() => { if (activeThreadId !== thread.id) { setActiveThreadId(thread.id); setThreads(prev => prev.map(t => t.id === thread.id ? { ...t, isCollapsed: false } : t)); } }} style={{ marginBottom: "15px", background: "var(--bg-panel)", borderRadius: "var(--radius-md)", boxShadow: thread.id === activeThreadId ? "var(--shadow-md)" : "var(--shadow-sm)", border: thread.id === activeThreadId ? "1px solid #D1D5DB" : "1px solid var(--border-light)", transition: "all 0.2s ease", overflow: "hidden" }}>
                  
                  {/* スレッドヘッダー */}
                  <div onClick={(e) => { if (activeThreadId === thread.id) { e.stopPropagation(); toggleThreadCollapse(thread.id); } }} style={{ padding: "12px 16px", background: thread.id === activeThreadId ? "var(--bg-panel)" : "var(--bg-hover)", borderBottom: thread.isCollapsed ? "none" : "1px solid var(--border-light)", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, zIndex: 20 }}>
                    <span style={{ fontWeight: "600", color: "var(--text-main)", fontSize: "0.9em", display: "flex", alignItems: "center", gap: "6px" }}>
                      {thread.isMain ? <span style={{ color: "#9CA3AF" }}>📌</span> : <span style={{ color: "#9CA3AF" }}>💬</span>} {thread.title}
                    </span>
                    <button onClick={(e) => handleCopyThread(thread.id, e)} style={{ background: "transparent", color: copiedThreadId === thread.id ? "#10B981" : "var(--text-muted)", border: "1px solid var(--border-light)", borderRadius: "var(--radius-sm)", padding: "2px 8px", cursor: "pointer", fontSize: "0.75em", fontWeight: "600", transition: "all 0.2s" }} onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; if (copiedThreadId !== thread.id) e.currentTarget.style.color = "var(--text-main)"; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; if (copiedThreadId !== thread.id) e.currentTarget.style.color = "var(--text-muted)"; }} title="Markdownでコピー">{copiedThreadId === thread.id ? "✅ コピー完了" : "📋 コピー"}</button>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      {!thread.isMain && thread.messages.length > 0 && (
                        <button onClick={(e) => { e.stopPropagation(); handleMergeToMain(thread.id); }} style={{ background: "transparent", color: "var(--text-muted)", border: "1px solid var(--border-light)", borderRadius: "var(--radius-sm)", padding: "2px 8px", cursor: "pointer", fontSize: "0.75em", fontWeight: "600", transition: "all 0.2s" }} onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text-main)"; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}>↗ メインへ</button>
                      )}
                      <span style={{ color: "var(--text-muted)", fontSize: "0.7em", opacity: activeThreadId === thread.id ? 1 : 0 }}>{thread.isCollapsed ? "▼" : "▲"}</span>
                    </div>
                  </div>

                  {/* スレッドボディ */}
                  {!thread.isCollapsed && (
                    <div style={{ opacity: thread.id === activeThreadId ? 1 : 0.4, transition: "opacity 0.2s ease", pointerEvents: thread.id === activeThreadId ? "auto" : "none" }}>
                      <div className="chat-history" style={{ padding: "16px", maxHeight: "400px", overflowY: "auto", background: "var(--bg-panel)" }}>
                        {thread.messages.length === 0 ? (
                          <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: "0.85em", padding: "30px 0" }}>まだやり取りがありません。</div>
                        ) : (
                          thread.messages.map((msg) => (
                            <div key={msg.id} style={{ marginBottom: "20px", display: "flex", flexDirection: "column", alignItems: msg.role === "user" ? "flex-end" : "flex-start" }}>
                              <div style={{ position: "relative", maxWidth: "85%", background: msg.role === "user" ? "var(--bg-hover)" : "var(--bg-panel)", padding: "12px 16px", borderRadius: "var(--radius-md)", border: msg.role === "user" ? "none" : "1px solid var(--border-light)", color: "var(--text-main)" }}>
                                <button onClick={() => deleteMessage(msg.id)} style={{ position: "absolute", top: "-8px", right: "-8px", background: "var(--bg-panel)", color: "var(--text-muted)", border: "1px solid var(--border-light)", borderRadius: "50%", width: "22px", height: "22px", cursor: "pointer", fontSize: "0.7em", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 5, boxShadow: "var(--shadow-sm)" }}>✕</button>
                                {msg.sourceText && (
                                  <div style={{ fontSize: "0.8em", background: "rgba(0,0,0,0.05)", padding: "4px 8px", borderRadius: "4px", borderLeft: "3px solid #1976d2", marginBottom: "8px", color: "#555", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                    <span>📝 {msg.sourceText.length > 50 ? msg.sourceText.substring(0, 50) + "..." : msg.sourceText}</span>
                                    {msg.sourcePage && <button onClick={() => jumpToPage(msg.sourcePage!)} style={{ marginLeft: "10px", background: "#1976d2", color: "white", border: "none", borderRadius: "3px", padding: "2px 6px", cursor: "pointer", fontSize: "0.9em", whiteSpace: "nowrap" }}>📍 P.{msg.sourcePage}</button>}
                                  </div>
                                )}
                                {msg.sourceImage && (
                                  <div style={{ marginBottom: "8px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(230, 81, 0, 0.05)", padding: "8px", borderRadius: "4px", borderLeft: "3px solid #e65100" }}>
                                    <img src={msg.sourceImage} alt="ref" style={{ maxHeight: "60px", border: "1px solid #ccc", borderRadius: "4px", background: "#fff" }} />
                                    {msg.sourcePage && <button onClick={() => jumpToPage(msg.sourcePage!)} style={{ marginLeft: "10px", background: "#e65100", color: "white", border: "none", borderRadius: "3px", padding: "4px 8px", cursor: "pointer", fontSize: "0.85em", whiteSpace: "nowrap" }}>📍 P.{msg.sourcePage}</button>}
                                  </div>
                                )}
                                <div style={{ color: "var(--text-main)", fontSize: "0.95em", lineHeight: "1.6", overflowX: "auto", maxWidth: "100%" }}>
                                  <ReactMarkdown remarkPlugins={[remarkBreaks, remarkMath]} rehypePlugins={[rehypeKatex]}>{msg.content}</ReactMarkdown>
                                </div>
                                {msg.taskType === "code" && msg.content.includes("```") && (
                                  <button 
                                    onClick={() => {
                                      const match = msg.content.match(/```[a-zA-Z]*\s*\n([\s\S]*?)```/);
                                      // ここで threadId もセットする
                                      if (match) setCodePopup({ 
                                        text: "履歴からコードを開きました", 
                                        code: match[1].trim(),
                                        threadId: thread.id 
                                      });
                                    }}
                                    style={{ marginTop: "12px", width: "100%", padding: "8px", background: "rgba(25, 118, 210, 0.1)", color: "#1976d2", border: "1px solid rgba(25, 118, 210, 0.3)", borderRadius: "4px", fontWeight: "bold", cursor: "pointer", display: "flex", justifyContent: "center", alignItems: "center", gap: "6px", transition: "all 0.2s" }}
                                    onMouseEnter={(e) => e.currentTarget.style.background = "rgba(25, 118, 210, 0.2)"}
                                    onMouseLeave={(e) => e.currentTarget.style.background = "rgba(25, 118, 210, 0.1)"}
                                    
                                  >
                                    💻 コードをポップアップで拡大表示
                                  </button>
                                )}
                              </div>
                            </div>                        
                          ))
                        )}
                        <div ref={(el) => {messagesEndRefs.current[thread.id] = el}} style={{ scrollMarginTop: "60px", scrollMarginBottom: "20px" }} />
                      </div>

                      <div className="chat-input-area" style={{ padding: "12px 16px 16px 16px", background: "var(--bg-panel)", position: "relative" }}>
                        {isLoading && activeThreadId === thread.id && (
                          <div style={{ display: "flex", justifyContent: "center", marginBottom: "10px" }}>
                            <button onClick={stopGeneration} style={{ background: "var(--text-main)", color: "var(--bg-panel)", border: "none", padding: "4px 12px", borderRadius: "20px", cursor: "pointer", fontSize: "0.8em", fontWeight: "600" }}>⏹ 中断</button>
                          </div>
                        )}
                        <div style={{ display: "flex", alignItems: "center", background: "var(--bg-hover)", border: "1px solid transparent", borderRadius: "var(--radius-lg)", padding: "4px 6px 4px 14px", transition: "all 0.2s", boxShadow: activeThreadId === thread.id && inputText ? "0 0 0 2px #E5E7EB" : "none" }}>
                          <input type="text" value={activeThreadId === thread.id ? inputText : ""} onChange={(e) => { setInputText(e.target.value); setActiveThreadId(thread.id); }} onKeyDown={(e) => { if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); askAgent("qa", thread.id, undefined, inputText); } }} placeholder="質問を入力..." disabled={isLoading} style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontSize: "0.95em", color: "var(--text-main)", minWidth: 0 }} />
                          <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
                            <button onClick={() => askAgent("qa", thread.id, undefined, inputText)} disabled={isLoading || (activeThreadId === thread.id && !inputText.trim())} style={{ padding: "6px 12px", background: (activeThreadId === thread.id && inputText.trim()) ? "var(--text-main)" : "var(--border-light)", color: (activeThreadId === thread.id && inputText.trim()) ? "var(--bg-panel)" : "var(--text-muted)", border: "none", borderRadius: "var(--radius-sm)", cursor: (activeThreadId === thread.id && !inputText.trim()) ? "not-allowed" : "pointer", fontSize: "0.85em", fontWeight: "600", transition: "all 0.2s" }} title="通常質問 (Shift+Enter)">QA ↵</button>
                            <button onClick={() => askAgent("math", thread.id, undefined, inputText)} disabled={isLoading || (activeThreadId === thread.id && !inputText.trim())} style={{ padding: "6px 12px", background: "transparent", color: (activeThreadId === thread.id && inputText.trim()) ? "var(--text-main)" : "var(--text-muted)", border: "1px solid var(--border-light)", borderRadius: "var(--radius-sm)", cursor: (activeThreadId === thread.id && !inputText.trim()) ? "not-allowed" : "pointer", fontSize: "0.85em", fontWeight: "600", transition: "all 0.2s" }} title="数式エージェントに送信">Math</button>
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
              <div style={{ position: "absolute", left: menuPos.x > window.innerWidth - 260 ? "auto" : menuPos.x + 15, right: menuPos.x > window.innerWidth - 260 ? window.innerWidth - menuPos.x + 15 : "auto", top: menuPos.y > window.innerHeight - 300 ? "auto" : menuPos.y + 15, bottom: menuPos.y > window.innerHeight - 300 ? window.innerHeight - menuPos.y + 15 : "auto", zIndex: 1000, background: "var(--bg-panel)", padding: "12px", borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-float)", border: "1px solid var(--border-light)", display: "flex", flexDirection: "column", gap: "8px", minWidth: "240px", maxHeight: "80vh", overflowY: "auto" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <div style={{ fontSize: "0.75em", color: "var(--text-muted)", fontWeight: "600", letterSpacing: "0.5px", paddingLeft: "4px" }}>送信先スレッド</div>
                  <div style={{ position: "relative" }}>
                    <select value={selectedTargetThread} onChange={(e) => setSelectedTargetThread(e.target.value)} style={{ appearance: "none", width: "100%", padding: "8px 30px 8px 12px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-light)", fontSize: "0.9em", color: "var(--text-main)", background: "var(--bg-hover)", cursor: "pointer", fontWeight: "600", outline: "none", transition: "border 0.2s" }}>
                      <option value="new">✨ 新規スレッドを作成</option>
                      <option disabled>──────────</option>
                      {threads.map(t => (<option key={t.id} value={t.id}>{t.isMain ? "📌 " : ""}{t.title}</option>))}
                    </select>
                    <div style={{ position: "absolute", right: "12px", top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: "var(--text-muted)", fontSize: "0.7em" }}>▼</div>
                  </div>
                </div>
                <div style={{ height: "1px", background: "var(--border-light)", margin: "4px 0" }} />
                <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                  {menuCategory === "root" && (
                    <>
                      <button onClick={() => setMenuCategory("qa")} style={{ width: "100%", textAlign: "left", padding: "8px 10px", background: "transparent", color: "var(--text-main)", border: "none", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "0.9em", fontWeight: "500", display: "flex", alignItems: "center", gap: "10px", transition: "background 0.2s" }} onMouseEnter={(e) => e.currentTarget.style.background = "var(--bg-hover)"} onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}><span style={{ fontSize: "1.2em" }}>💬</span> テキストを分析 <span style={{ marginLeft: "auto", color: "var(--text-muted)", fontSize: "0.8em" }}>▶</span></button>
                      <button onClick={() => setMenuCategory("math")} style={{ width: "100%", textAlign: "left", padding: "8px 10px", background: "transparent", color: "var(--text-main)", border: "none", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "0.9em", fontWeight: "500", display: "flex", alignItems: "center", gap: "10px", transition: "background 0.2s" }} onMouseEnter={(e) => e.currentTarget.style.background = "var(--bg-hover)"} onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}><span style={{ fontSize: "1.2em" }}>📐</span> 数式を解析 <span style={{ marginLeft: "auto", color: "var(--text-muted)", fontSize: "0.8em" }}>▶</span></button>
                      <button onClick={() => setMenuCategory("chart")} style={{ width: "100%", textAlign: "left", padding: "8px 10px", background: "transparent", color: "var(--text-main)", border: "none", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "0.9em", fontWeight: "500", display: "flex", alignItems: "center", gap: "10px", transition: "background 0.2s" }} onMouseEnter={(e) => e.currentTarget.style.background = "var(--bg-hover)"} onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}><span style={{ fontSize: "1.2em" }}>📊</span> 図表・グラフを解析 <span style={{ marginLeft: "auto", color: "var(--text-muted)", fontSize: "0.8em" }}>▶</span></button>
                      <button onClick={() => handleMenuAction("citation", "citation")} style={{ width: "100%", textAlign: "left", padding: "8px 10px", background: "transparent", color: "var(--text-main)", border: "none", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "0.9em", fontWeight: "500", display: "flex", alignItems: "center", gap: "10px", transition: "background 0.2s" }} onMouseEnter={(e) => e.currentTarget.style.background = "var(--bg-hover)"} onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}><span style={{ fontSize: "1.2em" }}>📚</span> 引用文献を調査</button>
                      <button onClick={() => handleMenuAction("code", "simulation")} style={{ width: "100%", textAlign: "left", padding: "8px 10px", background: "transparent", color: "var(--text-main)", border: "none", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "0.9em", fontWeight: "500", display: "flex", alignItems: "center", gap: "10px", transition: "background 0.2s" }} onMouseEnter={(e) => e.currentTarget.style.background = "var(--bg-hover)"} onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}><span style={{ fontSize: "1.2em" }}>🚀</span> シミュレーション生成</button>
                    </>
                  )}
                  {menuCategory === "qa" && (
                    <>
                      <button onClick={() => setMenuCategory("root")} style={{ width: "100%", textAlign: "left", padding: "6px 10px", background: "transparent", color: "var(--text-muted)", border: "none", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "0.85em", fontWeight: "600", display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px" }} onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text-main)"; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}>◀ 戻る</button>
                      <button onClick={() => handleMenuAction("qa", "translate")} style={{ width: "100%", padding: "10px", background: "var(--text-main)", color: "var(--bg-panel)", borderRadius: "var(--radius-sm)", fontWeight: "600", marginBottom: "8px", border: "none", cursor: "pointer" }}>🌐 日本語に翻訳する</button>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
                        <button onClick={() => handleMenuAction("qa", "explain")} style={{ padding: "8px", background: "var(--bg-hover)", color: "var(--text-main)", border: "1px solid transparent", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "0.85em", fontWeight: "500", transition: "all 0.2s" }} onMouseEnter={(e) => e.currentTarget.style.borderColor = "#D1D5DB"} onMouseLeave={(e) => e.currentTarget.style.borderColor = "transparent"}>📖 解説</button>
                        <button onClick={() => handleMenuAction("qa", "intent")} style={{ padding: "8px", background: "var(--bg-hover)", color: "var(--text-main)", border: "1px solid transparent", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "0.85em", fontWeight: "500", transition: "all 0.2s" }} onMouseEnter={(e) => e.currentTarget.style.borderColor = "#D1D5DB"} onMouseLeave={(e) => e.currentTarget.style.borderColor = "transparent"}>🎯 意図</button>
                        <button onClick={() => handleMenuAction("qa", "example")} style={{ padding: "8px", background: "var(--bg-hover)", color: "var(--text-main)", border: "1px solid transparent", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "0.85em", fontWeight: "500", transition: "all 0.2s" }} onMouseEnter={(e) => e.currentTarget.style.borderColor = "#D1D5DB"} onMouseLeave={(e) => e.currentTarget.style.borderColor = "transparent"}>💡 具体例</button>
                        <button onClick={() => handleMenuAction("qa", "summarize")} style={{ padding: "8px", background: "var(--bg-hover)", color: "var(--text-main)", border: "1px solid transparent", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "0.85em", fontWeight: "500", transition: "all 0.2s" }} onMouseEnter={(e) => e.currentTarget.style.borderColor = "#D1D5DB"} onMouseLeave={(e) => e.currentTarget.style.borderColor = "transparent"}>📝 要約</button>
                        <button onClick={() => handleMenuAction("qa", "evidence")} style={{ padding: "8px", background: "var(--bg-hover)", color: "var(--text-main)", border: "1px solid transparent", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "0.85em", fontWeight: "500", transition: "all 0.2s", gridColumn: "span 2" }} onMouseEnter={(e) => e.currentTarget.style.borderColor = "#D1D5DB"} onMouseLeave={(e) => e.currentTarget.style.borderColor = "transparent"}>🔎 根拠・前提の確認</button>
                      </div>
                    </>
                  )}
                  {menuCategory === "math" && (
                    <>
                      <button onClick={() => setMenuCategory("root")} style={{ width: "100%", textAlign: "left", padding: "6px 10px", background: "transparent", color: "var(--text-muted)", border: "none", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "0.85em", fontWeight: "600", display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px" }} onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text-main)"; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}>◀ 戻る</button>
                      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                        <button onClick={() => handleMenuAction("math", "explain")} style={{ width: "100%", textAlign: "left", padding: "8px 12px", background: "var(--bg-hover)", color: "var(--text-main)", border: "1px solid transparent", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "0.85em", fontWeight: "500", transition: "all 0.2s" }} onMouseEnter={(e) => e.currentTarget.style.borderColor = "#D1D5DB"} onMouseLeave={(e) => e.currentTarget.style.borderColor = "transparent"}>❓ 式の意味を解説</button>
                        <button onClick={() => handleMenuAction("math", "derivation")} style={{ width: "100%", textAlign: "left", padding: "8px 12px", background: "var(--bg-hover)", color: "var(--text-main)", border: "1px solid transparent", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "0.85em", fontWeight: "500", transition: "all 0.2s" }} onMouseEnter={(e) => e.currentTarget.style.borderColor = "#D1D5DB"} onMouseLeave={(e) => e.currentTarget.style.borderColor = "transparent"}>🔄 式の導出を解説</button>
                      </div>
                    </>
                  )}
                  {menuCategory === "chart" && (
                    <>
                      <button onClick={() => setMenuCategory("root")} style={{ width: "100%", textAlign: "left", padding: "6px 10px", background: "transparent", color: "var(--text-muted)", border: "none", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "0.85em", fontWeight: "600", display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px" }} onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text-main)"; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}>◀ 戻る</button>
                      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                        <button onClick={() => handleMenuAction("chart", "explain")} style={{ width: "100%", textAlign: "left", padding: "8px 12px", background: "var(--bg-hover)", color: "var(--text-main)", border: "1px solid transparent", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "0.85em", fontWeight: "500", transition: "all 0.2s" }} onMouseEnter={(e) => e.currentTarget.style.borderColor = "#D1D5DB"} onMouseLeave={(e) => e.currentTarget.style.borderColor = "transparent"}>📊 図表全体を解説</button>
                        <button onClick={() => handleMenuAction("chart", "trend")} style={{ width: "100%", textAlign: "left", padding: "8px 12px", background: "var(--bg-hover)", color: "var(--text-main)", border: "1px solid transparent", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "0.85em", fontWeight: "500", transition: "all 0.2s" }} onMouseEnter={(e) => e.currentTarget.style.borderColor = "#D1D5DB"} onMouseLeave={(e) => e.currentTarget.style.borderColor = "transparent"}>📈 データの傾向と結論</button>
                        <button onClick={() => handleMenuAction("chart", "axes")} style={{ width: "100%", textAlign: "left", padding: "8px 12px", background: "var(--bg-hover)", color: "var(--text-main)", border: "1px solid transparent", borderRadius: "var(--radius-sm)", cursor: "pointer", fontSize: "0.85em", fontWeight: "500", transition: "all 0.2s" }} onMouseEnter={(e) => e.currentTarget.style.borderColor = "#D1D5DB"} onMouseLeave={(e) => e.currentTarget.style.borderColor = "transparent"}>🔍 軸と凡例の意味</button>
                      </div>
                    </>
                  )}
                </div>
                <div style={{ textAlign: "right", marginTop: "4px" }}>
                  <span onClick={() => {setMenuPos(null); setMenuCategory("root");}} style={{ fontSize: "0.75em", color: "var(--text-muted)", cursor: "pointer", padding: "2px 6px", borderRadius: "4px", transition: "all 0.2s" }} onMouseEnter={(e) => { e.currentTarget.style.background = "var(--border-light)"; e.currentTarget.style.color = "var(--text-main)"; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}>✕ 閉じる</span>
                </div>
              </div>
            )}

            {/* 翻訳結果のポップアップ */}
            {translationPopup && (
              <div style={{ position: "absolute", left: translationPopup.pos.x, top: translationPopup.pos.y, zIndex: 1100, background: "var(--bg-panel)", padding: "16px", borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-float)", border: "1px solid var(--border-light)", width: "320px", maxHeight: "350px", display: "flex", flexDirection: "column", color: "var(--text-main)", overflow: "hidden" }}>
                <div onMouseDown={(e) => { isDraggingPopupRef.current = true; popupDragOffsetRef.current = { x: e.clientX - translationPopup.pos.x, y: e.clientY - translationPopup.pos.y }; }} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px", borderBottom: "1px solid var(--border-light)", paddingBottom: "4px", flexShrink: 0, cursor: "grab" }}>
                  <span style={{ fontSize: "0.8em", color: "var(--text-muted)", fontWeight: "600", whiteSpace: "nowrap", pointerEvents: "none" }}>🌐 日本語訳</span>
                  <button onMouseDown={(e) => e.stopPropagation()} onClick={() => setTranslationPopup(null)} style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--text-muted)", fontSize: "1.2em", padding: "0 4px" }}>✕</button>
                </div>
                <div style={{ fontSize: "0.95em", lineHeight: "1.6", overflowY: "auto", flex: 1, minHeight: 0, paddingRight: "4px" }}>
                  {translationPopup.text}
                </div>
              </div>
            )}
            {codePopup && (
              <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.6)", zIndex: 2000, display: "flex", justifyContent: "center", alignItems: "center", backdropFilter: "blur(2px)" }} onClick={() => setCodePopup(null)}>
                <div style={{ background: "var(--bg-panel)", width: "750px", maxWidth: "90vw", borderRadius: "var(--radius-lg)", boxShadow: "0 20px 40px rgba(0,0,0,0.4)", display: "flex", flexDirection: "column", overflow: "hidden", border: "1px solid var(--border-light)" }} onClick={(e) => e.stopPropagation()}>
                  
                  {/* ヘッダー */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", background: "#1e1e1e", borderBottom: "1px solid #333" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      <span style={{ fontSize: "1.2em" }}>🐍</span>
                      <span style={{ fontWeight: "bold", color: "#d4d4d4", fontFamily: "monospace", letterSpacing: "1px" }}>Generated_Simulation.py</span>
                    </div>
                    <button onClick={() => setCodePopup(null)} style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: "1.2em", color: "#858585", transition: "color 0.2s" }} onMouseEnter={(e) => e.currentTarget.style.color = "#fff"} onMouseLeave={(e) => e.currentTarget.style.color = "#858585"}>✕</button>
                  </div>
                  
                  {/* 🌟 修正: コード表示＆プレビューエリア */}
                  <div style={{ display: "flex", background: "#1e1e1e", borderBottom: "1px solid #333", height: "450px" }}>
                    
                    {/* 左側：コードエディタ */}
                    <div style={{ flex: codePopup.previewImage || codePopup.previewError ? "1" : "2", padding: "20px", display: "flex", flexDirection: "column", borderRight: (codePopup.previewImage || codePopup.previewError) ? "1px solid #333" : "none", transition: "all 0.3s" }}>
                      <textarea 
                        readOnly 
                        value={codePopup.code} 
                        style={{ width: "100%", height: "100%", background: "transparent", color: "#9cdcfe", border: "none", outline: "none", fontFamily: "'Fira Code', Consolas, monospace", fontSize: "0.95em", resize: "none", lineHeight: "1.6" }} 
                      />
                    </div>

                    {/* 右側：プレビュー結果エリア（画像またはエラーがあれば表示） */}
                    {(codePopup.previewImage || codePopup.previewError || codePopup.isPreviewLoading) && (
                      <div style={{ flex: "1", padding: "20px", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", background: "#181818", overflow: "auto", position: "relative" }}>
                        <button onClick={() => setCodePopup(p => p ? { ...p, previewImage: null, previewError: null } : null)} style={{ position: "absolute", top: "10px", right: "10px", background: "rgba(255,255,255,0.1)", border: "none", color: "#ccc", borderRadius: "4px", padding: "2px 8px", cursor: "pointer", fontSize: "0.8em" }}>閉じる</button>
                        
                        {codePopup.isPreviewLoading ? (
                          <div style={{ color: "#858585", display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" }}>
                            <span style={{ fontSize: "2em" }}>⚙️</span>
                            <span>バックエンドで実行中...</span>
                          </div>
                        ) : codePopup.previewError ? (
                          <div style={{ color: "#ef4444", fontSize: "0.85em", background: "rgba(239, 68, 68, 0.1)", padding: "12px", borderRadius: "6px", width: "100%", whiteSpace: "pre-wrap", overflowX: "auto", fontFamily: "monospace" }}>
                            <div style={{ fontWeight: "bold", marginBottom: "4px" }}>実行エラー:</div>
                            {codePopup.previewError}
                          </div>
                        ) : codePopup.previewImage ? (
                          <img src={codePopup.previewImage} alt="Simulation Preview" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", background: "white", borderRadius: "4px" }} />
                        ) : null}
                      </div>
                    )}
                  </div>
                  
                  {/* フッター操作＆デバッグリクエストエリア */}
                  <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: "12px", background: "var(--bg-panel)" }}>
                    
                    {/* 上段：アクションボタン */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: "0.85em", color: "var(--text-muted)", fontWeight: "600" }}>{codePopup.text}</span>
                      
                      <div style={{ display: "flex", gap: "8px" }}>
                        {/* 🌟 追加: プレビュー実行ボタン */}
                        <button 
                          onClick={async () => {
                            setCodePopup(p => p ? { ...p, isPreviewLoading: true, previewImage: null, previewError: null } : null);
                            try {
                              const res = await fetch("http://127.0.0.1:8000/api/run_preview", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ code: codePopup.code })
                              });
                              const data = await res.json();
                              if (data.status === "success" && data.image) {
                                setCodePopup(p => p ? { ...p, previewImage: data.image, isPreviewLoading: false } : null);
                              } else {
                                setCodePopup(p => p ? { ...p, previewError: data.error || data.output || "プレビューを生成できませんでした。", isPreviewLoading: false } : null);
                              }
                            } catch (e: any) {
                              setCodePopup(p => p ? { ...p, previewError: e.message, isPreviewLoading: false } : null);
                            }
                          }} 
                          disabled={codePopup.isPreviewLoading}
                          style={{ background: "transparent", color: "#10b981", padding: "6px 16px", borderRadius: "6px", border: "1px solid #10b981", fontWeight: "bold", cursor: codePopup.isPreviewLoading ? "wait" : "pointer", display: "flex", alignItems: "center", gap: "8px", transition: "all 0.2s" }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(16, 185, 129, 0.1)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                        >
                          <span style={{ fontSize: "1.1em" }}>▶️</span> 静的プレビューを実行
                        </button>

                        <button 
                          onClick={() => {
                            navigator.clipboard.writeText(codePopup.code);
                            alert("クリップボードにコピーしました！"); 
                          }} 
                          style={{ background: "#1976d2", color: "white", padding: "6px 16px", borderRadius: "6px", border: "none", fontWeight: "bold", cursor: "pointer", display: "flex", alignItems: "center", gap: "8px", boxShadow: "0 2px 8px rgba(25, 118, 210, 0.3)", transition: "all 0.2s" }}
                          onMouseEnter={(e) => e.currentTarget.style.transform = "translateY(-1px)"}
                          onMouseLeave={(e) => e.currentTarget.style.transform = "translateY(0)"}
                        >
                          <span style={{ fontSize: "1.1em" }}>📋</span> コードをコピー
                        </button>
                      </div>
                    </div>

                    {/* 下段：デバッグ・修正リクエスト入力 */}
                    <div style={{ display: "flex", gap: "8px", alignItems: "center", background: "var(--bg-app)", padding: "8px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-light)" }}>
                      <span style={{ fontSize: "1.2em", paddingLeft: "4px" }}>🐞</span>
                      <input 
                        type="text" 
                        value={codeFeedback}
                        onChange={(e) => setCodeFeedback(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && codeFeedback.trim()) {
                            askAgent("code", codePopup.threadId, "fix", `【コードの修正要求】\n${codeFeedback}`);
                            setCodePopup(null);
                            setCodeFeedback("");
                          }
                        }}
                        placeholder="エラー内容や変更の要望を入力（プレビューで出たエラーのコピペもOK）" 
                        style={{ flex: 1, border: "none", background: "transparent", outline: "none", color: "var(--text-main)", fontSize: "0.9em" }}
                      />
                      <button 
                        onClick={() => {
                          if (!codeFeedback.trim()) return;
                          askAgent("code", codePopup.threadId, "fix", `【コードの修正要求】\n${codeFeedback}`);
                          setCodePopup(null);
                          setCodeFeedback("");
                        }}
                        disabled={!codeFeedback.trim() || isLoading}
                        style={{ padding: "6px 12px", background: codeFeedback.trim() ? "#f59e0b" : "var(--border-light)", color: codeFeedback.trim() ? "white" : "var(--text-muted)", border: "none", borderRadius: "4px", fontWeight: "bold", cursor: codeFeedback.trim() ? "pointer" : "not-allowed", transition: "all 0.2s" }}
                      >
                        リクエスト送信
                      </button>
                    </div>

                  </div>

                </div>
              </div>
            )}
          </>
        ) : (
          /* ＝＝＝＝＝ ネットワークモード全体 ＝＝＝＝＝ */
          <div style={{ display: "flex", flex: 1, width: "100%", height: "100%", background: "var(--bg-app)" }}>
            
            {/* 左側：サイドバーエリア */}
            <div style={{ position: "absolute", top: "20px", left: "20px", zIndex: 10, display: "flex", flexDirection: "column", gap: "12px", width: "280px", height: "calc(100vh - 80px)" }}>
              
              {/* ステータス ＆ 操作 */}
              <div style={{ color: "var(--text-main)", fontSize: "0.9em", background: "var(--bg-panel)", padding: "12px 16px", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-sm)", border: "1px solid var(--border-light)" }}>
                <div style={{ display: "flex", background: "var(--bg-app)", borderRadius: "4px", padding: "2px", marginBottom: "12px", border: "1px solid var(--border-light)" }}>
                  <button onClick={() => setNetworkDisplayMode("graph")} style={{ flex: 1, padding: "4px", fontSize: "0.8em", border: "none", borderRadius: "2px", cursor: "pointer", background: networkDisplayMode === "graph" ? "var(--text-main)" : "transparent", color: networkDisplayMode === "graph" ? "var(--bg-panel)" : "var(--text-muted)" }}>🕸️ グラフ</button>
                  <button onClick={() => setNetworkDisplayMode("list")} style={{ flex: 1, padding: "4px", fontSize: "0.8em", border: "none", borderRadius: "2px", cursor: "pointer", background: networkDisplayMode === "list" ? "var(--text-main)" : "transparent", color: networkDisplayMode === "list" ? "var(--bg-panel)" : "var(--text-muted)" }}>📂 リスト</button>
                </div>
                <div style={{ fontWeight: "bold", marginBottom: "8px" }}>🕸️ 引用ネットワーク</div>
                <div style={{ color: "var(--text-muted)", fontSize: "0.85em", lineHeight: "1.5", marginBottom: "12px" }}>
                  既読: {globalGraph.nodes.filter((n: any) => n.type === "loaded").length} / 未読: {globalGraph.nodes.filter((n: any) => n.type === "unloaded").length}
                </div>
                <button onClick={() => triggerPdfUpload(null)} style={{ width: "100%", padding: "8px", background: "#1976d2", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "0.85em", fontWeight: "bold", marginBottom: "8px" }}>📂 新しいPDFを読み込む</button>
                
                {graphHistory.length > 0 && (
                  <button 
                    onClick={undoAction} 
                    style={{ width: "100%", padding: "6px 8px", background: "#f59e0b", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "0.85em", fontWeight: "bold", marginBottom: "8px", boxShadow: "0 2px 4px rgba(245, 158, 11, 0.3)" }}
                  >
                    ↩️ 1つ前の状態に戻す ({graphHistory.length})
                  </button>
                )}

                {/* 🌟 初期化ボタン：2段階確認 ＆ キャンセル対応 */}
                <div style={{ display: "flex", gap: "4px" }}>
                  <button 
                    onClick={(e) => { 
                      e.stopPropagation(); 
                      if (isConfirmingReset) { 
                        saveHistory();
                        localStorage.removeItem("personal_citation_graph"); 
                        localStorage.removeItem("pinned_nodes"); 
                        setGlobalGraph({ nodes: [], links: [] }); 
                        setSelectedNode(null); 
                        setPinnedNodeIds([]); 
                        setIsConfirmingReset(false);
                      } else {
                        setIsConfirmingReset(true);
                      }
                    }} 
                    style={{ flex: isConfirmingReset ? 2 : 1, background: isConfirmingReset ? "#ef4444" : "var(--bg-hover)", color: isConfirmingReset ? "white" : "#ef4444", border: "1px solid var(--border-light)", padding: "6px 8px", borderRadius: "4px", cursor: "pointer", fontSize: "0.85em", fontWeight: isConfirmingReset ? "bold" : "normal", transition: "all 0.2s" }}
                  >
                    {isConfirmingReset ? "確定(初期化)" : "🗑️ 初期化"}
                  </button>
                  {isConfirmingReset && (
                    <button 
                      onClick={(e) => { e.stopPropagation(); setIsConfirmingReset(false); }}
                      style={{ flex: 1, background: "var(--bg-hover)", color: "var(--text-muted)", border: "1px solid var(--border-light)", borderRadius: "4px", cursor: "pointer", fontSize: "0.85em" }}
                    >
                      中止
                    </button>
                  )}
                </div>
              </div>

              {/* 🌟 追加: フィルター＆ソート コントロールパネル */}
              <div style={{ flex: "0 0 auto", display: "flex", flexDirection: "column", gap: "8px", background: "var(--bg-panel)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-sm)", border: "1px solid var(--border-light)", padding: "10px 12px" }}>
                
                <div style={{ display: "flex", gap: "4px" }}>
                  <span style={{ fontSize: "0.75em", color: "var(--text-muted)", width: "40px", display: "flex", alignItems: "center", fontWeight: "bold" }}>状態</span>
                  <div style={{ display: "flex", flex: 1, background: "var(--bg-hover)", borderRadius: "4px", padding: "2px", border: "1px solid var(--border-light)" }}>
                    {["all", "unchecked", "checked", "oa_open"].map(mode => (
                      <button 
                        key={mode} 
                        onClick={() => setFilterStatus(mode as any)}
                        style={{ flex: 1, padding: "2px 0", fontSize: "0.7em", border: "none", borderRadius: "2px", cursor: "pointer", fontWeight: filterStatus === mode ? "bold" : "normal", background: filterStatus === mode ? "var(--text-main)" : "transparent", color: filterStatus === mode ? "var(--bg-panel)" : "var(--text-muted)" }}
                      >
                        {mode === "all" ? "全て" : mode === "unchecked" ? "未確認" : mode === "checked" ? "確認済" : "🔓OA"}
                      </button>
                    ))}
                  </div>
                </div>

                <div style={{ display: "flex", gap: "4px" }}>
                  <span style={{ fontSize: "0.75em", color: "var(--text-muted)", width: "40px", display: "flex", alignItems: "center", fontWeight: "bold" }}>種類</span>
                  <div style={{ display: "flex", flex: 1, background: "var(--bg-hover)", borderRadius: "4px", padding: "2px", border: "1px solid var(--border-light)" }}>
                    {["all", "pdf", "web"].map(type => (
                      <button 
                        key={type} 
                        onClick={() => setFilterType(type as any)}
                        style={{ flex: 1, padding: "2px 0", fontSize: "0.7em", border: "none", borderRadius: "2px", cursor: "pointer", fontWeight: filterType === type ? "bold" : "normal", background: filterType === type ? "var(--text-main)" : "transparent", color: filterType === type ? "var(--bg-panel)" : "var(--text-muted)" }}
                      >
                        {type === "all" ? "全て" : type === "pdf" ? "📄PDF" : "🌐Web"}
                      </button>
                    ))}
                  </div>
                </div>

                <div style={{ display: "flex", gap: "4px", opacity: networkDisplayMode === "list" ? 1 : 0.4, pointerEvents: networkDisplayMode === "list" ? "auto" : "none" }}>
                  <span style={{ fontSize: "0.75em", color: "var(--text-muted)", width: "40px", display: "flex", alignItems: "center", fontWeight: "bold" }}>順序</span>
                  <div style={{ display: "flex", flex: 1, background: "var(--bg-hover)", borderRadius: "4px", padding: "2px", border: "1px solid var(--border-light)" }}>
                    <button onClick={() => setSortBy("citation")} style={{ flex: 1, padding: "2px 0", fontSize: "0.7em", border: "none", borderRadius: "2px", cursor: "pointer", background: sortBy === "citation" ? "var(--text-main)" : "transparent", color: sortBy === "citation" ? "var(--bg-panel)" : "var(--text-muted)" }}>⬇️引用数</button>
                    <button onClick={() => setSortBy("title")} style={{ flex: 1, padding: "2px 0", fontSize: "0.7em", border: "none", borderRadius: "2px", cursor: "pointer", background: sortBy === "title" ? "var(--text-main)" : "transparent", color: sortBy === "title" ? "var(--bg-panel)" : "var(--text-muted)" }}>🔤タイトル</button>
                  </div>
                </div>
              </div>

              {/* 手持ちのPDFリスト */}
              <div style={{ flex: "0 1 30%", display: "flex", flexDirection: "column", background: "var(--bg-panel)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-sm)", border: "1px solid var(--border-light)", overflow: "hidden", minHeight: "120px" }}>
                <div style={{ padding: "8px 12px", background: "var(--bg-hover)", fontSize: "0.8em", fontWeight: "bold", borderBottom: "1px solid var(--border-light)" }}>📚 手持ちのPDF</div>
                <div style={{ overflowY: "auto", padding: "4px" }}>
                  {globalGraph.nodes.filter((n: any) => n.type === "loaded").map((node: any) => (
                    <div key={node.id} onClick={() => handleFocusNode(node)} style={{ padding: "6px 8px", fontSize: "0.75em", cursor: "pointer", borderRadius: "4px", display: "flex", justifyContent: "space-between", alignItems: "center", background: selectedNode?.id === node.id ? "var(--bg-hover)" : "transparent" }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>🔵 {node.title}</span>
                      
                      {/* 🌟 2段階削除 ＆ キャンセルボタン */}
                      <div style={{ display: "flex", gap: "2px", alignItems: "center" }}>
                        <button 
                          onClick={(e) => { 
                            e.stopPropagation(); 
                            const targetFileName = node.fileName || node.id;
                            if (pdfFilesMap[targetFileName]) {
                              handleSwitchPdf(node);
                            } else {
                              triggerPdfUpload(node.id);
                            }
                          }}
                          style={{ background: "transparent", border: "none", color: pdfFilesMap[node.fileName || node.id] ? "#10b981" : "#f59e0b", cursor: "pointer", padding: "2px 6px", borderRadius: "4px", fontWeight: "bold", fontSize: "1.1em" }}
                          title={pdfFilesMap[node.fileName || node.id] ? "Readerで開く" : "ファイルが消失しています。クリックして再アップロード"}
                        >
                          {pdfFilesMap[node.fileName || node.id] ? "📖" : "⚠️"}
                        </button>
                        <button 
                          onClick={(e) => { 
                            e.stopPropagation(); 
                            if (confirmDeleteId === node.id) {
                              deletePdfFromGraph(node.id);
                              setConfirmDeleteId(null);
                            } else {
                              setConfirmDeleteId(node.id);
                            }
                          }} 
                          style={{ background: confirmDeleteId === node.id ? "#ef4444" : "transparent", border: "none", color: confirmDeleteId === node.id ? "white" : "#ef4444", cursor: "pointer", padding: "2px 6px", borderRadius: "4px", fontWeight: "bold", fontSize: "0.85em" }}
                        >
                          {confirmDeleteId === node.id ? "確定" : "🗑️"}
                        </button>
                        {confirmDeleteId === node.id && (
                          <button 
                            onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); }}
                            style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: "2px 4px", fontSize: "1.1em" }}
                          >
                            ×
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* ⭐ 気になるリスト */}
              <div style={{ flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column", background: "var(--bg-panel)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-sm)", border: "1px solid var(--border-light)", overflow: "hidden" }}>
                <div style={{ padding: "8px 12px", background: "#fff9db", fontSize: "0.85em", fontWeight: "bold", color: "#854d0e", borderBottom: "1px solid var(--border-light)" }}>⭐ 気になる文献</div>
                <div style={{ overflowY: "auto", padding: "4px" }}>
                  {globalGraph.nodes.filter((n: any) => pinnedNodeIds.includes(n.id)).map((node: any) => (
                    <div key={node.id} onClick={() => handleFocusNode(node)} style={{ padding: "8px", fontSize: "0.8em", cursor: "pointer", borderBottom: "1px solid var(--border-light)", background: selectedNode?.id === node.id ? "var(--bg-hover)" : "transparent" }} onMouseEnter={e => e.currentTarget.style.background = "var(--bg-hover)"} onMouseLeave={e => e.currentTarget.style.background = selectedNode?.id === node.id ? "var(--bg-hover)" : "transparent"}>
                      <div style={{ fontWeight: "600", color: "var(--text-main)" }}>📌 {node.title}</div>
                    </div>
                  ))}
                  {pinnedNodeIds.length === 0 && (
                    <div style={{ color: "var(--text-muted)", fontSize: "0.8em", textAlign: "center", padding: "10px 0" }}>まだありません</div>
                  )}
                </div>
              </div>
            </div>

            {/* 中央：グラフ描画エリア */}
            {/* 🌟 修正: 中央エリア全体を Flex Column で縦に分割するコンテナ */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", position: "relative", overflow: "hidden", minWidth: 0 }}>
              
              {/* 🔼 上半分：グラフ描画 ＆ リストエリア */}
              <div ref={containerRef} style={{ flex: 1, position: "relative", overflow: "hidden", minWidth: 0 }}>
                <input id="network-pdf-upload" type="file" accept="application/pdf" style={{ display: "none" }} onChange={(e) => e.target.files?.[0] && handleFileUpload(e.target.files[0])} />
                {networkDisplayMode === "graph" ? (
                  globalGraph.nodes.length > 0 ? (
                <ForceGraph2D
                  ref={fgRef}
                  width={graphDim.width}
                  height={graphDim.height}
                  graphData={{
                    nodes: getProcessedNodes(globalGraph.nodes),
                    links: globalGraph.links.filter((l: any) => {
                      const validNodeIds = new Set(getProcessedNodes(globalGraph.nodes).map(n => n.id));
                      const sId = typeof l.source === 'object' ? l.source.id : l.source;
                      const tId = typeof l.target === 'object' ? l.target.id : l.target;
                      return validNodeIds.has(sId) && validNodeIds.has(tId);
                    })
                  }}
                  onNodeClick={handleNodeClick}
                  backgroundColor="transparent"
                  d3VelocityDecay={0.8}
                  nodeCanvasObject={(node: any, ctx, globalScale) => {
                    const isSelected = selectedNode?.id === node.id;
                    const isPinned = pinnedNodeIds.includes(node.id);
                    const isHighlighted = highlightedNodes.some(hId => node.id === hId || node.id.startsWith(hId) || hId.startsWith(node.id));
                    const radius = Math.sqrt(node.val || 5) * 2;
                    
                    if (isHighlighted) {
                      ctx.beginPath();
                      ctx.arc(node.x, node.y, radius + 15, 0, 2 * Math.PI, false);
                      ctx.fillStyle = "rgba(245, 158, 11, 0.2)"; // 金色のオーラ
                      ctx.fill();
                      
                      ctx.beginPath();
                      ctx.arc(node.x, node.y, radius + 5, 0, 2 * Math.PI, false);
                      ctx.strokeStyle = "rgba(245, 158, 11, 0.8)"; // 強い金色の枠線
                      ctx.lineWidth = 4 / globalScale;
                      ctx.stroke();
                    }

                    if (isSelected || isPinned) {
                      ctx.beginPath();
                      ctx.arc(node.x, node.y, radius + (isPinned ? 5 : 3), 0, 2 * Math.PI, false);
                      ctx.fillStyle = isPinned ? "rgba(255, 215, 0, 0.4)" : "rgba(255, 240, 138, 0.5)";
                      ctx.fill();
                      if (isPinned) {
                        ctx.strokeStyle = "#ffd700";
                        ctx.lineWidth = 2 / globalScale;
                        ctx.stroke();
                      }
                    }

                    ctx.beginPath();
                    ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
                    
                    // 色分けロジック
                    if (node.type === "loaded") {
                      ctx.fillStyle = "#1976d2";
                    } else if (node.oaStatus === "open") {
                      ctx.fillStyle = node.docType === "pdf" ? "#10b981" : "#0ea5e9";
                    } else if (node.oaStatus === "checked") {
                      ctx.fillStyle = "#f59e0b";
                    } else {
                      ctx.fillStyle = "#d1d5db";
                    }
                    ctx.fill();

                    if (globalScale > 0.3) {
                      const label = node.title || "";
                      const fontSize = 13 / globalScale; 
                      ctx.font = `${(isSelected || isPinned) ? 'bold ' : ''}${fontSize}px Sans-Serif`;
                      ctx.textAlign = 'center';
                      ctx.textBaseline = 'top';
                      const shortLabel = label.length > 20 ? label.substring(0, 20) + "..." : label;
                      const textY = node.y + radius + (3 / globalScale);
                      ctx.lineWidth = 3 / globalScale;
                      ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
                      ctx.strokeText(shortLabel, node.x, textY);
                      if (isPinned) ctx.fillStyle = "#854d0e";
                      else if (isSelected) ctx.fillStyle = "#e65100";
                      else ctx.fillStyle = node.type === "loaded" ? "#1f2937" : "#6b7280";
                      ctx.fillText(shortLabel, node.x, textY);
                    }
                  }}
                  nodeCanvasObjectMode={() => "replace"}
                />
                ) : (
                    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100%", color: "var(--text-muted)" }}>
                      PDFをアップロードすると、ここに引用ネットワークが形成されます。
                    </div>
                  )
                ) : (
                  renderNestedList()
                )}
              </div>

              {/* 🔽 下半分：コマンドバー ＆ グローバルチャットエリア */}
              {/* 🌟 修正: サイドバー（300px）を避けるために paddingLeft を確保する */}
              <div style={{
                height: isGlobalChatOpen ? "40%" : "64px",
                display: "flex",
                flexDirection: "column",
                background: "var(--bg-panel)",
                borderTop: "1px solid var(--border-light)",
                boxShadow: "0 -4px 15px rgba(0,0,0,0.05)",
                transition: "height 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                paddingLeft: "310px", // 👈 左の絶対配置サイドバーを避けるための重要なパディング
                zIndex: 5
              }}>
                
                {/* 開いている時だけ見えるチャット履歴エリア */}
                <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px", display: isGlobalChatOpen ? "flex" : "none", flexDirection: "column", gap: "16px", background: "var(--bg-app)" }}>
                  {globalMessages.length === 0 ? (
                    <div style={{ textAlign: "center", color: "var(--text-muted)", marginTop: "30px", display: "flex", flexDirection: "column", alignItems: "center", gap: "10px" }}>
                      <span style={{ fontSize: "2.5em" }}>🌌</span>
                      <div style={{ fontWeight: "bold", fontSize: "1.1em", color: "var(--text-main)" }}>Library Agent (Sui) へのアクセス</div>
                      <p style={{ fontSize: "0.9em", maxWidth: "400px", lineHeight: "1.6" }}>
                        現在展開されているネットワーク全体から、必要な知識を検索・推論します。まだ実体化していない未読ノードの有望性についても提案可能です。
                      </p>
                      <div style={{ background: "var(--bg-panel)", padding: "10px 16px", borderRadius: "8px", border: "1px solid var(--border-light)", fontSize: "0.85em", marginTop: "10px" }}>
                        💡 <b>例:</b> 「コロイドの粘度についてまとまっている文献はどれ？」
                      </div>
                    </div>
                  ) : (
                    globalMessages.map((msg) => (
                      <div key={msg.id} style={{ display: "flex", flexDirection: "column", alignItems: msg.role === "user" ? "flex-end" : "flex-start", marginBottom: "8px" }}>
                        <div style={{ maxWidth: "85%", background: msg.role === "user" ? "var(--bg-hover)" : "var(--bg-panel)", padding: "12px 16px", borderRadius: "var(--radius-md)", border: msg.role === "user" ? "none" : "1px solid var(--border-light)", color: "var(--text-main)" }}>
                          <div style={{ fontSize: "0.95em", lineHeight: "1.6", overflowX: "auto", maxWidth: "100%" }}>
                            {/* 🌟 修正: マークダウン描画時に [node:ID] を検知してクリックできるボタンに変換する */}
                            <ReactMarkdown 
                              remarkPlugins={[remarkBreaks]}
                              components={{
                                a: ({ node, href, children, ...props }) => {
                                  if (href?.startsWith("#node-")) {
                                    const nodeId = href.replace("#node-", "");
                                    return (
                                      <button
                                        onClick={() => {
                                          const targetNode = globalGraph.nodes.find((n: any) => n.id === nodeId || n.id.startsWith(nodeId) || nodeId.startsWith(n.id));
                                          if (targetNode) handleFocusNode(targetNode);
                                        }}
                                        style={{ background: "rgba(245, 158, 11, 0.1)", color: "#d97706", border: "1px solid rgba(245, 158, 11, 0.4)", borderRadius: "4px", padding: "0 6px", cursor: "pointer", fontWeight: "bold", fontSize: "0.9em", transition: "all 0.2s" }}
                                        onMouseEnter={e => e.currentTarget.style.background = "rgba(245, 158, 11, 0.2)"}
                                        onMouseLeave={e => e.currentTarget.style.background = "rgba(245, 158, 11, 0.1)"}
                                      >
                                        📄 文献を見る
                                      </button>
                                    );
                                  }
                                  return <a href={href} {...props}>{children}</a>;
                                }
                              }}
                            >
                              {/* 正規表現で [node:ID] を一時的にマークダウンリンク [ID](#node-ID) に置換して渡す */}
                              {msg.content.replace(/\[node:(.*?)\]/g, '[$1](#node-$1)')}
                            </ReactMarkdown>
                          </div>
                        </div>
                      </div>                        
                    ))
                  )}
                </div>

                {/* 常に表示されるコマンド入力バー */}
                <div style={{ padding: "10px 24px", display: "flex", alignItems: "center", gap: "12px", background: "var(--bg-panel)", flexShrink: 0 }}>
                  <button
                    onClick={() => setIsGlobalChatOpen(!isGlobalChatOpen)}
                    style={{ background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: "1.2em", transform: isGlobalChatOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.3s, color 0.2s", display: "flex", alignItems: "center", justifyContent: "center", width: "32px", height: "32px", borderRadius: "50%" }}
                    onMouseEnter={e => e.currentTarget.style.color = "var(--text-main)"}
                    onMouseLeave={e => e.currentTarget.style.color = "var(--text-muted)"}
                    title="履歴を開閉"
                  >
                    ▲
                  </button>
                  <div style={{ flex: 1, display: "flex", alignItems: "center", background: "var(--bg-app)", borderRadius: "24px", padding: "8px 20px", border: "1px solid var(--border-light)", boxShadow: "inset 0 1px 4px rgba(0,0,0,0.03)", transition: "border 0.2s" }}
                       onFocus={e => e.currentTarget.style.borderColor = "#9ca3af"}
                       onBlur={e => e.currentTarget.style.borderColor = "var(--border-light)"}
                  >
                    <span style={{ marginRight: "12px", fontSize: "1.2em", opacity: 0.8 }}>✨</span>
                    <input
                      type="text"
                      placeholder="ライブラリ全体から情報を検索、または Sui に指示..."
                      value={globalInputText}
                      onChange={(e) => setGlobalInputText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && globalInputText.trim()) {
                          e.preventDefault();
                          setIsGlobalChatOpen(true);
                          askLibraryAgent(globalInputText);
                        }
                      }}
                      disabled={isLoading}
                      style={{ flex: 1, border: "none", outline: "none", background: "transparent", color: "var(--text-main)", fontSize: "0.95em" }}
                    />
                  </div>
                  <button
                    onClick={() => {
                      if(globalInputText.trim()){
                        setIsGlobalChatOpen(true);
                        // TODO: バックエンド送信処理
                        console.log("送信:", globalInputText);
                        setGlobalInputText("");
                      } else {
                        setIsGlobalChatOpen(!isGlobalChatOpen);
                      }
                    }}
                    style={{ padding: "8px 20px", background: globalInputText.trim() ? "var(--text-main)" : "var(--bg-hover)", color: globalInputText.trim() ? "var(--bg-panel)" : "var(--text-muted)", border: "none", borderRadius: "24px", fontWeight: "bold", cursor: "pointer", transition: "all 0.2s" }}
                  >
                    {globalInputText.trim() ? "送信" : "履歴"}
                  </button>
                </div>
              </div>
            </div>

            {/* 右側：詳細パネル */}
            {selectedNode && (
              <div style={{ width: "340px", borderLeft: "1px solid var(--border-light)", background: "var(--bg-panel)", display: "flex", flexDirection: "column", flexShrink: 0, boxShadow: "-2px 0 10px rgba(0,0,0,0.05)", zIndex: 20 }}>
                <div style={{ padding: "16px", borderBottom: "1px solid var(--border-light)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <h3 style={{ margin: 0, fontSize: "1em" }}>文献詳細</h3>
                  <button onClick={() => setSelectedNode(null)} style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: "1.2em" }}>✕</button>
                </div>
                
                <div style={{ padding: "16px", overflowY: "auto", flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
                    <span style={{ background: selectedNode.type === "loaded" ? "#1976d2" : "#9ca3af", color: "white", padding: "2px 8px", borderRadius: "12px", fontSize: "0.75em", fontWeight: "bold" }}>
                      {selectedNode.type === "loaded" ? "既読 (PDFあり)" : "未読 (参考文献)"}
                    </span>
                  </div>

                  <div style={{ fontSize: "0.95em", fontWeight: "600", marginBottom: "20px" }}>{selectedNode.title}</div>

                  <button 
                    onClick={() => togglePin(selectedNode.id)}
                    style={{ width: "100%", padding: "10px", background: pinnedNodeIds.includes(selectedNode.id) ? "#ffd700" : "var(--bg-hover)", color: pinnedNodeIds.includes(selectedNode.id) ? "#854d0e" : "var(--text-main)", border: "none", borderRadius: "4px", fontWeight: "bold", cursor: "pointer", marginBottom: "16px" }}
                  >
                    {pinnedNodeIds.includes(selectedNode.id) ? "★ 気になるリストから外す" : "☆ 気になるリストに追加"}
                  </button>

                  {selectedNode.type === "unloaded" && (
                    <div style={{ background: "var(--bg-hover)", padding: "16px", borderRadius: "var(--radius-md)", border: "1px solid var(--border-light)" }}>
                      <button onClick={() => triggerPdfUpload(selectedNode.id)} style={{ width: "100%", padding: "10px", background: "var(--text-main)", color: "var(--bg-panel)", fontWeight: "bold", border: "none", borderRadius: "4px", cursor: "pointer", marginBottom: "12px" }}>📄 ローカルのPDFで実体化する</button>
                      <div style={{ height: "1px", background: "var(--border-light)", margin: "16px 0" }}></div>
                      <h4 style={{ margin: "0 0 12px 0", fontSize: "0.85em", color: "var(--text-muted)", textTransform: "uppercase" }}>ウェブ検索</h4>
                      
                      {/* 🌟 修正: 過去のデータ(URLなし)でスタックしないよう、常に再検索ボタンを出す */}
                      {!isFetchingOa && (
                        <button onClick={handleCheckNodeOa} style={{ width: "100%", padding: "8px", background: "transparent", color: "var(--text-main)", border: "1px solid var(--border-light)", borderRadius: "var(--radius-sm)", cursor: "pointer", marginBottom: nodeOaInfo ? "12px" : "0", transition: "background 0.2s" }} onMouseEnter={(e) => e.currentTarget.style.background = "var(--bg-hover)"} onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                          {nodeOaInfo ? "🔄 もう一度検索する" : "🔍 無料PDFを探す"}
                        </button>
                      )}
                      
                      {isFetchingOa && <div style={{ textAlign: "center", fontSize: "0.9em", padding: "8px 0", color: "var(--text-muted)" }}>検索中...</div>}
                      
                      {nodeOaInfo && (
                        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                          {/* ステータスバッジ */}
                          <div style={{ padding: "4px 8px", borderRadius: "4px", fontSize: "0.85em", fontWeight: "bold", background: nodeOaInfo.color === "gray" ? "#F3F4F6" : "#DBEAFE", color: nodeOaInfo.color === "gray" ? "#4B5563" : "#1E40AF" }}>
                            {nodeOaInfo.status}
                          </div>
                          
                          {/* 🌟 URLがあれば各種ジャンプボタンを表示 (CiNiiも追加) */}
                          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                            {nodeOaInfo.url && (
                              <button onClick={(e) => handleOpenLink(e, nodeOaInfo.url)} style={{ flex: 1, padding: "6px", background: "#1976d2", color: "white", border: "none", borderRadius: "4px", fontWeight: "bold", cursor: "pointer" }}>
                                📥 開く
                              </button>
                            )}
                            {nodeOaInfo.scholar_url && (
                              <button onClick={(e) => handleOpenLink(e, nodeOaInfo.scholar_url)} style={{ flex: 1, padding: "6px", background: "white", color: "var(--text-main)", border: "1px solid var(--border-light)", borderRadius: "4px", fontWeight: "bold", cursor: "pointer" }}>
                                🎓 Scholar
                              </button>
                            )}
                            {nodeOaInfo.cinii_url && (
                              <button onClick={(e) => handleOpenLink(e, nodeOaInfo.cinii_url)} style={{ flex: 1, padding: "6px", background: "white", color: "var(--text-main)", border: "1px solid var(--border-light)", borderRadius: "4px", fontWeight: "bold", cursor: "pointer" }}>
                                📚 CiNii
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {selectedNode.type === "loaded" && (
                    <>
                    <div style={{ marginTop: "20px", padding: "12px", border: "1px solid #10b981", borderRadius: "8px", background: "rgba(16, 185, 129, 0.05)", marginBottom: "12px" }}>
                        <button 
                          onClick={() => {
                            const targetFileName = selectedNode.fileName || selectedNode.id;
                            if (pdfFilesMap[targetFileName]) {
                              handleSwitchPdf(selectedNode);
                            } else {
                              triggerPdfUpload(selectedNode.id);
                            }
                          }}
                          style={{ width: "100%", padding: "10px", background: pdfFilesMap[selectedNode.fileName || selectedNode.id] ? "#10b981" : "#f59e0b", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "0.9em", fontWeight: "bold", transition: "opacity 0.2s" }}
                          onMouseEnter={(e) => e.currentTarget.style.opacity = "0.8"}
                          onMouseLeave={(e) => e.currentTarget.style.opacity = "1"}
                        >
                          {pdfFilesMap[selectedNode.fileName || selectedNode.id] ? "📖 このPDFをReaderで開く" : "⚠️ メモリ消失: クリックしてPDFを復元"}
                        </button>
                      </div>
                    <div style={{ marginTop: "20px", padding: "12px", border: "1px solid #fee2e2", borderRadius: "8px", background: "rgba(239, 68, 68, 0.05)", display: "flex", flexDirection: "column", gap: "8px" }}>
                      <div style={{ fontSize: "0.8em", color: "#ef4444", fontWeight: "bold", marginBottom: "4px" }}>⚙️ 管理操作</div>
                      
                      <button 
                        onClick={() => unloadPdf(selectedNode.id)} 
                        style={{ width: "100%", padding: "8px", background: "white", color: "#f97316", border: "1px solid #f97316", borderRadius: "4px", cursor: "pointer", fontSize: "0.85em", fontWeight: "bold" }}
                      >
                        📘 既読状態を解除 (未読に戻す)
                      </button>
                      
                      <div style={{ display: "flex", gap: "4px" }}>
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirmDeleteId === selectedNode.id) {
                              deletePdfFromGraph(selectedNode.id);
                              setConfirmDeleteId(null);
                            } else {
                              setConfirmDeleteId(selectedNode.id);
                            }
                          }} 
                          style={{ flex: 2, padding: "8px", background: confirmDeleteId === selectedNode.id ? "#ef4444" : "transparent", color: confirmDeleteId === selectedNode.id ? "white" : "#ef4444", border: confirmDeleteId === selectedNode.id ? "none" : "1px solid #ef4444", borderRadius: "4px", cursor: "pointer", fontSize: "0.85em", fontWeight: "bold", transition: "all 0.2s" }}
                        >
                          {confirmDeleteId === selectedNode.id ? "確定(削除)" : "🗑️ 完全に削除"}
                        </button>
                        {confirmDeleteId === selectedNode.id && (
                          <button 
                            onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); }}
                            style={{ flex: 1, padding: "8px", background: "var(--bg-hover)", color: "var(--text-muted)", border: "1px solid var(--border-light)", borderRadius: "4px", cursor: "pointer", fontSize: "0.85em" }}
                          >
                            中止
                          </button>
                        )}
                      </div>
                    </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;