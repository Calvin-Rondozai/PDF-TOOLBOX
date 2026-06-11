"""Integration tests for PDF engine — creates a sample PDF and exercises all operations."""

import os
import sys
import tempfile
import shutil

sys.path.insert(0, os.path.dirname(__file__))

import fitz
from pdf_engine import (
    add_watermark,
    compress_standard,
    compress_to_target_kb,
    extract_page_text,
    get_page_count,
    merge_pdfs,
    password_protect_pdf,
    resize_pdf_pages,
    rotate_pdf_pages,
    split_pdf_individual,
    split_pdf_range,
)


def make_sample_pdf(path, pages=3):
    doc = fitz.open()
    for i in range(pages):
        page = doc.new_page(width=595, height=842)
        page.insert_text((72, 72), f"Hello C PDF Tool — Page {i + 1}", fontsize=24)
        page.insert_text((72, 120), "This is a test document for integration testing.", fontsize=12)
    doc.save(path)
    doc.close()


def test_all():
    tmp = tempfile.mkdtemp(prefix="pdf_tool_test_")
    passed = 0
    failed = 0

    def check(name, cond, detail=""):
        nonlocal passed, failed
        if cond:
            print(f"  PASS  {name}")
            passed += 1
        else:
            print(f"  FAIL  {name} — {detail}")
            failed += 1

    try:
        src = os.path.join(tmp, "sample.pdf")
        make_sample_pdf(src, pages=3)
        print(f"Sample PDF: {src} ({os.path.getsize(src)} bytes)")

        check("get_page_count", get_page_count(src) == 3)
        check("extract_page_text", "Page 1" in extract_page_text(src, 0))

        # Merge
        src2 = os.path.join(tmp, "sample2.pdf")
        make_sample_pdf(src2, pages=1)
        merged = os.path.join(tmp, "merged.pdf")
        check("merge_pdfs", merge_pdfs([src, src2], merged) and get_page_count(merged) == 4)

        # Split range
        extracted = os.path.join(tmp, "extracted.pdf")
        check("split_pdf_range", split_pdf_range(src, extracted, 0, 1) and get_page_count(extracted) == 2)

        # Split individual
        split_dir = os.path.join(tmp, "split_out")
        os.makedirs(split_dir)
        ok, paths = split_pdf_individual(src, split_dir, "page")
        check("split_pdf_individual", ok and len(paths) == 3)

        # Rotate
        rotated = os.path.join(tmp, "rotated.pdf")
        check("rotate_pdf_pages", rotate_pdf_pages(src, rotated, 90) and os.path.exists(rotated))

        # Watermark
        wm = os.path.join(tmp, "watermarked.pdf")
        check("add_watermark", add_watermark(src, wm, "TEST") and os.path.exists(wm))

        # Password
        protected = os.path.join(tmp, "protected.pdf")
        check("password_protect_pdf", password_protect_pdf(src, protected, "secret123") and os.path.exists(protected))

        # Compress standard
        compressed = os.path.join(tmp, "compressed.pdf")
        check("compress_standard", compress_standard(src, compressed, "light") and os.path.exists(compressed))

        # Compress to target
        target = os.path.join(tmp, "target_kb.pdf")
        ok, kb = compress_to_target_kb(src, target, 500)
        check("compress_to_target_kb", ok and os.path.exists(target), f"result={kb:.1f}KB")

        # Resize
        resized = os.path.join(tmp, "resized.pdf")
        check("resize_pdf_pages", resize_pdf_pages(src, resized, 148, 210) and os.path.exists(resized))

        print(f"\nResults: {passed} passed, {failed} failed")
        return failed == 0

    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    ok = test_all()
    sys.exit(0 if ok else 1)
