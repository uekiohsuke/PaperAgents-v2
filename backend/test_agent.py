from typing import TypedDict
from langgraph.graph import StateGraph, START, END
from langchain_ollama import ChatOllama

# 1. Stateの定義（今回はメッセージの履歴のみ）
class State(TypedDict):
    messages: list

# 2. LLMの準備（OllamaでローカルのLlama3.2を呼び出す）
llm = ChatOllama(model="qwen3:14b", temperature=0)

# 3. ノード（エージェント）の処理関数
def chatbot(state: State):
    print("🤖 LLMが思考中...")
    # Stateの中のメッセージ履歴をLLMに渡し、返答を受け取る
    response = llm.invoke(state["messages"])
    return {"messages": [response]}

# 4. グラフ（ワークフロー）の構築
graph_builder = StateGraph(State)
graph_builder.add_node("chatbot", chatbot)
graph_builder.add_edge(START, "chatbot")
graph_builder.add_edge("chatbot", END)

# グラフのコンパイル
graph = graph_builder.compile()

# 5. 実行してみる
if __name__ == "__main__":
    user_input = "量子力学について、1行で簡単に説明して。"
    print(f"ユーザー: {user_input}")
    
    # グラフに初期Stateを渡して実行
    result = graph.invoke({"messages": [user_input]})
    
    print(f"Llama: {result['messages'][-1].content}")