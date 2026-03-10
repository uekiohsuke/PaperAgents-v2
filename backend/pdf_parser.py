import fitz  # PyMuPDF
import re

class PaperParser:
    def __init__(self, file_path: str):
        self.file_path = file_path
        self.doc = fitz.open(file_path)
        
        self.full_text = ""
        self.toc = []
        self.references = {}
        
        # 初期化時に自動で全解析を走らせる
        self._parse_all()

    def _parse_all(self):
        text_blocks = []
        fallback_toc = [] # 変更：自前目次を一時保存するリスト
        
        for page_num in range(len(self.doc)):
            page = self.doc[page_num]
            text = page.get_text()
            text_blocks.append(text)
            
            lines = text.split('\n')
            for i in range(len(lines)):
                line = lines[i].strip()
                if not line:
                    continue
                    
                section_num = None
                section_title = None
                
                # パターンA：同じ行に番号とタイトル
                match_same = re.match(r'^([1-9]\d*(?:\.\d+)*)\s+([A-Za-zぁ-んァ-ヶｱ-ﾝﾞﾟ一-龠].*)$', line)
                if match_same:
                    section_num = match_same.group(1)
                    section_title = match_same.group(2)
                else:
                    # パターンB：改行で分断されている場合
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
                        
                    # 数式特有の記号を含む場合は除外
                    if '=' in section_title or '+' in section_title:
                        continue
                        
                    level = len(section_num.split('.')) 
                    fallback_toc.append([level, f"{section_num} {section_title}", page_num + 1])
                    
        self.full_text = "\n".join(text_blocks)
        
        metadata_toc = self.doc.get_toc()
        if metadata_toc:
            self.toc = metadata_toc
        else:
            # タイトルの矛盾検知
            toc_dict = {}
            for item in fallback_toc:
                sec_num = item[1].split(' ')[0]
                sec_title = item[1][len(sec_num):].strip()
                
                if sec_num not in toc_dict:
                    # 初めて見つけた番号ならそのまま登録
                    toc_dict[sec_num] = item
                else:
                    # 既に同じ番号が登録されている場合
                    existing_title = toc_dict[sec_num][1][len(sec_num):].strip()
                    
                    # 最初の3文字が同じであれば、ページ番号を目次ページから本文のページへ更新する
                    if existing_title.startswith(sec_title[:3]) or sec_title.startswith(existing_title[:3]):
                        toc_dict[sec_num] = item
            
            self.toc = list(toc_dict.values())
            
        self._extract_references()

    def _extract_references(self):
        # 「参考文献」や「References」という文字以降を切り出す
        ref_split = re.split(r'参考文献|References', self.full_text, flags=re.IGNORECASE)
        
        if len(ref_split) > 1:
            ref_section = ref_split[-1] # 一番最後の分割部分を参考文献セクションとする
            
            # [1] 文献名... [2] 文献名... のパターンを抽出
            pattern = r'\[(\d+)\]\s*(.*?)(?=\[\d+\]|$)'
            matches = re.findall(pattern, ref_section, re.DOTALL)
            
            for match in matches:
                ref_num = f"[{match[0]}]" # "[1]" の形にする
                ref_text = match[1].strip().replace('\n', ' ') # 改行を取り除く
                self.references[ref_num] = ref_text

    def get_context_around(self, search_text: str, window_size: int = 400) -> str:
        """指定したテキストの前後（window_size文字）を、ページを跨いで抽出する"""
        if not search_text:
            return ""
            
        match_index = self.full_text.find(search_text)
        if match_index == -1:
            return search_text # 見つからなければそのまま返す
            
        start = max(0, match_index - window_size)
        end = min(len(self.full_text), match_index + len(search_text) + window_size)
        
        return self.full_text[start:end]

if __name__ == "__main__":
    test_pdf_path = "sample.pdf" 
    
    try:
        parser = PaperParser(test_pdf_path)
        
        print("✅ PDFの解析が完了しました！\n")
        print(f"📄 総文字数: {len(parser.full_text)} 文字")
        
        print("\n📑 抽出された目次:")
        for item in parser.toc:
            print(f"  - レベル{item[0]}: {item[1]} (p.{item[2]})")
            
        print("\n📚 抽出された参考文献:")
        for num, text in parser.references.items():
            print(f"  {num}: {text[:50]}...")
            
        print("\n🔍 文脈抽出テスト（'ブラウン運動' の前後50文字）:")
        print(parser.get_context_around("原理", 400))
        
    except Exception as e:
        print(f"エラーが発生しました: {e}")