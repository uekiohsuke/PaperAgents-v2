// SSEの data: 行を1イベントずつ返す。
// チャンクの区切りが行の途中に来ても、改行がそろうまでバッファしてからJSONとして解析する
export async function* readSseEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = done ? "" : lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const dataStr = line.slice(6);
        if (dataStr.trim()) yield JSON.parse(dataStr);
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}
