import ForceGraph2D from 'react-force-graph-2d';

export const CitationNetworkView = ({ graphData, onNodeClick }: any) => {
  return (
    <div style={{ width: "100%", height: "100%", background: "var(--bg-app)", position: "relative" }}>
      <div style={{ position: "absolute", top: 20, left: 20, zIndex: 10, background: "rgba(0,0,0,0.6)", padding: "10px", borderRadius: "8px", color: "white", fontSize: "0.8em" }}>
        🔵 読み込み済みPDF / ⚪ 参考文献（未読）<br/>
        ノードをクリックして詳細を確認
      </div>
      <ForceGraph2D
        graphData={graphData}
        nodeLabel="title"
        nodeRelSize={6}
        nodeColor={n => n.type === "loaded" ? "#1976d2" : "#9ca3af"} // 読み込み済みは青、未読はグレー
        linkColor={() => "var(--border-light)"}
        linkDirectionalArrowLength={4}
        linkDirectionalArrowRelPos={1}
        onNodeClick={onNodeClick}
        backgroundColor="transparent"
      />
    </div>
  );
};