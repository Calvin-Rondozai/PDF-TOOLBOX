"""JSON CLI for Electron — reads one JSON object from stdin, writes result to stdout."""

import json
import os
import sys

from pdf_engine import (
    add_watermark,
    apply_edits,
    compress_standard,
    compress_to_target_kb,
    delete_pages,
    duplicate_pages,
    extract_all_text,
    extract_page_text,
    extract_pdf_for_ai,
    get_page_count,
    get_pdf_preview,
    get_text_spans,
    get_tts_voices,
    images_to_pdf,
    merge_pdfs,
    ocr_pdf,
    office_to_pdf,
    password_protect_pdf,
    pdf_needs_ocr,
    pdf_to_images,
    pdf_to_office,
    render_page_png,
    reorder_pages,
    resize_pdf_pages,
    rotate_pdf_pages,
    rotate_pdf_pages_map,
    tesseract_available,
    save_tts_audio,
    search_pdf,
    split_pdf_individual,
    split_pdf_range,
)


def _progress(val, maximum, message):
    print(json.dumps({"type": "progress", "val": val, "max": maximum, "msg": message}), flush=True)


def handle(req):
    op = req.get("op")
    if op == "ping":
        return {"ok": True, "detail": "pong"}

    if op == "get_page_count":
        return {"ok": True, "count": get_page_count(req["path"])}

    if op == "pdf_preview":
        dpi = int(req.get("dpi", 96))
        ok, pages, b64, w, h = get_pdf_preview(req["path"], dpi)
        return {"ok": ok, "pages": pages, "image": b64, "width": w, "height": h}

    if op == "extract_page_text":
        return {"ok": True, "text": extract_page_text(req["path"], req["page"])}

    if op == "render_page":
        dpi = int(req.get("dpi", 150))
        zoom = float(req.get("zoom", 1.0))
        highlights = req.get("highlights")
        active_hi = int(req.get("active_hi", -1))
        rotation = int(req.get("rotation", 0))
        ok, b64, w, h = render_page_png(
            req["path"], req["page"], dpi, zoom, highlights, active_hi, rotation
        )
        return {"ok": ok, "image": b64, "width": w, "height": h}

    if op == "get_text_spans":
        return {"ok": True, "spans": get_text_spans(req["path"], req["page"])}

    if op == "check_tesseract":
        return {"ok": True, "available": tesseract_available()}

    if op == "search":
        return {"ok": True, "results": search_pdf(req["path"], req["query"])}

    if op == "extract_all_text":
        return {"ok": True, "text": extract_all_text(req["path"])}

    if op == "extract_pdf_for_ai":
        data = extract_pdf_for_ai(req["path"])
        return {"ok": True, **data}

    if op == "get_tts_voices":
        return {"ok": True, "voices": get_tts_voices()}

    if op == "save_tts":
        text = req.get("text") or extract_all_text(req["path"])
        ok = save_tts_audio(text, req["out"], req.get("voice_id"), req.get("rate", 175))
        return {"ok": ok, "detail": "Audio saved." if ok else "TTS failed."}

    if op == "merge":
        ok = merge_pdfs(req["paths"], req["out"], _progress)
        return {"ok": ok, "detail": f"Merged {len(req['paths'])} files." if ok else "Merge failed."}

    if op == "compress_kb":
        ok, kb = compress_to_target_kb(req["inp"], req["out"], req["target_kb"], _progress)
        orig = os.path.getsize(req["inp"]) / 1024
        detail = f"Target: {req['target_kb']:.0f} KB\nResult: {kb:.1f} KB\nOriginal: {orig:.1f} KB"
        return {"ok": ok, "detail": detail, "result_kb": kb}

    if op == "compress_std":
        ok = compress_standard(req["inp"], req["out"], req.get("level", "balanced"), _progress)
        orig = os.path.getsize(req["inp"]) / 1024
        new_kb = os.path.getsize(req["out"]) / 1024 if ok else 0
        saved = max(0, (1 - new_kb / orig) * 100) if orig else 0
        detail = f"Original: {orig:.1f} KB\nCompressed: {new_kb:.1f} KB\nSaved: {saved:.1f}%"
        return {"ok": ok, "detail": detail}

    if op == "resize":
        ok = resize_pdf_pages(req["inp"], req["out"], req["w_mm"], req["h_mm"], _progress)
        detail = "Resize complete." if ok else "Resize failed."
        if ok:
            new_kb = os.path.getsize(req["out"]) / 1024
            detail = f"Page size: {req['w_mm']:.0f} × {req['h_mm']:.0f} mm\nOutput: {new_kb:.1f} KB"
        return {"ok": ok, "detail": detail}

    if op == "split_all":
        ok, paths = split_pdf_individual(req["inp"], req["out_dir"], req["base"], _progress)
        return {
            "ok": ok,
            "detail": f"Split into {len(paths)} files." if ok else "Split failed.",
            "paths": paths,
        }

    if op == "split_range":
        ok = split_pdf_range(req["inp"], req["out"], req["start"], req["end"], _progress)
        n = req["end"] - req["start"] + 1
        return {"ok": ok, "detail": f"Extracted {n} page(s)." if ok else "Extract failed."}

    if op == "rotate":
        ok = rotate_pdf_pages(
            req["inp"], req["out"], req["degrees"], req.get("pages"), _progress
        )
        return {"ok": ok, "detail": f"Rotated by {req['degrees']}°." if ok else "Rotate failed."}

    if op == "watermark":
        ok = add_watermark(
            req["inp"], req["out"], req["text"], req.get("opacity", 0.25), _progress
        )
        return {"ok": ok, "detail": f"Watermark added: {req['text']}" if ok else "Watermark failed."}

    if op == "password":
        ok = password_protect_pdf(
            req["inp"], req["out"], req["user_pw"], req.get("owner_pw"), _progress
        )
        return {"ok": ok, "detail": "PDF encrypted." if ok else "Encryption failed."}

    if op == "needs_ocr":
        return {"ok": True, "needs_ocr": pdf_needs_ocr(req["path"])}

    if op == "ocr":
        if not tesseract_available():
            return {
                "ok": False,
                "detail": "Tesseract OCR is not installed. Install from https://github.com/tesseract-ocr/tesseract",
            }
        ok = ocr_pdf(req["inp"], req["out"], req.get("language", "eng"), _progress)
        return {"ok": ok, "detail": "OCR complete — PDF is now searchable." if ok else "OCR failed on this document."}

    if op == "apply_edits":
        ok = apply_edits(req["inp"], req["out"], req.get("edits", []), _progress)
        return {"ok": ok, "detail": "Edits saved." if ok else "Failed to save edits."}

    if op == "reorder_pages":
        ok = reorder_pages(req["inp"], req["out"], req["order"], _progress)
        return {"ok": ok, "detail": "Pages rearranged." if ok else "Reorder failed."}

    if op == "delete_pages":
        ok = delete_pages(req["inp"], req["out"], req["pages"], _progress)
        return {"ok": ok, "detail": "Pages deleted." if ok else "Delete failed."}

    if op == "duplicate_pages":
        ok = duplicate_pages(req["inp"], req["out"], req["pages"], _progress)
        return {"ok": ok, "detail": "Pages duplicated." if ok else "Duplicate failed."}

    if op == "rotate_map":
        ok = rotate_pdf_pages_map(req["inp"], req["out"], req["page_degrees"], _progress)
        return {"ok": ok, "detail": "Pages rotated." if ok else "Rotate failed."}

    if op == "convert_office_to_pdf":
        ok, detail = office_to_pdf(req["inp"], req["out"], _progress)
        return {"ok": ok, "detail": detail}

    if op == "convert_pdf_to_office":
        ok, detail = pdf_to_office(req["inp"], req["out"], req["format"], _progress)
        return {"ok": ok, "detail": detail}

    if op == "convert_images_to_pdf":
        ok, detail = images_to_pdf(req["paths"], req["out"], _progress)
        return {"ok": ok, "detail": detail}

    if op == "convert_pdf_to_images":
        ok, paths = pdf_to_images(
            req["inp"],
            req["out_dir"],
            req.get("format", "png"),
            int(req.get("dpi", 150)),
            _progress,
        )
        return {
            "ok": ok,
            "paths": paths if ok else [],
            "detail": f"Exported {len(paths)} image(s)." if ok else "Export failed.",
        }

    return {"ok": False, "detail": f"Unknown op: {op}"}


def main():
    try:
        raw = sys.stdin.read()
        req = json.loads(raw) if raw.strip() else {"op": "ping"}
        result = handle(req)
        print(json.dumps({"type": "result", **result}), flush=True)
    except Exception as ex:
        print(json.dumps({"type": "result", "ok": False, "detail": str(ex)}), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
