import fitz  # PyMuPDF
import re
import traceback

# 🌟 追加: RAG用のライブラリ
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_ollama import OllamaEmbeddings
from langchain_community.vectorstores import FAISS
from langchain_core.documents import Document

class PaperParser:
    def __init__(self, file_path: str):
        self.file_path = file_path
        self.doc = fitz.open(file_path)
        
        self.full_text = ""
        self.toc = []
        self.references = {}

        self.citation_pages = {} 
        self.page_texts = {}
        
        self.vectorstore = None # 🌟 追加: ベクトルDBの格納先
        
        # 初期化時に自動で全解析を走らせる
        self._parse_all()

    def _parse_all(self):
        text_blocks = []
        fallback_toc = [] 
        
        for page_num in range(len(self.doc)):
            page = self.doc[page_num]
            text = page.get_text()
            self.page_texts[page_num + 1] = text 
            text_blocks.append(text)
            
            lines = text.split('\n')
            for i in range(len(lines)):
                line = lines[i].strip()
                if not line:
                    continue
                    
                section_num = None
                section_title = None
                
                match_same = re.match(r'^([1-9]\d*(?:\.\d+)*)\s+([A-Za-zぁ-んァ-ヶｱ-ﾝﾞﾟ一-龠].*)$', line)
                if match_same:
                    section_num = match_same.group(1)
                    section_title = match_same.group(2)
                else:
                    if i > 0:
                        prev_line = lines[i-1].strip()
                        if re.match(r'^([1-9]\d*(?:\.\d+)*)$', prev_line):
                            if re.match(r'^[A-Za-zぁ-んァ-ヶｱ-ﾝﾞﾟ一-龠]', line):
                                section_num = prev_line
                                section_title = line

                if section_num and section_title:
                    section_title = re.sub(r'[\s\.\d]+$', '', section_title).strip()
                    
                    if not section_title or len(section_title) > 30:
                        continue
                        
                    if section_title.endswith(('。', '、', '.', ',')):
                        continue
                        
                    if '=' in section_title or '+' in section_title:
                        continue
                        
                    level = len(section_num.split('.')) 
                    fallback_toc.append([level, f"{section_num} {section_title}", page_num + 1])
                    
        self.full_text = "\n".join(text_blocks)
        
        metadata_toc = self.doc.get_toc()
        if metadata_toc:
            self.toc = metadata_toc
        else:
            toc_dict = {}
            for item in fallback_toc:
                sec_num = item[1].split(' ')[0]
                sec_title = item[1][len(sec_num):].strip()
                
                if sec_num not in toc_dict:
                    toc_dict[sec_num] = item
                else:
                    existing_title = toc_dict[sec_num][1][len(sec_num):].strip()
                    if existing_title.startswith(sec_title[:3]) or sec_title.startswith(existing_title[:3]):
                        toc_dict[sec_num] = item
            
            self.toc = list(toc_dict.values())
            
        self._extract_references()
        self._map_citation_pages()
        
        # 🌟 追加: テキスト抽出が完了したらベクトルDBを構築する
        self._build_vectorstore()

    def _extract_references(self):
        # 見出しとして1行に単独で書かれた「References」等を優先する（本文やタイトル中の単語で切らないため）
        headings = list(re.finditer(
            r'^[ \t]*(?:\d+\.?[ \t]*)?(?:参考文献|References|Bibliography)[ \t]*:?[ \t]*$',
            self.full_text, flags=re.IGNORECASE | re.MULTILINE))
        if headings:
            ref_split = [self.full_text[:headings[-1].start()], self.full_text[headings[-1].end():]]
        else:
            ref_split = re.split(r'参考文献|References', self.full_text, flags=re.IGNORECASE)
        
        if len(ref_split) > 1:
            ref_section = ref_split[-1] 
            
            pattern = r'\[(\d+)\]\s*(.*?)(?=\[\d+\]|$)'
            matches = re.findall(pattern, ref_section, re.DOTALL)
            
            for match in matches:
                ref_num = f"[{match[0]}]" 
                ref_text = match[1].strip().replace('\n', ' ') 
                self.references[ref_num] = ref_text

    @staticmethod
    def _expand_citation_numbers(group: str) -> set:
        """"1,2" や "1-3" のような角括弧内の引用番号を {1, 2, 3} に展開する"""
        numbers = set()
        for part in re.split(r'\s*,\s*', group):
            bounds = re.split(r'\s*[-–—]\s*', part)
            if len(bounds) == 2 and 0 <= int(bounds[1]) - int(bounds[0]) <= 100:
                numbers.update(range(int(bounds[0]), int(bounds[1]) + 1))
            else:
                numbers.update(int(b) for b in bounds)
        return numbers

    def _map_citation_pages(self):
        for ref_num in self.references.keys():
            self.citation_pages[ref_num] = []

        # [1] だけでなく [1,2] や [1-3] のような複合引用も対象にする
        pattern = re.compile(r'\[(\d+(?:\s*[,\-–—]\s*\d+)*)\]')
        for page_num, text in self.page_texts.items():
            cited = set()
            for match in pattern.finditer(text):
                cited |= self._expand_citation_numbers(match.group(1))
            for number in sorted(cited):
                ref_num = f"[{number}]"
                if ref_num in self.citation_pages:
                    self.citation_pages[ref_num].append(page_num)

    def get_context_around(self, search_text: str, window_size: int = 400) -> str:
        """指定したテキストの前後（window_size文字）を、ページを跨いで抽出する"""
        if not search_text:
            return ""
            
        match_index = self.full_text.find(search_text)
        if match_index == -1:
            return search_text 
            
        start = max(0, match_index - window_size)
        end = min(len(self.full_text), match_index + len(search_text) + window_size)
        
        return self.full_text[start:end]

    # 🌟🌟🌟 ここから下がRAG用の新規メソッド 🌟🌟🌟

    def _build_vectorstore(self):
        """PDFのページテキストをチャンク化し、FAISSベクトルDBを構築する"""
        print("🧠 知識をベクトル化しています（FAISS構築中）...")
        try:
            docs = []
            # ページごとにDocumentオブジェクトを作成（メタデータにページ番号を保持）
            for page_num, text in self.page_texts.items():
                if text.strip():
                    docs.append(Document(page_content=text, metadata={"page": page_num, "source": self.file_path}))

            # テキストを意味の塊（約500文字）ごとに分割
            text_splitter = RecursiveCharacterTextSplitter(
                chunk_size=500,
                chunk_overlap=50,
                separators=["\n\n", "\n", "。", "、", " ", ""]
            )
            split_docs = text_splitter.split_documents(docs)

            # OllamaのEmbeddingモデルを使用してベクトル化
            embeddings = OllamaEmbeddings(model="mxbai-embed-large")

            # FAISSデータベースの作成
            self.vectorstore = FAISS.from_documents(split_docs, embeddings)
            print("✅ ベクトルDBの構築が完了しました！")
        except Exception as e:
            print(f"⚠️ ベクトルDBの構築に失敗しました: {e}")
            traceback.print_exc()

    def similarity_search(self, query: str, k: int = 3) -> str:
        """
        質問(query)に対して、関連するテキストをベクトルDBから検索し、
        LLMのプロンプトに埋め込みやすい文字列フォーマットで返す。
        """
        if not self.vectorstore:
            return "ベクトルDBが構築されていないため、検索できません。"

        # 関連度の高いチャンクを上位 k 件取得
        results = self.vectorstore.similarity_search(query, k=k)

        context_str = ""
        for i, res in enumerate(results):
            page = res.metadata.get('page', '?')
            context_str += f"[参照元: p.{page}]\n{res.page_content}\n\n"

        return context_str.strip()

if __name__ == "__main__":
    test_pdf_path = "sample.pdf" 
    
    try:
        parser = PaperParser(test_pdf_path)
        
        print("\n🔍 RAG ベクトル検索テスト:")
        query = "コロイドの粘度"
        print(f"質問: {query}")
        print("-" * 30)
        print(parser.similarity_search(query, k=2))
        print("-" * 30)
        
    except Exception as e:
        print(f"エラーが発生しました: {e}")