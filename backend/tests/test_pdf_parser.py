import pytest
from pdf_parser import PaperParser


@pytest.fixture
def paper(make_pdf, no_vectorstore):
    path = make_pdf([
        ["1 Introduction", "Colloids are studied widely [1].", "Viscosity matters [2]."],
        ["2 Methods", "2.1 Setup", "We follow the approach of [2]."],
        ["References", "[1] A. Einstein, On the motion of small particles, 1905.",
         "[2] J. Perrin, Brownian movement, 1909."],
    ])
    return PaperParser(path)


def test_fallback_toc_from_section_numbers(paper):
    titles = [(lvl, title, page) for lvl, title, page in paper.toc]
    assert (1, "1 Introduction", 1) in titles
    assert (1, "2 Methods", 2) in titles
    assert (2, "2.1 Setup", 2) in titles


def test_metadata_toc_takes_priority(make_pdf, no_vectorstore):
    path = make_pdf([["1 Introduction"]], toc=[[1, "Embedded TOC", 1]])
    assert PaperParser(path).toc == [[1, "Embedded TOC", 1]]


def test_references_extracted(paper):
    assert set(paper.references) == {"[1]", "[2]"}
    assert "Einstein" in paper.references["[1]"]
    assert "Perrin" in paper.references["[2]"]


def test_citation_pages(paper):
    # 参考文献リスト自身のページ(3)も含まれる（現仕様）
    assert paper.citation_pages["[1]"] == [1, 3]
    assert paper.citation_pages["[2]"] == [1, 2, 3]


def test_get_context_around(paper):
    ctx = paper.get_context_around("Viscosity matters", window_size=20)
    assert "Viscosity matters" in ctx
    assert len(ctx) <= len("Viscosity matters") + 40


def test_get_context_around_not_found_returns_input(paper):
    assert paper.get_context_around("no such text") == "no such text"
    assert paper.get_context_around("") == ""


def test_similarity_search_without_vectorstore(paper):
    assert "構築されていない" in paper.similarity_search("anything")


def test_no_references_section(make_pdf, no_vectorstore):
    p = PaperParser(make_pdf([["1 Intro", "text [1]"]]))
    assert p.references == {}
    assert p.citation_pages == {}


def test_reference_titles_containing_word_references(make_pdf, no_vectorstore):
    p = PaperParser(make_pdf([
        ["Body [1]"],
        ["References", "[1] A. Author, Cross-references in physics, 2001.", "[2] B. Author, Other, 2002."],
    ]))
    assert set(p.references) == {"[1]", "[2]"}


def test_grouped_citations_are_mapped(make_pdf, no_vectorstore):
    p = PaperParser(make_pdf([
        ["Body text [1,2]."],
        ["References", "[1] A. One, 2001.", "[2] B. Two, 2002."],
    ]))
    assert 1 in p.citation_pages["[1]"]



def test_citation_ranges_are_expanded(make_pdf, no_vectorstore):
    p = PaperParser(make_pdf([
        ["Body text [1-3] and [5]."],
        ["More [2, 4]."],
        ["References", "[1] A, 2001.", "[2] B, 2002.", "[3] C, 2003.", "[4] D, 2004.", "[5] E, 2005."],
    ]))
    assert p.citation_pages["[1]"] == [1, 3]
    assert p.citation_pages["[2]"] == [1, 2, 3]
    assert p.citation_pages["[4]"] == [2, 3]
    assert p.citation_pages["[5]"] == [1, 3]
