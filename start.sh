#!/usr/bin/env bash
# Paper Agent v2 の起動スクリプト
#
#   ./start.sh          デスクトップアプリ（Tauri）で起動
#   ./start.sh --web    ブラウザで起動（http://localhost:1420）
#
# backend（FastAPI）をバックグラウンドで起動し、準備ができてからフロントを起動する。
# フロントを終了する（ウィンドウを閉じる / Ctrl+C）と backend も止まる。
# 初回は Python の仮想環境と npm の依存を自動でインストールする。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="${ROOT}/backend"
FRONTEND="${ROOT}/frontend"
BACKEND_PORT=8000

MODE="tauri"
case "${1:-}" in
  "") ;;
  --web) MODE="web" ;;
  -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "不明なオプションです: $1（./start.sh --help を参照）" >&2; exit 1 ;;
esac

info() { echo "▶ $*"; }
warn() { echo "⚠️  $*" >&2; }
fail() { echo "❌ $*" >&2; exit 1; }

# ==========================================
# 初回セットアップ
# ==========================================
if [ ! -x "${BACKEND}/venv/bin/python" ]; then
  command -v python3 >/dev/null || fail "python3 が見つかりません。"
  info "Python の仮想環境を作成し、依存をインストールします（初回のみ）..."
  python3 -m venv "${BACKEND}/venv"
  "${BACKEND}/venv/bin/pip" install -q -r "${BACKEND}/requirements.txt"
fi

if [ ! -d "${FRONTEND}/node_modules" ]; then
  command -v npm >/dev/null || fail "npm が見つかりません。"
  info "npm の依存をインストールします（初回のみ）..."
  npm --prefix "${FRONTEND}" install
fi

if [ "${MODE}" = "tauri" ] && ! command -v cargo >/dev/null; then
  fail "デスクトップ版には Rust（cargo）が必要です。ブラウザ版は ./start.sh --web で起動できます。"
fi

if [ ! -f "${BACKEND}/.env" ]; then
  warn "backend/.env がありません。LLMの接続先は既定値（http://127.0.0.1:1234/v1）になります。"
fi

# ==========================================
# LLM（OpenAI互換API）の疎通確認（失敗しても起動は続ける）
# ==========================================
LLM_BASE_URL="$(grep -E '^LOCAL_OPENAI_BASE_URL=' "${BACKEND}/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
LLM_BASE_URL="${LLM_BASE_URL:-http://127.0.0.1:1234/v1}"
if ! curl -s -m 3 -o /dev/null "${LLM_BASE_URL}/models"; then
  warn "LLM（${LLM_BASE_URL}）に接続できません。Ollama などを起動してください。"
fi

# ==========================================
# backend の起動
# ==========================================
if lsof -iTCP:"${BACKEND_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "ポート ${BACKEND_PORT} が使用中です。以前の backend が残っていれば止めてください（lsof -iTCP:${BACKEND_PORT} -sTCP:LISTEN）。"
fi

BACKEND_PID=""
cleanup() {
  if [ -n "${BACKEND_PID}" ] && kill -0 "${BACKEND_PID}" 2>/dev/null; then
    info "backend を停止します..."
    kill "${BACKEND_PID}" 2>/dev/null || true
    wait "${BACKEND_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

info "backend を起動します（http://127.0.0.1:${BACKEND_PORT}）..."
cd "${BACKEND}"
# PYTHONUNBUFFERED: ログをバッファせずにすぐ表示する
PYTHONUNBUFFERED=1 venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port "${BACKEND_PORT}" \
  > >(awk '{ print "[backend] " $0; fflush() }') 2>&1 &
BACKEND_PID=$!
cd "${ROOT}"

for _ in $(seq 1 60); do
  if curl -s -o /dev/null "http://127.0.0.1:${BACKEND_PORT}/api/settings"; then
    break
  fi
  kill -0 "${BACKEND_PID}" 2>/dev/null || fail "backend の起動に失敗しました。上のログを確認してください。"
  sleep 0.5
done
curl -s -o /dev/null "http://127.0.0.1:${BACKEND_PORT}/api/settings" || fail "backend が30秒以内に起動しませんでした。"
info "backend の準備ができました。"

# ==========================================
# フロントの起動（終了すると backend も止まる）
# ==========================================
if [ "${MODE}" = "web" ]; then
  info "ブラウザで開きます（http://localhost:1420）。終了は Ctrl+C。"
  npm --prefix "${FRONTEND}" run dev -- --open
else
  info "デスクトップアプリを起動します。終了はウィンドウを閉じるか Ctrl+C。"
  npm --prefix "${FRONTEND}" run tauri dev
fi
