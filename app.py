"""
╔══════════════════════════════════════════════════════════╗
║          Hello C  —  Professional PDF Reader             ║
║                   Windows Edition                        ║
╠══════════════════════════════════════════════════════════╣
║  SETUP  (one-time, run in Command Prompt)                ║
║                                                          ║
║  pip install PyQt6 pymupdf pypdf Pillow pyttsx3          ║
║  pip install playsound==1.2.2                            ║
╚══════════════════════════════════════════════════════════╝

CHANGES vs original:
  - Continuous-scroll viewer: all pages rendered into one vertical canvas
  - TTS highlight fires AFTER runAndWait() so voice and highlight stay in sync
  - Word-level highlight uses re.search() with fallback instead of fragile pos tracker
  - _stop_reading() is safe to call from any thread state
"""

import os, sys, math, struct, wave, tempfile, threading, shutil


# ── Dependency bootstrap ──────────────────────────────────────────────────────
def _need(pkg, install):
    import subprocess
    from PyQt6.QtWidgets import QApplication, QMessageBox

    app = QApplication.instance() or QApplication(sys.argv)
    QMessageBox.critical(
        None,
        "Missing Package",
        f"<b>{pkg}</b> is not installed.<br><br>"
        f"Run in Command Prompt:<br><code>{install}</code><br><br>"
        "Then restart Hello C.",
    )
    sys.exit(1)


try:
    from PyQt6.QtWidgets import (
        QApplication,
        QMainWindow,
        QWidget,
        QFrame,
        QLabel,
        QPushButton,
        QScrollArea,
        QFileDialog,
        QMessageBox,
        QDialog,
        QVBoxLayout,
        QHBoxLayout,
        QGridLayout,
        QRadioButton,
        QButtonGroup,
        QLineEdit,
        QProgressBar,
        QSizePolicy,
        QGraphicsDropShadowEffect,
        QStackedWidget,
        QSplitter,
        QToolButton,
        QSpacerItem,
        QComboBox,
        QSlider,
        QTextEdit,
    )
    from PyQt6.QtCore import (
        Qt,
        QThread,
        pyqtSignal,
        QTimer,
        QPropertyAnimation,
        QEasingCurve,
        QSize,
        QPoint,
        QRect,
        pyqtProperty,
        QObject,
    )
    from PyQt6.QtGui import (
        QPixmap,
        QImage,
        QFont,
        QFontDatabase,
        QPainter,
        QColor,
        QPalette,
        QIcon,
        QCursor,
        QPen,
        QBrush,
        QLinearGradient,
        QRadialGradient,
        QPainterPath,
        QKeySequence,
        QShortcut,
    )
except ImportError:
    import tkinter as _tk, tkinter.messagebox as _mb

    _tk.Tk().withdraw()
    _mb.showerror(
        "Missing Package",
        "PyQt6 is not installed.\n\nRun:\n  pip install PyQt6\n\nThen restart.",
    )
    sys.exit(1)

try:
    import fitz
except ImportError:
    _need("pymupdf", "pip install pymupdf")

try:
    from PIL import Image
except ImportError:
    _need("Pillow", "pip install Pillow")

try:
    from pypdf import PdfReader, PdfWriter
except ImportError:
    _need("pypdf", "pip install pypdf")

try:
    import pyttsx3

    TTS_AVAILABLE = True
except ImportError:
    TTS_AVAILABLE = False

try:
    from playsound import playsound

    SOUND_AVAILABLE = True
except ImportError:
    SOUND_AVAILABLE = False


# ─────────────────────────────────────────────────────────────────────────────
#  Sound System
# ─────────────────────────────────────────────────────────────────────────────
_SOUND_DIR = os.path.join(tempfile.gettempdir(), "trixie_sounds")
os.makedirs(_SOUND_DIR, exist_ok=True)


def _make_wav(filename, notes, volume=0.35, sr=44100):
    path = os.path.join(_SOUND_DIR, filename)
    if os.path.exists(path):
        return path
    frames = []
    for freq, dur_ms in notes:
        n = int(sr * dur_ms / 1000)
        for i in range(n):
            t = i / sr
            val = math.sin(2 * math.pi * freq * t)
            env = min(i, n - i, int(sr * 0.008)) / int(sr * 0.008)
            env = max(0.0, min(1.0, env))
            frames.append(int(val * env * volume * 32767))
    with wave.open(path, "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(struct.pack(f"<{len(frames)}h", *frames))
    return path


_SOUNDS = {
    "open": _make_wav("open.wav", [(523, 80), (659, 130)]),
    "success": _make_wav("success.wav", [(523, 70), (659, 70), (784, 150)]),
    "error": _make_wav("error.wav", [(330, 100), (262, 180)]),
    "click": _make_wav("click.wav", [(1047, 25)]),
    "done": _make_wav("done.wav", [(523, 80), (659, 80), (784, 80), (1047, 190)]),
}


def play(name):
    if not SOUND_AVAILABLE:
        return
    path = _SOUNDS.get(name)
    if path:
        threading.Thread(
            target=lambda: playsound(path, block=True), daemon=True
        ).start()


# ─────────────────────────────────────────────────────────────────────────────
#  PDF Backend
# ─────────────────────────────────────────────────────────────────────────────


def render_page_qpixmap(pdf_path, page_index, dpi=150):
    doc = fitz.open(pdf_path)
    page = doc[page_index]
    mat = fitz.Matrix(dpi / 72, dpi / 72)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    doc.close()
    img = QImage(
        pix.samples, pix.width, pix.height, pix.stride, QImage.Format.Format_RGB888
    )
    return QPixmap.fromImage(img)


def render_page_highlighted(
    pdf_path, page_index, char_start, char_end, page_text, dpi=150
):
    """
    Render a single page with the sentence [char_start:char_end] highlighted.
    Returns a QPixmap.  Falls back to a plain render on any error.
    """
    try:
        doc = fitz.open(pdf_path)
        page = doc[page_index]
        full = page_text

        # get_text("words") → (x0,y0,x1,y1, word, block_no, line_no, word_no)
        word_list = page.get_text("words")

        # Rebuild char offsets for each word by scanning the full page text
        hit_rects = []
        search_pos = 0
        for item in word_list:
            x0, y0, x1, y1, word = item[0], item[1], item[2], item[3], item[4]
            idx = full.find(word, search_pos)
            if idx == -1:
                # Try from beginning (rare case where find fails linearly)
                idx = full.find(word)
            if idx == -1:
                continue
            w_start = idx
            w_end = idx + len(word)
            # Advance search_pos so next word search starts just past this one
            search_pos = w_start + 1

            # Overlap check
            if w_end > char_start and w_start < char_end:
                hit_rects.append(fitz.Rect(x0, y0, x1, y1))

        # Merge rects on the same text line (y0 within 4pt of each other)
        scroll_y = None
        if hit_rects:
            hit_rects.sort(key=lambda r: (round(r.y0), r.x0))
            merged = []
            for r in hit_rects:
                if merged and abs(r.y0 - merged[-1].y0) < 4:
                    prev = merged[-1]
                    merged[-1] = fitz.Rect(
                        min(prev.x0, r.x0),
                        prev.y0,
                        max(prev.x1, r.x1),
                        max(prev.y1, r.y1),
                    )
                else:
                    merged.append(fitz.Rect(r))

            shape = page.new_shape()
            for r in merged:
                shape.draw_rect(fitz.Rect(r.x0, r.y0 - 1, r.x1, r.y1 + 1))
            shape.finish(
                fill=(1.0, 0.92, 0.0),
                color=(0.85, 0.70, 0.0),
                width=0.3,
                fill_opacity=0.50,
            )
            shape.commit()

            scale = dpi / 72
            scroll_y = max(0, int(merged[0].y0 * scale) - 80)

        pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72), alpha=False)
        doc.close()

        img = QImage(
            pix.samples,
            pix.width,
            pix.height,
            pix.stride,
            QImage.Format.Format_RGB888,
        )
        return QPixmap.fromImage(img), scroll_y

    except Exception as ex:
        print(f"render_page_highlighted error: {ex}")
        import traceback

        traceback.print_exc()
        return render_page_qpixmap(pdf_path, page_index, dpi), None


def extract_page_text(pdf_path, page_index):
    try:
        doc = fitz.open(pdf_path)
        txt = doc[page_index].get_text()
        doc.close()
        return txt or ""
    except:
        return ""


def get_page_count(pdf_path):
    try:
        doc = fitz.open(pdf_path)
        n = doc.page_count
        doc.close()
        return n
    except:
        return 0


def _render_to_bytes(fitz_doc, q, dpi=150):
    out = fitz.open()
    scale = dpi / 72
    mat = fitz.Matrix(scale, scale)
    for page in fitz_doc:
        pix = page.get_pixmap(matrix=mat, alpha=False)
        jpeg_bytes = pix.tobytes(output="jpeg", jpg_quality=q)
        img_pdf_buf = fitz.open("jpeg", jpeg_bytes).convert_to_pdf()
        img_doc = fitz.open("pdf", img_pdf_buf)
        out.insert_pdf(img_doc)
        img_doc.close()
    buf = out.tobytes(deflate=True)
    out.close()
    return buf


def compress_to_target_kb(inp, out_path, target_kb, cb=None):
    import shutil as _sh

    tb = int(target_kb * 1024)
    if os.path.getsize(inp) <= tb:
        _sh.copy2(inp, out_path)
        if cb:
            cb(100, 100, "Already within target.")
        return True, os.path.getsize(inp) / 1024
    src = fitz.open(inp)
    best = None
    dpis = [150, 120, 96, 72, 48, 30]
    total = len(dpis) * 8
    step = [0]
    for dpi in dpis:
        lo, hi, found = 10, 85, False
        for _ in range(8):
            mq = (lo + hi) // 2
            step[0] += 1
            if cb:
                cb(step[0], total, f"Trying {dpi} DPI  q{mq}…")
            buf = _render_to_bytes(src, mq, dpi)
            if len(buf) <= tb:
                best = buf
                lo = mq + 1
                found = True
            else:
                hi = mq - 1
        if found:
            break
    src.close()
    if best is None:
        s2 = fitz.open(inp)
        best = _render_to_bytes(s2, 10, 30)
        s2.close()
    if cb:
        cb(total, total, "Saving…")
    with open(out_path, "wb") as f:
        f.write(best)
    return True, len(best) / 1024


def resize_pdf_pages(inp, out_path, w_mm, h_mm, cb=None):
    try:
        PTS_PER_MM = 72.0 / 25.4
        nw = w_mm * PTS_PER_MM
        nh = h_mm * PTS_PER_MM

        src = fitz.open(inp)
        out = fitz.open()
        tot = src.page_count

        for i in range(tot):
            if cb:
                cb(i + 1, tot, f"Resizing page {i + 1} of {tot}…")

            pg = src[i]
            src_w = pg.rect.width
            src_h = pg.rect.height

            mat = fitz.Matrix(150 / 72, 150 / 72)
            pix = pg.get_pixmap(matrix=mat, alpha=False)

            img_bytes = pix.tobytes("jpeg", jpg_quality=92)
            img_pdf_buf = fitz.open("jpeg", img_bytes).convert_to_pdf()
            img_doc = fitz.open("pdf", img_pdf_buf)

            scale = min(nw / src_w, nh / src_h)
            dst_w = src_w * scale
            dst_h = src_h * scale
            x0 = (nw - dst_w) / 2.0
            y0 = (nh - dst_h) / 2.0

            new_pg = out.new_page(width=nw, height=nh)
            new_pg.show_pdf_page(
                fitz.Rect(x0, y0, x0 + dst_w, y0 + dst_h),
                img_doc,
                0,
            )
            img_doc.close()

        if cb:
            cb(tot, tot, "Saving…")

        out.save(out_path, deflate=True, garbage=4, clean=True)
        src.close()
        out.close()
        return True

    except Exception as e:
        print(f"resize_pdf_pages error: {e}")
        import traceback

        traceback.print_exc()
        return False


def compress_standard(inp, out_path, level="balanced", cb=None):
    try:
        src = fitz.open(inp)
        if cb:
            cb(10, 100, "Compressing…")
        if level == "light":
            src.save(out_path, deflate=True, garbage=4, clean=True)
        else:
            dpi = 120 if level == "balanced" else 72
            q = 85 if level == "balanced" else 60
            buf = _render_to_bytes(src, q, dpi)
            if cb:
                cb(90, 100, "Saving…")
            with open(out_path, "wb") as f:
                f.write(buf)
        src.close()
        if cb:
            cb(100, 100, "Done.")
        return True
    except Exception as e:
        print(e)
        return False


# ─────────────────────────────────────────────────────────────────────────────
#  File Operations Backend
# ─────────────────────────────────────────────────────────────────────────────


def split_pdf_range(inp, out_path, start_page, end_page, cb=None):
    try:
        src = fitz.open(inp)
        new_pdf = fitz.open()
        total = end_page - start_page + 1
        for i, pg_i in enumerate(range(start_page, end_page + 1)):
            if cb:
                cb(i + 1, total, f"Extracting page {pg_i + 1}...")
            new_pdf.insert_pdf(src, from_page=pg_i, to_page=pg_i)
        if cb:
            cb(total, total, "Saving...")
        new_pdf.save(out_path, deflate=True, garbage=4)
        new_pdf.close()
        src.close()
        return True
    except Exception as e:
        import traceback

        traceback.print_exc()
        print(f"split_pdf_range error: {e}")
        return False


def split_pdf_individual(inp, out_dir, base_name, cb=None):
    try:
        src = fitz.open(inp)
        total = src.page_count
        paths = []
        for i in range(total):
            if cb:
                cb(i + 1, total, f"Saving page {i + 1} of {total}...")
            one = fitz.open()
            one.insert_pdf(src, from_page=i, to_page=i)
            p = os.path.join(out_dir, f"{base_name}_p{i+1:03d}.pdf")
            one.save(p, deflate=True, garbage=4)
            one.close()
            paths.append(p)
        src.close()
        if cb:
            cb(total, total, "Done.")
        return True, paths
    except Exception as e:
        import traceback

        traceback.print_exc()
        print(f"split_pdf_individual error: {e}")
        return False, []


def rotate_pdf_pages(inp, out_path, degrees, page_indices=None, cb=None):
    import tempfile, shutil

    tmp_path = None
    try:
        src = fitz.open(inp)
        total = src.page_count
        targets = set(page_indices) if page_indices is not None else set(range(total))
        for i in range(total):
            if cb:
                cb(i + 1, total, f"Processing page {i + 1}...")
            if i in targets:
                pg = src[i]
                new_rot = (pg.rotation + degrees) % 360
                pg.set_rotation(new_rot)
        if cb:
            cb(total, total, "Saving...")
        fd, tmp_path = tempfile.mkstemp(suffix=".pdf")
        os.close(fd)
        src.save(tmp_path, deflate=True, garbage=4, clean=True, incremental=False)
        src.close()
        shutil.move(tmp_path, out_path)
        tmp_path = None
        return True
    except Exception as e:
        import traceback

        traceback.print_exc()
        print(f"rotate_pdf_pages error: {e}")
        return False
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except:
                pass


def add_watermark(inp, out_path, text, opacity=0.25, cb=None):
    try:
        src = fitz.open(inp)
        total = src.page_count
        gray = max(0.05, min(0.80, 1.0 - opacity))
        color = (gray, gray, gray)

        for i in range(total):
            if cb:
                cb(i + 1, total, f"Watermarking page {i + 1}...")
            pg = src[i]
            r = pg.rect
            fontsize = max(18, min(80, int(r.width / max(len(text), 1) * 1.8)))

            positions = [
                fitz.Point(r.width * 0.15, r.height * 0.45),
                fitz.Point(r.width * 0.30, r.height * 0.70),
            ]
            mat45 = fitz.Matrix(45)

            for pt in positions:
                pg.insert_text(
                    pt,
                    text,
                    fontsize=fontsize,
                    color=color,
                    rotate=0,
                    morph=(pt, mat45),
                    overlay=True,
                )

        if cb:
            cb(total, total, "Saving...")
        pdf_bytes = src.tobytes(deflate=True, garbage=4)
        src.close()
        with open(out_path, "wb") as f:
            f.write(pdf_bytes)
        return True
    except Exception as e:
        import traceback

        traceback.print_exc()
        print(f"add_watermark error: {e}")
        return False


def password_protect_pdf(inp, out_path, user_pw, owner_pw=None, cb=None):
    try:
        if cb:
            cb(10, 100, "Opening PDF...")
        src = fitz.open(inp)
        if not src.is_pdf:
            src.close()
            return False

        def _const(name, fallback):
            return getattr(fitz, name, fallback)

        enc = _const("PDF_ENCRYPT_AES_256", 6)
        perm = (
            _const("PDF_PERM_PRINT", 4)
            | _const("PDF_PERM_COPY", 16)
            | _const("PDF_PERM_PRINT_HQ", 2048)
        )

        if cb:
            cb(50, 100, "Encrypting...")
        src.save(
            out_path,
            encryption=enc,
            user_pw=user_pw,
            owner_pw=owner_pw or user_pw,
            permissions=perm,
            garbage=4,
            deflate=True,
        )
        src.close()
        if cb:
            cb(100, 100, "Done.")
        return True
    except Exception as e:
        import traceback

        traceback.print_exc()
        print(f"password_protect_pdf error: {e}")
        return False


# ─────────────────────────────────────────────────────────────────────────────
#  Worker Threads
# ─────────────────────────────────────────────────────────────────────────────


# ── TASK 1: Continuous-scroll page rendering ──────────────────────────────────
#
# Instead of a single RenderWorker that emits one (idx, pixmap) pair,
# we now have a ContinuousRenderWorker that renders every page sequentially
# and emits each result so the viewer can append it.


class ContinuousRenderWorker(QThread):
    """Renders all pages of a PDF and emits them one by one."""

    page_ready = pyqtSignal(int, QPixmap)  # (page_index, pixmap)
    all_done = pyqtSignal()

    def __init__(self, path, dpi=150):
        super().__init__()
        self.path = path
        self.dpi = dpi
        self._stopped = False

    def stop(self):
        self._stopped = True
        self.wait(4000)

    def run(self):
        try:
            doc = fitz.open(self.path)
            mat = fitz.Matrix(self.dpi / 72, self.dpi / 72)
            for i in range(doc.page_count):
                if self._stopped:
                    break
                page = doc[i]
                pix = page.get_pixmap(matrix=mat, alpha=False)
                img = QImage(
                    pix.samples,
                    pix.width,
                    pix.height,
                    pix.stride,
                    QImage.Format.Format_RGB888,
                )
                self.page_ready.emit(i, QPixmap.fromImage(img))
            doc.close()
        except Exception as ex:
            print(f"ContinuousRenderWorker error: {ex}")
        finally:
            self.all_done.emit()


class PdfToolWorker(QThread):
    progress = pyqtSignal(int, int, str)
    finished = pyqtSignal(bool, str)

    def __init__(self, op, **kw):
        super().__init__()
        self.op = op
        self.kw = kw

    def run(self):
        cb = lambda v, m, t: self.progress.emit(v, m, t)
        op = self.op
        try:
            if op == "kb":
                ok, kb = compress_to_target_kb(
                    self.kw["inp"], self.kw["out"], self.kw["target_kb"], cb
                )
                msg = (
                    f"Target:    {self.kw['target_kb']:.0f} KB\n"
                    f"Result:    {kb:.1f} KB\n"
                    f"Original:  {self.kw['orig_kb']:.1f} KB"
                )
                if kb > self.kw["target_kb"] * 1.05:
                    msg += "\n\nNote: limited compressibility."
            elif op == "dim":
                ok = resize_pdf_pages(
                    self.kw["inp"], self.kw["out"], self.kw["w_mm"], self.kw["h_mm"], cb
                )
                if ok:
                    new_kb = os.path.getsize(self.kw["out"]) / 1024
                    msg = (
                        f"Page size: {self.kw['w_mm']:.0f} × {self.kw['h_mm']:.0f} mm\n"
                        f"Pages:     {self.kw['pages']}\n"
                        f"Output:    {new_kb:.1f} KB"
                    )
                else:
                    msg = "Resize failed. Check that the PDF is not password-protected."
            else:
                ok = compress_standard(
                    self.kw["inp"], self.kw["out"], self.kw["level"], cb
                )
                new_kb = os.path.getsize(self.kw["out"]) / 1024
                saved = max(0, (1 - new_kb / self.kw["orig_kb"]) * 100)
                msg = (
                    f"Original:   {self.kw['orig_kb']:.1f} KB\n"
                    f"Compressed: {new_kb:.1f} KB\n"
                    f"Saved:      {saved:.1f}%"
                )
            self.finished.emit(ok, msg)
        except Exception as e:
            self.finished.emit(False, str(e))


class FileOpsWorker(QThread):
    progress = pyqtSignal(int, int, str)
    finished = pyqtSignal(bool, str)

    def __init__(self, op, **kw):
        super().__init__()
        self.op = op
        self.kw = kw

    def run(self):
        cb = lambda v, m, t: self.progress.emit(v, m, t)
        try:
            op = self.op
            if op == "split_range":
                ok = split_pdf_range(
                    self.kw["inp"], self.kw["out"], self.kw["start"], self.kw["end"], cb
                )
                n = self.kw["end"] - self.kw["start"] + 1
                msg = f"Extracted {n} page(s) saved to: {os.path.basename(self.kw['out'])}"
                if not ok:
                    msg = "Extract failed. See console for details."
            elif op == "split_all":
                ok, paths = split_pdf_individual(
                    self.kw["inp"], self.kw["out_dir"], self.kw["base"], cb
                )
                msg = f"Split into {len(paths)} individual PDF files in the selected folder."
                if not ok:
                    msg = "Split failed. See console for details."
            elif op == "rotate":
                ok = rotate_pdf_pages(
                    self.kw["inp"],
                    self.kw["out"],
                    self.kw["degrees"],
                    self.kw.get("pages"),
                    cb,
                )
                scope = (
                    "all pages"
                    if self.kw.get("pages") is None
                    else f"{len(self.kw['pages'])} page(s)"
                )
                msg = f"Rotated {scope} by {self.kw['degrees']} degrees."
                if not ok:
                    msg = "Rotate failed. See console for details."
            elif op == "watermark":
                ok = add_watermark(
                    self.kw["inp"],
                    self.kw["out"],
                    self.kw["text"],
                    self.kw.get("opacity", 0.25),
                    cb,
                )
                msg = f"Watermark added: {self.kw['text']}"
                if not ok:
                    msg = "Watermark failed. See console for details."
            elif op == "password":
                ok = password_protect_pdf(
                    self.kw["inp"],
                    self.kw["out"],
                    self.kw["user_pw"],
                    self.kw.get("owner_pw"),
                    cb,
                )
                msg = "PDF encrypted with AES-256 password protection."
                if not ok:
                    msg = "Encryption failed. See console for details."
            else:
                ok, msg = False, f"Unknown op: {op}"
            self.finished.emit(ok, msg)
        except Exception as e:
            import traceback

            traceback.print_exc()
            self.finished.emit(False, f"Error: {e}")


def get_tts_voices():
    try:
        e = pyttsx3.init()
        voices = e.getProperty("voices") or []
        result = [(v.name, v.id) for v in voices]
        e.stop()
        return result
    except:
        return []


# ── TASK 2: Fixed TTS Worker ──────────────────────────────────────────────────
#
# Root cause of the "highlights first part then zooms through the rest" bug:
#
#   OLD code emitted sentence_read BEFORE runAndWait(), which means the UI
#   updated the highlight immediately but the voice had not started speaking yet.
#   By the time the voice caught up, the next sentence's highlight was already
#   being drawn, creating the visual race condition the user saw.
#
# Fix:
#   1. Emit sentence_read AFTER runAndWait() finishes — highlight shows what was
#      JUST spoken, and disappears as the next sentence starts.
#   2. Use done_evt (threading.Event) with a generous timeout so we truly wait
#      for SAPI5 to finish audio before advancing.
#   3. sentence_read now carries (page_idx, char_start, char_end, sentence_text)
#      so the UI can show the spoken text in the TTS panel without re-computing it.


class TtsWorker(QThread):
    done = pyqtSignal()
    # NEW signature: page_idx, char_start, char_end, sentence_text
    sentence_read = pyqtSignal(int, int, int, str)
    page_started = pyqtSignal(int)

    def __init__(self, segments, voice_id=None, rate_getter=None):
        super().__init__()
        self._segments = segments  # [(page_idx, full_page_text), ...]
        self._voice_id = voice_id
        self._rate_getter = rate_getter or (lambda: 175)
        self._engine = None
        self._stopped = False

    def run(self):
        import threading, re

        done_evt = threading.Event()

        def on_end(name, completed):
            done_evt.set()

        try:
            e = pyttsx3.init()
            if self._voice_id:
                e.setProperty("voice", self._voice_id)
            e.connect("finished-utterance", on_end)
            self._engine = e

            for page_idx, text in self._segments:
                if self._stopped:
                    break
                if not text.strip():
                    continue

                self.page_started.emit(page_idx)
                sentences = self._split_sentences(text)
                pos = 0

                for sent in sentences:
                    if self._stopped:
                        break

                    # Find this sentence's position in the page text
                    start = text.find(sent, pos)
                    if start < 0:
                        start = text.find(sent)  # fallback: search from top
                    if start < 0:
                        start = pos
                    end = start + len(sent)
                    pos = end

                    # ── SPEAK first, THEN highlight ──────────────────────────
                    # This is the key fix: the highlight now tracks what was
                    # just spoken, not what is about to be spoken.
                    done_evt.clear()
                    e.setProperty("rate", self._rate_getter())
                    e.say(sent)
                    e.runAndWait()
                    # Wait up to 60 s for on_end (some SAPI5 voices are slow)
                    done_evt.wait(timeout=60)

                    if self._stopped:
                        break

                    # Emit AFTER the utterance has finished
                    self.sentence_read.emit(page_idx, start, end, sent)

        except Exception as ex:
            print(f"TtsWorker: {ex}")
            import traceback

            traceback.print_exc()
        self.done.emit()

    def _split_sentences(self, text):
        import re

        parts = re.split(r"(?<=[.!?])\s+", text.strip())
        return [s.strip() for s in parts if len(s.strip()) >= 8]

    def stop(self):
        self._stopped = True
        if self._engine:
            try:
                self._engine.stop()
            except Exception:
                pass
        self.wait(4000)


# ─────────────────────────────────────────────────────────────────────────────
#  Design Tokens
# ─────────────────────────────────────────────────────────────────────────────

C = {
    "bg": "#0C0C0F",
    "surface": "#111116",
    "surface2": "#18181F",
    "surface3": "#22222C",
    "border": "#23232E",
    "border2": "#2E2E3D",
    "accent": "#6C63FF",
    "accent2": "#9B94FF",
    "accent_dim": "#1E1B3A",
    "red": "#FF4D6A",
    "green": "#34D399",
    "text": "#F0F0F8",
    "text2": "#8888AA",
    "text3": "#44445A",
}

GLOBAL_CSS = f"""
QMainWindow, QWidget {{
    background: {C['bg']};
    color: {C['text']};
    font-family: 'Segoe UI', 'SF Pro Display', sans-serif;
    font-size: 13px;
}}
QScrollBar:vertical {{
    background: {C['surface']};
    width: 6px;
    border-radius: 3px;
    margin: 0;
}}
QScrollBar::handle:vertical {{
    background: {C['border2']};
    border-radius: 3px;
    min-height: 40px;
}}
QScrollBar::handle:vertical:hover {{
    background: {C['accent']};
}}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{
    height: 0;
}}
QScrollBar:horizontal {{
    background: {C['surface']};
    height: 6px;
    border-radius: 3px;
}}
QScrollBar::handle:horizontal {{
    background: {C['border2']};
    border-radius: 3px;
    min-width: 40px;
}}
QScrollBar::handle:horizontal:hover {{
    background: {C['accent']};
}}
QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {{
    width: 0;
}}
QToolTip {{
    background: {C['surface2']};
    color: {C['text']};
    border: 1px solid {C['border2']};
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 12px;
}}
"""


# ─────────────────────────────────────────────────────────────────────────────
#  App Icon Helper
# ─────────────────────────────────────────────────────────────────────────────


def _app_icon():
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "icon.png")
    if os.path.exists(path):
        return QIcon(path)
    return QIcon()


# ─────────────────────────────────────────────────────────────────────────────
#  Reusable Widgets
# ─────────────────────────────────────────────────────────────────────────────


class GlowButton(QPushButton):
    def __init__(self, text, accent=True, small=False, danger=False, parent=None):
        super().__init__(text, parent)
        self._accent = accent
        self._danger = danger
        h = 36 if small else 44
        self.setFixedHeight(h)
        self.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
        self._apply()

    def _apply(self):
        if self._danger:
            self.setStyleSheet(
                f"""
                QPushButton {{
                    background: #2A1520;
                    border: 1.5px solid {C['red']};
                    border-radius: 10px;
                    color: {C['red']};
                    font-size: 13px; font-weight: 600;
                    padding: 0 20px;
                }}
                QPushButton:hover {{ background: {C['red']}; color: white; }}
                QPushButton:pressed {{ background: #C03050; }}
                QPushButton:disabled {{ background: {C['surface']}; border-color: {C['border']}; color: {C['text3']}; }}
            """
            )
        elif self._accent:
            self.setStyleSheet(
                f"""
                QPushButton {{
                    background: {C['accent']};
                    border: none;
                    border-radius: 10px;
                    color: white;
                    font-size: 13px; font-weight: 700;
                    padding: 0 20px;
                }}
                QPushButton:hover {{ background: {C['accent2']}; }}
                QPushButton:pressed {{ background: #4E48C0; }}
                QPushButton:disabled {{ background: {C['surface2']}; color: {C['text3']}; }}
            """
            )
        else:
            self.setStyleSheet(
                f"""
                QPushButton {{
                    background: {C['surface2']};
                    border: 1.5px solid {C['border2']};
                    border-radius: 10px;
                    color: {C['text2']};
                    font-size: 13px; font-weight: 600;
                    padding: 0 20px;
                }}
                QPushButton:hover {{ background: {C['surface3']}; color: {C['text']}; border-color: {C['border2']}; }}
                QPushButton:pressed {{ background: {C['surface3']}; }}
                QPushButton:disabled {{ background: {C['surface']}; color: {C['text3']}; }}
            """
            )


class IconButton(QToolButton):
    def __init__(self, symbol, tooltip="", size=36, parent=None):
        super().__init__(parent)
        self.setText(symbol)
        self.setToolTip(tooltip)
        self.setFixedSize(size, size)
        self.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
        self.setStyleSheet(
            f"""
            QToolButton {{
                background: {C['surface2']};
                border: 1.5px solid {C['border2']};
                border-radius: 9px;
                color: {C['text2']};
                font-size: 15px;
                font-weight: 700;
            }}
            QToolButton:hover {{
                background: {C['accent_dim']};
                border-color: {C['accent']};
                color: {C['accent2']};
            }}
            QToolButton:pressed {{
                background: {C['accent']};
                border-color: {C['accent']};
                color: white;
            }}
            QToolButton:disabled {{
                background: {C['surface']};
                border-color: {C['border']};
                color: {C['text3']};
            }}
        """
        )


class SidebarButton(QPushButton):
    def __init__(self, icon, label, sublabel="", parent=None):
        super().__init__(parent)
        self._icon_ch = icon
        self._label_tx = label
        self._is_active = False
        self._enabled_state = True
        self.setFixedHeight(48)
        self.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
        self.setCheckable(False)
        self._apply_style()

    def _apply_style(self):
        en = self._enabled_state
        ac = self._is_active and en

        if ac:
            base_css = f"""
                QPushButton {{
                    background: {C["accent"]};
                    border: 2.5px solid {C["accent2"]};
                    border-radius: 10px;
                    color: #FFFFFF;
                    font-size: 13px;
                    font-weight: 700;
                    text-align: left;
                    padding: 0 14px;
                    margin: 2px 10px;
                }}
                QPushButton:hover:enabled {{
                    background: {C["accent"]};
                    border: 2.5px solid #FFFFFF;
                    color: #FFFFFF;
                }}
                QPushButton:pressed:enabled {{
                    background: #4E48C0;
                    border: 2.5px solid {C["accent2"]};
                    color: #FFFFFF;
                }}
            """
        elif en:
            base_css = f"""
                QPushButton {{
                    background: {C["surface2"]};
                    border: 1.5px solid {C["accent"]};
                    border-radius: 10px;
                    color: {C["text2"]};
                    font-size: 13px;
                    font-weight: 600;
                    text-align: left;
                    padding: 0 14px;
                    margin: 2px 10px;
                }}
                QPushButton:hover:enabled {{
                    background: {C["accent_dim"]};
                    border: 2.5px solid {C["accent2"]};
                    color: #FFFFFF;
                }}
                QPushButton:pressed:enabled {{
                    background: {C["accent"]};
                    border: 2.5px solid {C["accent2"]};
                    color: #FFFFFF;
                }}
            """
        else:
            base_css = f"""
                QPushButton {{
                    background: {C["surface"]};
                    border: 1.5px solid {C["border"]};
                    border-radius: 10px;
                    color: {C["text3"]};
                    font-size: 13px;
                    font-weight: 500;
                    text-align: left;
                    padding: 0 14px;
                    margin: 2px 10px;
                }}
            """

        self.setStyleSheet(base_css)
        super().setText(f"  {self._icon_ch}   {self._label_tx}")

    def setEnabled(self, val):
        self._enabled_state = val
        super().setEnabled(val)
        self._apply_style()

    def setActive(self, val):
        self._is_active = val
        self._apply_style()

    def setText(self, txt):
        stripped = txt.strip()
        if stripped.startswith(self._icon_ch):
            stripped = stripped[len(self._icon_ch) :].strip()
        self._label_tx = stripped
        self._apply_style()


class Divider(QFrame):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFrameShape(QFrame.Shape.HLine)
        self.setStyleSheet(
            f"border: none; border-top: 1px solid {C['border']}; margin: 4px 16px;"
        )
        self.setFixedHeight(1)


class Badge(QLabel):
    def __init__(self, text, parent=None):
        super().__init__(text, parent)
        self.setStyleSheet(
            f"""
            background: {C['accent_dim']};
            color: {C['accent2']};
            border: 1px solid {C['accent']};
            border-radius: 10px;
            padding: 2px 10px;
            font-size: 11px;
            font-weight: 600;
        """
        )
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)


class StyledInput(QLineEdit):
    def __init__(self, placeholder="", parent=None):
        super().__init__(parent)
        self.setPlaceholderText(placeholder)
        self.setStyleSheet(
            f"""
            QLineEdit {{
                background: {C['surface']};
                border: 1.5px solid {C['border']};
                border-radius: 8px;
                color: {C['text']};
                font-size: 13px;
                padding: 7px 14px;
            }}
            QLineEdit:focus {{
                border-color: {C['accent']};
                background: {C['surface2']};
            }}
        """
        )


class StyledRadio(QRadioButton):
    def __init__(self, text, parent=None):
        super().__init__(text, parent)
        self.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
        self.setStyleSheet(
            f"""
            QRadioButton {{
                color: {C['text2']};
                font-size: 13px;
                spacing: 10px;
                padding: 4px 0;
            }}
            QRadioButton:hover {{ color: {C['text']}; }}
            QRadioButton::indicator {{
                width: 16px; height: 16px;
                border-radius: 8px;
                border: 2px solid {C['border2']};
                background: {C['surface']};
            }}
            QRadioButton::indicator:checked {{
                border-color: {C['accent']};
                background: {C['accent']};
            }}
        """
        )


class StyledProgress(QProgressBar):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedHeight(3)
        self.setTextVisible(False)
        self.setStyleSheet(
            f"""
            QProgressBar {{
                background: {C['border']};
                border: none;
                border-radius: 1px;
            }}
            QProgressBar::chunk {{
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
                    stop:0 {C['accent']}, stop:1 {C['accent2']});
                border-radius: 1px;
            }}
        """
        )


# ─────────────────────────────────────────────────────────────────────────────
#  File Operations Dialog  (unchanged)
# ─────────────────────────────────────────────────────────────────────────────


class FileOpsDialog(QDialog):
    def __init__(self, file_path, page_count, parent=None):
        super().__init__(parent)
        self.file_path = file_path
        self.page_count = page_count
        self.result = None
        self._build()

    def _chip_btn(self, label):
        b = QPushButton(label)
        b.setFixedHeight(26)
        b.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
        b.setStyleSheet(
            f"""
            QPushButton {{
                background:{C['surface2']}; border:1.5px solid {C['border2']};
                border-radius:6px; color:{C['text2']}; font-size:11px; padding:0 8px;
            }}
            QPushButton:hover {{ background:{C['accent_dim']}; color:{C['accent2']};
                border-color:{C['accent']}; }}
            QPushButton:pressed {{ background:{C['accent']}; color:white; }}
        """
        )
        return b

    def _lbl(self, text):
        l = QLabel(text)
        l.setStyleSheet(f"color:{C['text2']};font-size:12px;")
        return l

    def _desc(self, text):
        l = QLabel(text)
        l.setStyleSheet(f"color:{C['text3']};font-size:11px;line-height:1.5;")
        l.setWordWrap(True)
        return l

    def _build(self):
        self.setWindowTitle("File Operations")
        self.setWindowIcon(_app_icon())
        self.setFixedSize(560, 480)
        self.setStyleSheet(
            f"""
            QDialog {{ background:{C['bg']}; border:1px solid {C['border']};
                       border-radius:16px; }}
        """
        )
        root = QVBoxLayout(self)
        root.setContentsMargins(30, 26, 30, 22)
        root.setSpacing(0)

        hdr = QLabel("File Operations")
        hdr.setStyleSheet(
            f"color:{C['text']};font-size:19px;font-weight:700;margin-bottom:3px;"
        )
        root.addWidget(hdr)
        sub = QLabel(f"{os.path.basename(self.file_path)}  ·  {self.page_count} pages")
        sub.setStyleSheet(f"color:{C['text2']};font-size:11px;margin-bottom:18px;")
        root.addWidget(sub)

        tab_row = QHBoxLayout()
        tab_row.setSpacing(4)
        self._tab_btns = []
        self._pages = QStackedWidget()
        self._pages.setStyleSheet("background:transparent;")
        for i, (ico, lbl) in enumerate(
            [
                ("✂", "Split"),
                ("📄", "Extract"),
                ("↻", "Rotate"),
                ("🔏", "Watermark"),
                ("🔒", "Password"),
            ]
        ):
            b = QPushButton(f"{ico} {lbl}")
            b.setCheckable(True)
            b.setFixedHeight(33)
            b.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
            b.clicked.connect(lambda _, idx=i: self._switch(idx))
            self._tab_btns.append(b)
            tab_row.addWidget(b)
        root.addLayout(tab_row)
        root.addSpacing(18)

        self._build_split_page()
        self._build_extract_page()
        self._build_rotate_page()
        self._build_watermark_page()
        self._build_password_page()
        root.addWidget(self._pages)
        root.addStretch()

        root.addSpacing(14)
        div = QFrame()
        div.setFrameShape(QFrame.Shape.HLine)
        div.setStyleSheet(f"border:none;border-top:1px solid {C['border']};")
        div.setFixedHeight(1)
        root.addWidget(div)
        root.addSpacing(12)

        act = QHBoxLayout()
        act.setSpacing(10)
        cancel = GlowButton("Cancel", accent=False)
        cancel.setFixedWidth(100)
        cancel.clicked.connect(self.reject)
        self._ok_btn = GlowButton("Apply")
        self._ok_btn.setFixedWidth(130)
        self._ok_btn.clicked.connect(self._apply)
        act.addStretch()
        act.addWidget(cancel)
        act.addWidget(self._ok_btn)
        root.addLayout(act)

        self._switch(0)
        self._style_tabs(0)

    def _tab_style(self, active):
        return f"""QPushButton {{
            background:{C['accent_dim'] if active else C['surface2']};
            border:1.5px solid {C['accent'] if active else C['border2']};
            border-radius:8px;
            color:{C['accent2'] if active else C['text2']};
            font-size:11px; font-weight:{'700' if active else '500'}; padding:0 10px;
        }}
        QPushButton:hover {{ background:{C['surface3']};color:{C['text']};
            border-color:{C['border2']}; }}"""

    def _style_tabs(self, active_i):
        for i, b in enumerate(self._tab_btns):
            b.setStyleSheet(self._tab_style(i == active_i))

    def _switch(self, idx):
        self._pages.setCurrentIndex(idx)
        self._style_tabs(idx)
        self._active_tab = idx

    def _build_split_page(self):
        p = QWidget()
        l = QVBoxLayout(p)
        l.setContentsMargins(0, 0, 0, 0)
        l.setSpacing(12)
        l.addWidget(
            self._desc(
                "Split this PDF into individual pages - one file per page. All files will be saved to a folder you choose."
            )
        )
        note = QLabel(f"This will create {self.page_count} separate PDF files.")
        note.setStyleSheet(f"color:{C['accent2']};font-size:11px;font-weight:600;")
        l.addWidget(note)
        l.addStretch()
        self._pages.addWidget(p)

    def _build_extract_page(self):
        p = QWidget()
        l = QVBoxLayout(p)
        l.setContentsMargins(0, 0, 0, 0)
        l.setSpacing(10)
        l.addWidget(
            self._desc(
                f"Extract a range of pages into a new PDF file. Pages are numbered 1 to {self.page_count}."
            )
        )

        row = QHBoxLayout()
        row.setSpacing(10)
        row.addWidget(self._lbl("From page:"))
        self._ext_from = StyledInput("1")
        self._ext_from.setText("1")
        self._ext_from.setFixedWidth(70)
        row.addWidget(self._ext_from)
        row.addWidget(self._lbl("to:"))
        self._ext_to = StyledInput(str(self.page_count))
        self._ext_to.setText(str(self.page_count))
        self._ext_to.setFixedWidth(70)
        row.addWidget(self._ext_to)
        row.addStretch()
        l.addLayout(row)

        ql = QLabel("Quick range:")
        ql.setStyleSheet(f"color:{C['text3']};font-size:11px;")
        l.addWidget(ql)
        qr = QHBoxLayout()
        qr.setSpacing(5)
        half = self.page_count // 2
        for lbl, frm, to in [
            ("First half", 1, max(1, half)),
            ("Second half", max(1, half + 1), self.page_count),
            ("First page", 1, 1),
            ("Last page", self.page_count, self.page_count),
        ]:
            b = self._chip_btn(lbl)
            b.clicked.connect(
                lambda _, f=frm, t=to: (
                    self._ext_from.setText(str(f)),
                    self._ext_to.setText(str(t)),
                )
            )
            qr.addWidget(b)
        qr.addStretch()
        l.addLayout(qr)
        l.addStretch()
        self._pages.addWidget(p)

    def _build_rotate_page(self):
        p = QWidget()
        l = QVBoxLayout(p)
        l.setContentsMargins(0, 0, 0, 0)
        l.setSpacing(12)
        l.addWidget(self._desc("Rotate pages. Choose which pages and by how much."))

        scope_row = QHBoxLayout()
        scope_row.setSpacing(12)
        self._rot_all = StyledRadio("All pages")
        self._rot_all.setChecked(True)
        self._rot_cur = StyledRadio("Current page only")
        self._rot_range = StyledRadio("Page range:")
        scope_row.addWidget(self._rot_all)
        scope_row.addWidget(self._rot_cur)
        scope_row.addWidget(self._rot_range)
        scope_row.addStretch()
        l.addLayout(scope_row)

        rng_row = QHBoxLayout()
        rng_row.setSpacing(8)
        rng_row.addWidget(self._lbl("From:"))
        self._rot_from = StyledInput("1")
        self._rot_from.setText("1")
        self._rot_from.setFixedWidth(60)
        rng_row.addWidget(self._rot_from)
        rng_row.addWidget(self._lbl("to:"))
        self._rot_to = StyledInput(str(self.page_count))
        self._rot_to.setText(str(self.page_count))
        self._rot_to.setFixedWidth(60)
        rng_row.addWidget(self._rot_to)
        rng_row.addStretch()
        l.addLayout(rng_row)

        deg_row = QHBoxLayout()
        deg_row.setSpacing(8)
        deg_row.addWidget(self._lbl("Rotation:"))
        self._rot_deg = QButtonGroup(p)
        for deg, lbl in [(90, "90° ↻"), (180, "180°"), (270, "90° ↺")]:
            rb = StyledRadio(lbl)
            self._rot_deg.addButton(rb, deg)
            deg_row.addWidget(rb)
            if deg == 90:
                rb.setChecked(True)
        deg_row.addStretch()
        l.addLayout(deg_row)
        l.addStretch()
        self._pages.addWidget(p)

    def _build_watermark_page(self):
        p = QWidget()
        l = QVBoxLayout(p)
        l.setContentsMargins(0, 0, 0, 0)
        l.setSpacing(12)
        l.addWidget(
            self._desc(
                "Stamp a diagonal text watermark on every page. The watermark is semi-transparent and centred on each page."
            )
        )

        row = QHBoxLayout()
        row.setSpacing(10)
        row.addWidget(self._lbl("Text:"))
        self._wm_text = StyledInput("e.g. CONFIDENTIAL")
        self._wm_text.setText("CONFIDENTIAL")
        row.addWidget(self._wm_text, 1)
        l.addLayout(row)

        op_row = QHBoxLayout()
        op_row.setSpacing(10)
        op_lbl = QLabel("Opacity:")
        op_lbl.setStyleSheet(f"color:{C['text2']};font-size:12px;")
        self._wm_opacity = QSlider(Qt.Orientation.Horizontal)
        self._wm_opacity.setMinimum(5)
        self._wm_opacity.setMaximum(80)
        self._wm_opacity.setValue(25)
        self._wm_opacity.setFixedHeight(20)
        self._wm_opacity.setStyleSheet(
            f"""
            QSlider::groove:horizontal {{ height:4px;background:{C['border2']};border-radius:2px; }}
            QSlider::handle:horizontal {{ width:14px;height:14px;margin:-5px 0;
                background:{C['accent']};border-radius:7px; }}
            QSlider::sub-page:horizontal {{ background:{C['accent']};border-radius:2px; }}
        """
        )
        self._wm_op_lbl = QLabel("25%")
        self._wm_op_lbl.setStyleSheet(
            f"color:{C['accent2']};font-size:11px;font-weight:700;"
        )
        self._wm_opacity.valueChanged.connect(
            lambda v: self._wm_op_lbl.setText(f"{v}%")
        )
        op_row.addWidget(op_lbl)
        op_row.addWidget(self._wm_opacity, 1)
        op_row.addWidget(self._wm_op_lbl)
        l.addLayout(op_row)

        pl = QLabel("Presets:")
        pl.setStyleSheet(f"color:{C['text3']};font-size:11px;")
        l.addWidget(pl)
        pr = QHBoxLayout()
        pr.setSpacing(5)
        for txt in ["CONFIDENTIAL", "DRAFT", "COPY", "SAMPLE", "TOP SECRET"]:
            b = self._chip_btn(txt)
            b.clicked.connect(lambda _, t=txt: self._wm_text.setText(t))
            pr.addWidget(b)
        pr.addStretch()
        l.addLayout(pr)
        l.addStretch()
        self._pages.addWidget(p)

    def _build_password_page(self):
        p = QWidget()
        l = QVBoxLayout(p)
        l.setContentsMargins(0, 0, 0, 0)
        l.setSpacing(12)
        l.addWidget(
            self._desc(
                "Encrypt the PDF with AES-256. A User Password is required to open the file. The Owner Password controls editing permissions (optional)."
            )
        )

        r1 = QHBoxLayout()
        r1.setSpacing(10)
        r1.addWidget(self._lbl("User password:"))
        self._pw_user = StyledInput("Required — to open the file")
        self._pw_user.setEchoMode(QLineEdit.EchoMode.Password)
        r1.addWidget(self._pw_user, 1)
        l.addLayout(r1)

        r2 = QHBoxLayout()
        r2.setSpacing(10)
        r2.addWidget(self._lbl("Owner password:"))
        self._pw_owner = StyledInput("Optional — leave blank to use same")
        self._pw_owner.setEchoMode(QLineEdit.EchoMode.Password)
        r2.addWidget(self._pw_owner, 1)
        l.addLayout(r2)

        show_row = QHBoxLayout()
        self._pw_show = QPushButton("Show passwords")
        self._pw_show.setCheckable(True)
        self._pw_show.setFixedHeight(28)
        self._pw_show.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
        self._pw_show.setStyleSheet(
            f"""
            QPushButton {{ background:{C['surface2']};border:1.5px solid {C['border2']};
                border-radius:7px;color:{C['text3']};font-size:11px;padding:0 10px; }}
            QPushButton:checked {{ background:{C['accent_dim']};border-color:{C['accent']};
                color:{C['accent2']}; }}
        """
        )
        self._pw_show.toggled.connect(self._toggle_pw_echo)
        show_row.addWidget(self._pw_show)
        show_row.addStretch()
        l.addLayout(show_row)

        warn = QLabel(
            "⚠  Keep your password safe — encrypted PDFs cannot be recovered without it."
        )
        warn.setStyleSheet(f"color:{C['red']};font-size:10px;")
        warn.setWordWrap(True)
        l.addWidget(warn)
        l.addStretch()
        self._pages.addWidget(p)

    def _toggle_pw_echo(self, checked):
        m = QLineEdit.EchoMode.Normal if checked else QLineEdit.EchoMode.Password
        self._pw_user.setEchoMode(m)
        self._pw_owner.setEchoMode(m)

    def _apply(self):
        tab = self._active_tab
        if tab == 0:
            self.result = ("split_all",)
        elif tab == 1:
            try:
                frm = int(self._ext_from.text()) - 1
                to = int(self._ext_to.text()) - 1
                assert 0 <= frm <= to < self.page_count
            except:
                QMessageBox.warning(
                    self,
                    "Invalid",
                    f"Enter page numbers between 1 and {self.page_count}.",
                )
                return
            self.result = ("split_range", frm, to)
        elif tab == 2:
            deg = self._rot_deg.checkedId()
            if self._rot_all.isChecked():
                pages = None
            elif self._rot_cur.isChecked():
                pages = (
                    [self._cur_page_hint] if hasattr(self, "_cur_page_hint") else None
                )
            else:
                try:
                    frm = int(self._rot_from.text()) - 1
                    to = int(self._rot_to.text()) - 1
                    assert 0 <= frm <= to < self.page_count
                    pages = list(range(frm, to + 1))
                except:
                    QMessageBox.warning(
                        self,
                        "Invalid",
                        f"Enter page range between 1 and {self.page_count}.",
                    )
                    return
            self.result = ("rotate", deg, pages)
        elif tab == 3:
            txt = self._wm_text.text().strip()
            if not txt:
                QMessageBox.warning(self, "Invalid", "Enter watermark text.")
                return
            self.result = ("watermark", txt, self._wm_opacity.value() / 100)
        else:
            pw = self._pw_user.text()
            if not pw:
                QMessageBox.warning(self, "Invalid", "Enter a user password.")
                return
            owner = self._pw_owner.text() or pw
            self.result = ("password", pw, owner)
        self.accept()


# ─────────────────────────────────────────────────────────────────────────────
#  PDF Tools Dialog  (unchanged)
# ─────────────────────────────────────────────────────────────────────────────


class PdfToolsDialog(QDialog):
    def __init__(self, file_path, page_count, parent=None):
        super().__init__(parent)
        self.file_path = file_path
        self.page_count = page_count
        self.orig_kb = os.path.getsize(file_path) / 1024
        self.result = None
        self._build()

    def _build(self):
        self.setWindowTitle("PDF Tools")
        self.setWindowIcon(_app_icon())
        self.setFixedSize(540, 510)
        self.setStyleSheet(
            f"""
            QDialog {{
                background: {C['bg']};
                border: 1px solid {C['border']};
                border-radius: 16px;
            }}
        """
        )

        root = QVBoxLayout(self)
        root.setContentsMargins(32, 28, 32, 24)
        root.setSpacing(0)

        hdr = QLabel("PDF Tools")
        hdr.setStyleSheet(
            f"color: {C['text']}; font-size: 20px; font-weight: 700; margin-bottom: 4px;"
        )
        root.addWidget(hdr)

        sub = QLabel(
            f"{os.path.basename(self.file_path)}  ·  {self.orig_kb:.1f} KB  ·  {self.page_count} pages"
        )
        sub.setStyleSheet(f"color: {C['text2']}; font-size: 12px; margin-bottom: 20px;")
        root.addWidget(sub)

        tab_row = QHBoxLayout()
        tab_row.setSpacing(6)
        self._tab_btns = []
        self._pages = QStackedWidget()
        self._pages.setStyleSheet("background: transparent;")

        for i, (icon, label) in enumerate(
            [("⬇", "Target Size"), ("⊡", "Page Size"), ("⚡", "Compress")]
        ):
            btn = QPushButton(f"{icon}  {label}")
            btn.setCheckable(True)
            btn.setFixedHeight(36)
            btn.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
            btn.clicked.connect(lambda _, idx=i: self._switch(idx))
            self._tab_btns.append(btn)
            tab_row.addWidget(btn)

        root.addLayout(tab_row)
        root.addSpacing(20)

        self._build_kb_page()
        self._build_dim_page()
        self._build_std_page()
        root.addWidget(self._pages)
        root.addStretch()

        root.addSpacing(16)
        div = QFrame()
        div.setFrameShape(QFrame.Shape.HLine)
        div.setStyleSheet(
            f"border: none; border-top: 1px solid {C['border']}; margin: 0;"
        )
        div.setFixedHeight(1)
        root.addWidget(div)
        root.addSpacing(14)

        act = QHBoxLayout()
        act.setSpacing(10)
        cancel = GlowButton("Cancel", accent=False)
        cancel.setFixedWidth(110)
        cancel.clicked.connect(self.reject)
        self._apply_btn = GlowButton("Apply")
        self._apply_btn.setFixedWidth(140)
        self._apply_btn.clicked.connect(self._apply)
        act.addStretch()
        act.addWidget(cancel)
        act.addWidget(self._apply_btn)
        root.addLayout(act)

        self._switch(0)
        self._style_tabs(0)

    def _tab_style(self, active):
        return f"""
            QPushButton {{
                background: {C['accent_dim'] if active else C['surface2']};
                border: 1.5px solid {C['accent'] if active else C['border2']};
                border-radius: 9px;
                color: {C['accent2'] if active else C['text2']};
                font-size: 12px;
                font-weight: {'700' if active else '500'};
                padding: 0 14px;
            }}
            QPushButton:hover {{ color: {C['text']}; background: {C['surface3']}; border-color: {C['border2']}; }}
        """

    def _style_tabs(self, active_i):
        for i, b in enumerate(self._tab_btns):
            b.setStyleSheet(self._tab_style(i == active_i))

    def _switch(self, idx):
        self._pages.setCurrentIndex(idx)
        self._style_tabs(idx)
        self._active_tab = idx

    def _build_kb_page(self):
        p = QWidget()
        l = QVBoxLayout(p)
        l.setContentsMargins(0, 0, 0, 0)
        l.setSpacing(14)
        desc = QLabel(
            "Set an exact file size target. Hello C will compress\nthe PDF to fit within your specified size."
        )
        desc.setStyleSheet(f"color: {C['text2']}; font-size: 12px; line-height: 1.5;")
        l.addWidget(desc)

        row2 = QHBoxLayout()
        row2.setSpacing(10)
        lbl = QLabel("Target:")
        lbl.setStyleSheet(f"color:{C['text2']};font-size:13px;")
        self._kb_input = StyledInput("e.g. 200")
        self._kb_input.setText("200")
        self._kb_input.setFixedWidth(120)
        self._kb_unit_kb = StyledRadio("KB")
        self._kb_unit_kb.setChecked(True)
        self._kb_unit_mb = StyledRadio("MB")
        row2.addWidget(lbl)
        row2.addWidget(self._kb_input)
        row2.addWidget(self._kb_unit_kb)
        row2.addWidget(self._kb_unit_mb)
        row2.addStretch()
        l.addLayout(row2)

        preset_label = QLabel("Quick presets:")
        preset_label.setStyleSheet(f"color:{C['text3']};font-size:11px;margin-top:4px;")
        l.addWidget(preset_label)
        pr = QHBoxLayout()
        pr.setSpacing(6)
        for ps in [
            ("50 KB", "50", "KB"),
            ("100 KB", "100", "KB"),
            ("200 KB", "200", "KB"),
            ("500 KB", "500", "KB"),
            ("1 MB", "1", "MB"),
            ("2 MB", "2", "MB"),
        ]:
            b = QPushButton(ps[0])
            b.setFixedHeight(28)
            b.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
            v, u = ps[1], ps[2]
            b.clicked.connect(lambda _, val=v, unit=u: self._set_preset(val, unit))
            b.setStyleSheet(
                f"""
                QPushButton {{
                    background:{C['surface2']}; border:1.5px solid {C['border2']};
                    border-radius:7px; color:{C['text2']}; font-size:11px; padding:0 8px;
                }}
                QPushButton:hover {{ background:{C['accent_dim']}; color:{C['accent2']}; border-color:{C['accent']}; }}
                QPushButton:pressed {{ background:{C['accent']}; color:white; }}
            """
            )
            pr.addWidget(b)
        pr.addStretch()
        l.addLayout(pr)
        l.addStretch()
        self._pages.addWidget(p)

    def _set_preset(self, val, unit):
        self._kb_input.setText(val)
        if unit == "KB":
            self._kb_unit_kb.setChecked(True)
        else:
            self._kb_unit_mb.setChecked(True)

    def _build_dim_page(self):
        p = QWidget()
        l = QVBoxLayout(p)
        l.setContentsMargins(0, 0, 0, 0)
        l.setSpacing(12)
        desc = QLabel(
            "Resize every page to the selected dimensions.\n"
            "Content is scaled to fit inside the new canvas, centred."
        )
        desc.setStyleSheet(f"color: {C['text2']}; font-size: 12px; line-height:1.5;")
        l.addWidget(desc)

        urow = QHBoxLayout()
        urow.setSpacing(12)
        ul = QLabel("Units:")
        ul.setStyleSheet(f"color:{C['text2']};")
        self._dim_mm = StyledRadio("mm")
        self._dim_mm.setChecked(True)
        self._dim_in = StyledRadio("inches")
        urow.addWidget(ul)
        urow.addWidget(self._dim_mm)
        urow.addWidget(self._dim_in)
        urow.addStretch()
        l.addLayout(urow)

        wrow = QHBoxLayout()
        wrow.setSpacing(10)
        wl = QLabel("Width:")
        wl.setStyleSheet(f"color:{C['text2']};")
        self._w_inp = StyledInput("e.g. 210")
        self._w_inp.setText("210")
        self._w_inp.setFixedWidth(90)
        hl = QLabel("Height:")
        hl.setStyleSheet(f"color:{C['text2']};")
        self._h_inp = StyledInput("e.g. 297")
        self._h_inp.setText("297")
        self._h_inp.setFixedWidth(90)

        swap_btn = QPushButton("⇄  Swap")
        swap_btn.setFixedHeight(34)
        swap_btn.setFixedWidth(74)
        swap_btn.setToolTip("Swap width and height (portrait ↔ landscape)")
        swap_btn.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
        swap_btn.setStyleSheet(
            f"""
            QPushButton {{
                background:{C['surface2']}; border:1.5px solid {C['border2']};
                border-radius:8px; color:{C['accent2']}; font-size:11px; font-weight:600; padding:0 8px;
            }}
            QPushButton:hover {{ background:{C['accent_dim']}; border-color:{C['accent']}; color:white; }}
            QPushButton:pressed {{ background:{C['accent']}; color:white; }}
        """
        )
        swap_btn.clicked.connect(self._swap_dims)

        wrow.addWidget(wl)
        wrow.addWidget(self._w_inp)
        wrow.addSpacing(6)
        wrow.addWidget(hl)
        wrow.addWidget(self._h_inp)
        wrow.addSpacing(8)
        wrow.addWidget(swap_btn)
        wrow.addStretch()
        l.addLayout(wrow)

        pl = QLabel("Standard sizes:")
        pl.setStyleSheet(f"color:{C['text3']};font-size:11px;")
        l.addWidget(pl)
        pr = QHBoxLayout()
        pr.setSpacing(6)
        for name, w, h in [
            ("A4", 210, 297),
            ("A3", 297, 420),
            ("Letter", 216, 279),
            ("Legal", 216, 356),
            ("A5", 148, 210),
        ]:
            b = QPushButton(name)
            b.setFixedHeight(28)
            b.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
            b.clicked.connect(lambda _, wv=w, hv=h: self._set_dim(wv, hv))
            b.setStyleSheet(
                f"""
                QPushButton {{
                    background:{C['surface2']}; border:1.5px solid {C['border2']};
                    border-radius:7px; color:{C['text2']}; font-size:11px; padding:0 8px;
                }}
                QPushButton:hover {{ background:{C['accent_dim']}; color:{C['accent2']}; border-color:{C['accent']}; }}
                QPushButton:pressed {{ background:{C['accent']}; color:white; }}
            """
            )
            pr.addWidget(b)
        pr.addStretch()
        l.addLayout(pr)
        l.addStretch()
        self._pages.addWidget(p)

    def _set_dim(self, w, h):
        self._w_inp.setText(str(w))
        self._h_inp.setText(str(h))
        self._dim_mm.setChecked(True)

    def _swap_dims(self):
        w = self._w_inp.text()
        h = self._h_inp.text()
        self._w_inp.setText(h)
        self._h_inp.setText(w)

    def _build_std_page(self):
        p = QWidget()
        l = QVBoxLayout(p)
        l.setContentsMargins(0, 0, 0, 0)
        l.setSpacing(10)
        desc = QLabel(
            "Reduce file size without targeting an exact number.\nBest for general use."
        )
        desc.setStyleSheet(f"color: {C['text2']}; font-size: 12px; line-height:1.5;")
        l.addWidget(desc)
        self._std_light = StyledRadio("Light  —  Fast, deflate-only, preserves quality")
        self._std_balanced = StyledRadio(
            "Balanced  —  Good reduction at 120 DPI  (recommended)"
        )
        self._std_agg = StyledRadio("Aggressive  —  Maximum reduction at 72 DPI")
        self._std_balanced.setChecked(True)
        l.addWidget(self._std_light)
        l.addWidget(self._std_balanced)
        l.addWidget(self._std_agg)
        l.addStretch()
        self._pages.addWidget(p)

    def _apply(self):
        tab = self._active_tab
        if tab == 0:
            try:
                val = float(self._kb_input.text().strip())
                assert val > 0
            except:
                QMessageBox.warning(self, "Invalid", "Enter a positive number.")
                return
            kb = val * 1024 if self._kb_unit_mb.isChecked() else val
            self.result = ("kb", kb)
        elif tab == 1:
            try:
                w = float(self._w_inp.text())
                h = float(self._h_inp.text())
                assert w > 0 and h > 0
            except:
                QMessageBox.warning(self, "Invalid", "Enter positive width and height.")
                return
            if self._dim_in.isChecked():
                w *= 25.4
                h *= 25.4
            self.result = ("dim", w, h)
        else:
            lv = (
                "light"
                if self._std_light.isChecked()
                else ("aggressive" if self._std_agg.isChecked() else "balanced")
            )
            self.result = ("std", lv)
        self.accept()


# ─────────────────────────────────────────────────────────────────────────────
#  TASK 3: Continuous-scroll Viewer Widget
# ─────────────────────────────────────────────────────────────────────────────
#
# The old viewer used a single QLabel (_page_img) inside a QStackedWidget, so
# only one page at a time was ever shown.  We replace the inner content with a
# ContinuousViewer: a QWidget that stacks QLabels (one per page) vertically.
#
# Key design decisions:
#   • Each page gets its OWN QLabel stored in self._page_labels[idx].
#   • Zoom rescales every already-rendered label immediately.
#   • When TTS highlights a sentence, we swap that page's label pixmap for the
#     highlighted version.  All other pages keep their cached plain pixmap.
#   • _page_top_offset(idx) → the scroll Y that brings page idx to the top,
#     used both for "navigate to page" and for auto-scroll during reading.


class ContinuousViewer(QWidget):
    """
    Vertical stack of page image labels.
    Parents must call set_page_count() once, then feed pixmaps via set_page_pixmap().
    """

    PAGE_GAP = 16  # px between pages

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setStyleSheet(f"background: {C['bg']};")
        self._layout = QVBoxLayout(self)
        self._layout.setContentsMargins(24, 24, 24, 24)
        self._layout.setSpacing(self.PAGE_GAP)
        self._layout.setAlignment(Qt.AlignmentFlag.AlignHCenter)

        self._page_labels: list[QLabel] = []
        self._base_pixmaps: dict[int, QPixmap] = {}  # unscaled originals
        self._zoom = 1.0

    def set_page_count(self, n: int):
        """Clear and create n placeholder labels."""
        # Remove old labels
        for lbl in self._page_labels:
            self._layout.removeWidget(lbl)
            lbl.deleteLater()
        self._page_labels.clear()
        self._base_pixmaps.clear()

        for i in range(n):
            lbl = QLabel()
            lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
            lbl.setStyleSheet(
                f"background: {C['surface2']}; border: 1px solid {C['border']};"
                f" border-radius: 4px;"
            )
            # Placeholder minimum size so the scroll area has some layout height
            lbl.setMinimumHeight(200)
            self._layout.addWidget(lbl)
            self._page_labels.append(lbl)

    def set_page_pixmap(self, idx: int, pm: QPixmap):
        """Store base pixmap and display it at current zoom."""
        if idx < 0 or idx >= len(self._page_labels):
            return
        self._base_pixmaps[idx] = pm
        self._apply_pixmap(idx, pm)

    def _apply_pixmap(self, idx: int, pm: QPixmap):
        """Scale pm by self._zoom and assign to the label."""
        lbl = self._page_labels[idx]
        if pm is None or pm.isNull():
            return
        w = int(pm.width() * self._zoom)
        h = int(pm.height() * self._zoom)
        scaled = pm.scaled(
            w,
            h,
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )
        lbl.setPixmap(scaled)
        lbl.setFixedSize(scaled.size())

    def set_zoom(self, zoom: float):
        self._zoom = zoom
        for idx, pm in self._base_pixmaps.items():
            self._apply_pixmap(idx, pm)

    def replace_page_pixmap(self, idx: int, pm: QPixmap):
        """
        Temporarily display pm (e.g. highlighted version) without caching it
        as the base.  The base is untouched so clearing the highlight is a
        simple call to set_page_pixmap(idx, self._base_pixmaps[idx]).
        """
        if idx < 0 or idx >= len(self._page_labels):
            return
        self._apply_pixmap(idx, pm)

    def restore_page(self, idx: int):
        """Restore the cached base pixmap (clears any highlight)."""
        pm = self._base_pixmaps.get(idx)
        if pm:
            self._apply_pixmap(idx, pm)

    def page_top_y(self, idx: int) -> int:
        """
        Return the Y coordinate (in the viewer widget's coordinate space)
        of the top of page idx.  Used to scroll to that page.
        """
        if idx < 0 or idx >= len(self._page_labels):
            return 0
        lbl = self._page_labels[idx]
        return lbl.y()

    def page_count(self) -> int:
        return len(self._page_labels)


# ─────────────────────────────────────────────────────────────────────────────
#  Main Window
# ─────────────────────────────────────────────────────────────────────────────


class TrixieWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self._path = None
        self._page_count = 0
        self._cur_page = 0
        self._zoom = 1.0
        self._render_worker = None
        self._tts_worker = None
        self._tool_worker = None
        self._file_ops_worker = None
        self._reading = False
        self._reading_page_texts: dict[int, str] = {}
        self._hl_page = -1
        self._tts_voices = []
        self._search_results = []
        self._search_idx = -1

        self.setWindowTitle("Hello C")
        self.resize(1280, 860)
        self.setMinimumSize(900, 600)
        self.setStyleSheet(GLOBAL_CSS)
        self.setWindowIcon(_app_icon())

        try:
            from ctypes import windll

            windll.shcore.SetProcessDpiAwareness(1)
        except:
            pass

        self._build_ui()
        self._bind_keys()

    # ── UI Construction ───────────────────────────────────────────────────────

    def _build_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        main = QVBoxLayout(central)
        main.setContentsMargins(0, 0, 0, 0)
        main.setSpacing(0)

        main.addWidget(self._build_titlebar())
        main.addWidget(self._build_searchbar())

        self._progress = StyledProgress()
        self._progress.setValue(0)
        main.addWidget(self._progress)

        body = QHBoxLayout()
        body.setContentsMargins(0, 0, 0, 0)
        body.setSpacing(0)
        body.addWidget(self._build_sidebar())
        body.addWidget(self._build_viewer(), stretch=1)
        body_w = QWidget()
        body_w.setLayout(body)
        main.addWidget(body_w, stretch=1)

        main.addWidget(self._build_statusbar())

    def _build_titlebar(self):
        bar = QWidget()
        bar.setFixedHeight(60)
        bar.setStyleSheet(
            f"background: {C['surface']}; border-bottom: 1px solid {C['border']};"
        )
        row = QHBoxLayout(bar)
        row.setContentsMargins(24, 0, 20, 0)
        row.setSpacing(0)

        logo_row = QHBoxLayout()
        logo_row.setSpacing(10)
        _icon_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "icon.png"
        )
        if os.path.exists(_icon_path):
            logo_img = QLabel()
            _pix = QPixmap(_icon_path).scaled(
                32,
                32,
                Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.SmoothTransformation,
            )
            logo_img.setPixmap(_pix)
            logo_img.setFixedSize(32, 32)
            logo_img.setStyleSheet("background: transparent;")
            logo_row.addWidget(logo_img)
        else:
            dot = QLabel("◈")
            dot.setStyleSheet(f"color: {C['accent']}; font-size: 20px;")
            logo_row.addWidget(dot)
        name = QLabel("Hello C")
        name.setStyleSheet(
            f"color: {C['text']}; font-size: 16px; font-weight: 700; letter-spacing: 1px;"
        )
        logo_row.addWidget(name)
        row.addLayout(logo_row)
        row.addSpacing(20)

        self._file_label = QLabel("No file open")
        self._file_label.setStyleSheet(f"color: {C['text3']}; font-size: 12px;")
        row.addWidget(self._file_label)
        row.addStretch()

        zoom_row = QHBoxLayout()
        zoom_row.setSpacing(6)
        self._zoom_out_btn = IconButton("−", "Zoom out  (Ctrl−)")
        self._zoom_lbl = QLabel("100%")
        self._zoom_lbl.setFixedWidth(46)
        self._zoom_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._zoom_lbl.setStyleSheet(
            f"color: {C['text2']}; font-size: 12px; font-weight: 600;"
        )
        self._zoom_in_btn = IconButton("+", "Zoom in  (Ctrl=)")
        self._zoom_rst_btn = IconButton("⊙", "Reset zoom  (Ctrl+0)")
        self._zoom_out_btn.clicked.connect(self.cmd_zoom_out)
        self._zoom_in_btn.clicked.connect(self.cmd_zoom_in)
        self._zoom_rst_btn.clicked.connect(self.cmd_zoom_reset)
        zoom_row.addWidget(self._zoom_out_btn)
        zoom_row.addWidget(self._zoom_lbl)
        zoom_row.addWidget(self._zoom_in_btn)
        zoom_row.addWidget(self._zoom_rst_btn)
        row.addLayout(zoom_row)

        row.addSpacing(14)

        self._search_toggle_btn = QPushButton("🔍")
        self._search_toggle_btn.setFixedSize(34, 34)
        self._search_toggle_btn.setCheckable(True)
        self._search_toggle_btn.setToolTip("Search  (Ctrl+F)")
        self._search_toggle_btn.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
        self._search_toggle_btn.setEnabled(False)
        self._search_toggle_btn.setStyleSheet(
            f"""
            QPushButton {{
                background:{C['surface2']}; border:1.5px solid {C['border2']};
                border-radius:9px; font-size:16px; color:{C['text2']};
            }}
            QPushButton:hover {{
                background:{C['accent_dim']}; border-color:{C['accent']};
            }}
            QPushButton:checked {{
                background:{C['accent_dim']}; border-color:{C['accent']};
                color:{C['accent2']};
            }}
            QPushButton:disabled {{ opacity:0.35; }}
        """
        )
        self._search_toggle_btn.clicked.connect(self._on_search_toggle)
        row.addWidget(self._search_toggle_btn)

        return bar

    def _build_searchbar(self):
        self._search_bar = QWidget()
        self._search_bar.setFixedHeight(46)
        self._search_bar.setStyleSheet(
            f"background:{C['surface2']};border-bottom:1px solid {C['border']};"
        )
        self._search_bar.setVisible(False)
        row = QHBoxLayout(self._search_bar)
        row.setContentsMargins(20, 0, 16, 0)
        row.setSpacing(8)

        self._search_input = QLineEdit()
        self._search_input.setPlaceholderText("Search in document…")
        self._search_input.setFixedHeight(28)
        self._search_input.setStyleSheet(
            f"""
            QLineEdit {{
                background:{C['surface3']};border:1.5px solid {C['border2']};
                border-radius:7px;color:{C['text']};font-size:13px;padding:0 10px;
            }}
            QLineEdit:focus {{ border-color:{C['accent']};background:{C['surface']}; }}
        """
        )
        self._search_input.returnPressed.connect(self.cmd_search_next)
        self._search_input.textChanged.connect(self._on_search_text_changed)

        self._search_count_lbl = QLabel("")
        self._search_count_lbl.setFixedWidth(90)
        self._search_count_lbl.setStyleSheet(
            f"color:{C['text2']};font-size:11px;font-weight:600;"
        )

        def _nav_btn(icon, tip):
            b = QPushButton(icon)
            b.setFixedSize(26, 26)
            b.setToolTip(tip)
            b.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
            b.setStyleSheet(
                f"""
                QPushButton {{
                    background:{C['surface3']};border:1.5px solid {C['border2']};
                    border-radius:6px;color:{C['text2']};font-size:13px;
                }}
                QPushButton:hover {{
                    background:{C['accent_dim']};border-color:{C['accent']};
                    color:{C['accent2']};
                }}
                QPushButton:pressed {{ background:{C['accent']};color:white; }}
            """
            )
            return b

        self._search_prev_btn = _nav_btn("▲", "Previous match  (Shift+Enter)")
        self._search_next_btn = _nav_btn("▼", "Next match  (Enter)")
        self._search_prev_btn.clicked.connect(self.cmd_search_prev)
        self._search_next_btn.clicked.connect(self.cmd_search_next)

        close_btn = QPushButton("✕")
        close_btn.setFixedSize(22, 22)
        close_btn.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
        close_btn.setToolTip("Close  (Esc)")
        close_btn.setStyleSheet(
            f"""
            QPushButton {{
                background:transparent;border:none;color:{C['text3']};font-size:12px;
            }}
            QPushButton:hover {{ color:{C['red']}; }}
        """
        )
        close_btn.clicked.connect(self.cmd_search_close)

        row.addWidget(self._search_input, 1)
        row.addWidget(self._search_count_lbl)
        row.addWidget(self._search_prev_btn)
        row.addWidget(self._search_next_btn)
        row.addSpacing(8)
        row.addWidget(close_btn)
        return self._search_bar

    def _build_sidebar(self):
        side = QWidget()
        side.setFixedWidth(230)
        side.setStyleSheet(
            f"background: {C['surface']}; border-right: 1px solid {C['border']};"
        )
        vl = QVBoxLayout(side)
        vl.setContentsMargins(0, 12, 0, 12)
        vl.setSpacing(2)

        def section(text):
            l = QLabel(text)
            l.setStyleSheet(
                f"color: {C['text3']}; font-size: 9px; font-weight: 700; "
                f"letter-spacing: 2px; padding: 10px 20px 4px 20px;"
            )
            vl.addWidget(l)

        section("FILE")
        self._btn_open = SidebarButton("📂", "Open PDF", "Browse for a file")
        self._btn_merge = SidebarButton("🔗", "Merge PDFs", "Combine multiple PDFs")
        self._btn_tools = SidebarButton("🗜", "PDF Tools", "Compress · Resize")
        self._btn_file_ops = SidebarButton(
            "⚙", "File Ops", "Split · Rotate · Watermark · Password"
        )
        for b in [self._btn_open, self._btn_merge, self._btn_tools, self._btn_file_ops]:
            vl.addWidget(b)
        self._btn_tools.setEnabled(False)
        self._btn_file_ops.setEnabled(False)

        vl.addWidget(Divider())
        section("AUDIO")

        self._btn_read = SidebarButton(
            "🔊", "Read Aloud", "Read from current page to end"
        )
        self._btn_save_mp3 = SidebarButton("💾", "Save as MP3", "Export audio file")
        for b in [self._btn_read, self._btn_save_mp3]:
            vl.addWidget(b)
            b.setEnabled(False)

        tts_panel = QWidget()
        tts_panel.setStyleSheet("background:transparent;")
        tp = QVBoxLayout(tts_panel)
        tp.setContentsMargins(14, 4, 14, 6)
        tp.setSpacing(6)

        voice_row = QHBoxLayout()
        voice_row.setSpacing(8)
        voice_lbl = QLabel("Voice:")
        voice_lbl.setStyleSheet(f"color:{C['text3']};font-size:10px;min-width:36px;")
        self._voice_combo = QComboBox()
        self._voice_combo.setFixedHeight(28)
        self._voice_combo.setStyleSheet(
            f"""
            QComboBox {{
                background:{C['surface2']}; border:1.5px solid {C['border2']};
                border-radius:7px; color:{C['text2']}; font-size:11px; padding:0 8px;
            }}
            QComboBox:hover {{ border-color:{C['accent']}; color:{C['text']}; }}
            QComboBox::drop-down {{ border:none; width:20px; }}
            QComboBox::down-arrow {{ width:8px; height:8px; }}
            QComboBox QAbstractItemView {{
                background:{C['surface2']}; color:{C['text2']};
                border:1px solid {C['border2']}; selection-background-color:{C['accent_dim']};
                selection-color:{C['accent2']};
            }}
        """
        )
        voice_row.addWidget(voice_lbl)
        voice_row.addWidget(self._voice_combo, 1)
        tp.addLayout(voice_row)

        speed_row = QHBoxLayout()
        speed_row.setSpacing(8)
        speed_lbl = QLabel("Speed:")
        speed_lbl.setStyleSheet(f"color:{C['text3']};font-size:10px;min-width:36px;")
        self._speed_slider = QSlider(Qt.Orientation.Horizontal)
        self._speed_slider.setMinimum(80)
        self._speed_slider.setMaximum(300)
        self._speed_slider.setValue(175)
        self._speed_slider.setTickInterval(55)
        self._speed_slider.setFixedHeight(20)
        self._speed_slider.setStyleSheet(
            f"""
            QSlider::groove:horizontal {{
                height:4px; background:{C['border2']}; border-radius:2px;
            }}
            QSlider::handle:horizontal {{
                width:14px; height:14px; margin:-5px 0;
                background:{C['accent']}; border-radius:7px;
                border:2px solid {C['accent2']};
            }}
            QSlider::sub-page:horizontal {{
                background:{C['accent']}; border-radius:2px;
            }}
        """
        )
        self._speed_val_lbl = QLabel("175")
        self._speed_val_lbl.setFixedWidth(28)
        self._speed_val_lbl.setAlignment(
            Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter
        )
        self._speed_val_lbl.setStyleSheet(
            f"color:{C['accent2']};font-size:10px;font-weight:700;"
        )
        self._speed_slider.valueChanged.connect(
            lambda v: self._speed_val_lbl.setText(str(v))
        )
        speed_row.addWidget(speed_lbl)
        speed_row.addWidget(self._speed_slider, 1)
        speed_row.addWidget(self._speed_val_lbl)
        tp.addLayout(speed_row)

        preset_row = QHBoxLayout()
        preset_row.setSpacing(4)
        for label, val in [("Slow", 110), ("Normal", 175), ("Fast", 260)]:
            pb = QPushButton(label)
            pb.setFixedHeight(22)
            pb.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
            pb.setStyleSheet(
                f"""
                QPushButton {{
                    background:{C['surface']}; border:1px solid {C['border2']};
                    border-radius:5px; color:{C['text3']}; font-size:10px; padding:0 4px;
                }}
                QPushButton:hover {{
                    background:{C['accent_dim']}; border-color:{C['accent']}; color:{C['accent2']};
                }}
                QPushButton:pressed {{ background:{C['accent']}; color:white; }}
            """
            )
            pb.clicked.connect(lambda _, v=val: self._speed_slider.setValue(v))
            preset_row.addWidget(pb)
        preset_row.addStretch()
        tp.addLayout(preset_row)

        vl.addWidget(tts_panel)

        if not TTS_AVAILABLE:
            note = QLabel("  pip install pyttsx3  to enable")
            note.setStyleSheet(f"color:{C['text3']};font-size:10px;padding:0 20px;")
            vl.addWidget(note)
        else:
            self._tts_voices = get_tts_voices()
            for name, vid in self._tts_voices:
                short = name[:28] + "…" if len(name) > 28 else name
                self._voice_combo.addItem(short, userData=vid)

        vl.addWidget(Divider())
        section("NAVIGATE")

        nav_w = QWidget()
        nav_w.setStyleSheet("background:transparent;")
        nav = QHBoxLayout(nav_w)
        nav.setContentsMargins(14, 6, 14, 6)
        nav.setSpacing(8)
        self._btn_prev = IconButton("‹", "Previous page  (←)", 40)
        self._btn_next = IconButton("›", "Next page  (→)", 40)
        self._btn_prev.setEnabled(False)
        self._btn_next.setEnabled(False)
        self._page_lbl = QLabel("— / —")
        self._page_lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._page_lbl.setStyleSheet(
            f"color:{C['text2']};font-size:13px;font-weight:700;"
            "border-radius:5px;padding:2px 6px;"
        )
        self._page_lbl.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
        self._page_lbl.setToolTip("Click to jump to page")
        self._page_lbl.mousePressEvent = lambda e: self.cmd_jump_to_page()

        self._page_jump_input = QLineEdit()
        self._page_jump_input.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._page_jump_input.setFixedHeight(28)
        self._page_jump_input.setStyleSheet(
            f"""
            QLineEdit {{
                background:{C['surface3']};border:1.5px solid {C['accent']};
                border-radius:6px;color:{C['text']};font-size:13px;
                font-weight:700;padding:0 4px;
            }}
        """
        )
        self._page_jump_input.setVisible(False)
        self._page_jump_input.returnPressed.connect(self._commit_jump)
        self._page_jump_input.editingFinished.connect(self._commit_jump)

        self._page_stack = QStackedWidget()
        self._page_stack.setStyleSheet("background:transparent;")
        lbl_wrap = QWidget()
        lbl_wrap.setStyleSheet("background:transparent;")
        lbl_lay = QHBoxLayout(lbl_wrap)
        lbl_lay.setContentsMargins(0, 0, 0, 0)
        lbl_lay.addWidget(self._page_lbl)
        self._page_stack.addWidget(lbl_wrap)
        self._page_stack.addWidget(self._page_jump_input)

        nav.addWidget(self._btn_prev)
        nav.addWidget(self._page_stack, 1)
        nav.addWidget(self._btn_next)
        vl.addWidget(nav_w)

        hint = QLabel("← →  ·  PgUp / PgDn")
        hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        hint.setStyleSheet(f"color:{C['text3']};font-size:10px;padding-top:2px;")
        vl.addWidget(hint)

        vl.addStretch()

        self._btn_open.clicked.connect(self.cmd_open)
        self._btn_merge.clicked.connect(self.cmd_merge)
        self._btn_tools.clicked.connect(self.cmd_tools)
        self._btn_file_ops.clicked.connect(self.cmd_file_ops)
        self._btn_read.clicked.connect(self.cmd_read)
        self._btn_save_mp3.clicked.connect(self.cmd_save_mp3)
        self._btn_prev.clicked.connect(self.cmd_prev)
        self._btn_next.clicked.connect(self.cmd_next)

        return side

    # ── TASK 3 continued: replace viewer with ContinuousViewer ───────────────

    def _build_viewer(self):
        self._scroll = QScrollArea()
        self._scroll.setWidgetResizable(True)
        self._scroll.setAlignment(Qt.AlignmentFlag.AlignHCenter)
        self._scroll.setStyleSheet(
            f"QScrollArea {{ background: {C['bg']}; border: none; }}"
        )

        # The continuous viewer — all pages stacked vertically
        self._continuous_viewer = ContinuousViewer()

        # Placeholder shown before any file is open
        self._placeholder = QWidget()
        ph_l = QVBoxLayout(self._placeholder)
        ph_l.setAlignment(Qt.AlignmentFlag.AlignCenter)
        ph_icon = QLabel("◈")
        ph_icon.setAlignment(Qt.AlignmentFlag.AlignCenter)
        ph_icon.setStyleSheet(f"color: {C['text3']}; font-size: 56px;")
        ph_text = QLabel("Open a PDF to begin")
        ph_text.setAlignment(Qt.AlignmentFlag.AlignCenter)
        ph_text.setStyleSheet(
            f"color: {C['text3']}; font-size: 15px; margin-top: 12px;"
        )
        ph_sub = QLabel("Use  Open PDF  in the sidebar")
        ph_sub.setAlignment(Qt.AlignmentFlag.AlignCenter)
        ph_sub.setStyleSheet(f"color: {C['text3']}; font-size: 12px; margin-top: 4px;")
        ph_l.addWidget(ph_icon)
        ph_l.addWidget(ph_text)
        ph_l.addWidget(ph_sub)

        # Stack: index 0 = placeholder, index 1 = continuous viewer
        self._viewer_stack = QStackedWidget()
        self._viewer_stack.addWidget(self._placeholder)
        self._viewer_stack.addWidget(self._continuous_viewer)
        self._viewer_stack.setCurrentIndex(0)

        # TTS highlight panel (shown at bottom while reading)
        self._tts_panel = QWidget()
        self._tts_panel.setStyleSheet(
            f"background:{C['surface']}; border-top:1px solid {C['border']};"
        )
        self._tts_panel.setVisible(False)
        tts_vl = QVBoxLayout(self._tts_panel)
        tts_vl.setContentsMargins(20, 10, 20, 10)
        tts_vl.setSpacing(4)

        tts_header = QHBoxLayout()
        tts_icon = QLabel("🔊")
        tts_icon.setStyleSheet("font-size:14px; background:transparent;")
        self._tts_page_lbl = QLabel("Reading page 1")
        self._tts_page_lbl.setStyleSheet(
            f"color:{C['text2']}; font-size:11px; font-weight:600; background:transparent;"
        )
        tts_header.addWidget(tts_icon)
        tts_header.addWidget(self._tts_page_lbl)
        tts_header.addStretch()
        tts_vl.addLayout(tts_header)

        self._tts_text = QTextEdit()
        self._tts_text.setReadOnly(True)
        self._tts_text.setFixedHeight(70)
        self._tts_text.setStyleSheet(
            f"""
            QTextEdit {{
                background:{C['bg']}; border:1px solid {C['border2']};
                border-radius:8px; color:{C['text2']};
                font-size:12px; padding:6px 10px;
            }}
        """
        )
        tts_vl.addWidget(self._tts_text)

        # Outer container
        viewer_container = QWidget()
        viewer_container.setStyleSheet(f"background:{C['bg']};")
        vc_layout = QVBoxLayout(viewer_container)
        vc_layout.setContentsMargins(0, 0, 0, 0)
        vc_layout.setSpacing(0)
        vc_layout.addWidget(self._viewer_stack, stretch=1)
        vc_layout.addWidget(self._tts_panel)

        self._scroll.setWidget(viewer_container)
        return self._scroll

    def _build_statusbar(self):
        bar = QWidget()
        bar.setFixedHeight(34)
        bar.setStyleSheet(
            f"background: {C['surface']}; border-top: 1px solid {C['border']};"
        )
        row = QHBoxLayout(bar)
        row.setContentsMargins(20, 0, 20, 0)
        row.setSpacing(0)

        dot = QLabel("●")
        dot.setStyleSheet(f"color: {C['accent']}; font-size: 8px; margin-right: 10px;")
        self._status_lbl = QLabel("Ready")
        self._status_lbl.setStyleSheet(f"color: {C['text2']}; font-size: 12px;")
        row.addWidget(dot)
        row.addWidget(self._status_lbl)
        row.addStretch()

        hints = QLabel("Ctrl+F  search   ·   Ctrl+Scroll  zoom   ·   ← →  navigate")
        hints.setStyleSheet(f"color: {C['text3']}; font-size: 11px;")
        row.addWidget(hints)
        return bar

    def _bind_keys(self):
        QShortcut(QKeySequence("Left"), self, self.cmd_prev)
        QShortcut(QKeySequence("Right"), self, self.cmd_next)
        QShortcut(QKeySequence("PgUp"), self, self.cmd_prev)
        QShortcut(QKeySequence("PgDown"), self, self.cmd_next)
        QShortcut(QKeySequence("Ctrl+="), self, self.cmd_zoom_in)
        QShortcut(QKeySequence("Ctrl+-"), self, self.cmd_zoom_out)
        QShortcut(QKeySequence("Ctrl+0"), self, self.cmd_zoom_reset)
        QShortcut(QKeySequence("Ctrl+F"), self, self.cmd_search_open)
        QShortcut(QKeySequence("Escape"), self, self.cmd_search_close)

    def wheelEvent(self, e):
        mods = e.modifiers()
        if mods == Qt.KeyboardModifier.ControlModifier:
            if e.angleDelta().y() > 0:
                self.cmd_zoom_in()
            else:
                self.cmd_zoom_out()
        else:
            self._scroll.verticalScrollBar().setValue(
                self._scroll.verticalScrollBar().value() - e.angleDelta().y() // 3
            )

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _set_status(self, msg):
        self._status_lbl.setText(msg)

    def _set_progress(self, val, maximum=100):
        self._progress.setMaximum(maximum)
        self._progress.setValue(val)

    # ── TASK 3 continued: scroll to page ────────────────────────────────────

    def _scroll_to_page(self, idx: int):
        """Scroll so page idx is at the top of the viewport."""
        y = self._continuous_viewer.page_top_y(idx)
        QTimer.singleShot(
            30,
            lambda: self._scroll.verticalScrollBar().setValue(y),
        )

    def _update_page_label(self, idx: int):
        self._cur_page = idx
        self._page_lbl.setText(f"{idx + 1} / {self._page_count}")
        self._btn_prev.setEnabled(idx > 0)
        self._btn_next.setEnabled(idx < self._page_count - 1)

    # ── Open PDF ──────────────────────────────────────────────────────────────

    def cmd_open(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "Open PDF", "", "PDF Files (*.pdf);;All Files (*)"
        )
        if not path:
            return
        count = get_page_count(path)
        if count == 0:
            QMessageBox.critical(
                self,
                "Error",
                "Could not open this PDF.\nIt may be corrupted or password-protected.",
            )
            return

        # Stop any ongoing operations
        if self._tts_worker:
            self._stop_reading()
        if self._render_worker:
            self._render_worker.stop()
            self._render_worker = None

        self._path = path
        self._page_count = count
        self._cur_page = 0
        self._zoom = 1.0
        self._zoom_lbl.setText("100%")

        fname = os.path.basename(path)
        self.setWindowTitle(f"Hello C  ·  {fname}")
        kb = os.path.getsize(path) / 1024
        self._file_label.setText(f"{fname}  ·  {kb:.1f} KB  ·  {count} pages")
        self._file_label.setStyleSheet(f"color:{C['text2']};font-size:12px;")
        self._btn_tools.setEnabled(True)
        self._btn_file_ops.setEnabled(True)
        self._search_toggle_btn.setEnabled(True)
        self._search_toggle_btn.setChecked(True)
        self._search_bar.setVisible(True)
        self._search_input.setPlaceholderText(f"Search in {fname}…")
        if TTS_AVAILABLE:
            self._btn_read.setEnabled(True)
            self._btn_save_mp3.setEnabled(True)

        # Initialise continuous viewer
        self._continuous_viewer.set_page_count(count)
        self._viewer_stack.setCurrentIndex(1)
        self._update_page_label(0)

        play("open")
        self._set_status("Loading pages…")
        self._set_progress(0)

        # Start background render
        self._render_worker = ContinuousRenderWorker(path, dpi=150)
        self._render_worker.page_ready.connect(self._on_page_rendered)
        self._render_worker.all_done.connect(self._on_all_pages_rendered)
        self._render_worker.start()

    def _on_page_rendered(self, idx: int, pm: QPixmap):
        self._continuous_viewer.set_page_pixmap(idx, pm)
        pct = int((idx + 1) / self._page_count * 100)
        self._set_progress(pct)
        self._set_status(f"Loaded page {idx + 1} of {self._page_count}…")

    def _on_all_pages_rendered(self):
        self._set_progress(0)
        self._set_status(f"Ready  ·  {self._page_count} pages")

    # ── Navigation ────────────────────────────────────────────────────────────

    def cmd_prev(self):
        if self._cur_page > 0:
            play("click")
            new_page = self._cur_page - 1
            self._update_page_label(new_page)
            self._scroll_to_page(new_page)

    def cmd_next(self):
        if self._cur_page < self._page_count - 1:
            play("click")
            new_page = self._cur_page + 1
            self._update_page_label(new_page)
            self._scroll_to_page(new_page)

    def cmd_zoom_in(self):
        self._zoom = min(round(self._zoom + 0.5, 2), 4.0)
        self._zoom_lbl.setText(f"{int(self._zoom * 100)}%")
        self._continuous_viewer.set_zoom(self._zoom)

    def cmd_zoom_out(self):
        self._zoom = max(round(self._zoom - 0.5, 2), 0.5)
        self._zoom_lbl.setText(f"{int(self._zoom * 100)}%")
        self._continuous_viewer.set_zoom(self._zoom)

    def cmd_zoom_reset(self):
        self._zoom = 1.0
        self._zoom_lbl.setText("100%")
        self._continuous_viewer.set_zoom(self._zoom)

    # ── Search ────────────────────────────────────────────────────────────────

    def _on_search_toggle(self, checked):
        if checked:
            self.cmd_search_open()
        else:
            self.cmd_search_close()

    def cmd_search_open(self):
        if not self._path:
            return
        self._search_bar.setVisible(True)
        self._search_toggle_btn.setChecked(True)
        self._search_input.setFocus()
        self._search_input.selectAll()

    def cmd_search_close(self):
        self._search_bar.setVisible(False)
        self._search_toggle_btn.setChecked(False)
        self._search_input.clear()
        self._search_results = []
        self._search_idx = -1
        self._search_count_lbl.setText("")
        # Restore any highlighted page
        if self._hl_page >= 0:
            self._continuous_viewer.restore_page(self._hl_page)
            self._hl_page = -1

    def _on_search_text_changed(self, text):
        self._search_results = []
        self._search_idx = -1
        self._search_count_lbl.setText("")
        if self._hl_page >= 0:
            self._continuous_viewer.restore_page(self._hl_page)
            self._hl_page = -1
        if not text.strip() or not self._path:
            return
        try:
            doc = fitz.open(self._path)
            for pg_i in range(doc.page_count):
                pg = doc[pg_i]
                hits = pg.search_for(text)
                for r in hits:
                    self._search_results.append((pg_i, fitz.Rect(r)))
            doc.close()
        except Exception as ex:
            print(f"Search error: {ex}")
            return
        n = len(self._search_results)
        if n == 0:
            self._search_count_lbl.setText("No results")
            self._search_count_lbl.setStyleSheet(
                f"color:{C['red']};font-size:11px;font-weight:600;"
            )
        else:
            self._search_idx = 0
            self._search_count_lbl.setStyleSheet(
                f"color:{C['accent2']};font-size:11px;font-weight:600;"
            )
            self._show_search_match()

    def cmd_search_next(self):
        if not self._search_results:
            return
        self._search_idx = (self._search_idx + 1) % len(self._search_results)
        self._show_search_match()

    def cmd_search_prev(self):
        if not self._search_results:
            return
        self._search_idx = (self._search_idx - 1) % len(self._search_results)
        self._show_search_match()

    def _show_search_match(self):
        if not self._search_results or self._search_idx < 0:
            return
        pg_i, rect = self._search_results[self._search_idx]
        n = len(self._search_results)
        self._search_count_lbl.setText(f"{self._search_idx + 1} / {n}")

        # Restore previously highlighted page
        if self._hl_page >= 0 and self._hl_page != pg_i:
            self._continuous_viewer.restore_page(self._hl_page)

        self._hl_page = pg_i
        self._update_page_label(pg_i)

        # Render highlighted version
        try:
            doc = fitz.open(self._path)
            page = doc[pg_i]
            query = self._search_input.text()

            for i, (res_pg, res_rect) in enumerate(self._search_results):
                if res_pg != pg_i:
                    continue
                is_current = i == self._search_idx
                r = fitz.Rect(
                    res_rect.x0, res_rect.y0 - 1, res_rect.x1, res_rect.y1 + 1
                )
                sh = page.new_shape()
                sh.draw_rect(r)
                sh.finish(
                    fill=(1.0, 0.55, 0.0) if is_current else (1.0, 0.95, 0.0),
                    color=(0.8, 0.4, 0.0) if is_current else (0.85, 0.70, 0.0),
                    width=0.5,
                    fill_opacity=0.6 if is_current else 0.35,
                )
                sh.commit()

            dpi = 150
            mat = fitz.Matrix(dpi / 72, dpi / 72)
            pix = page.get_pixmap(matrix=mat, alpha=False)
            doc.close()

            img = QImage(
                pix.samples,
                pix.width,
                pix.height,
                pix.stride,
                QImage.Format.Format_RGB888,
            )
            self._continuous_viewer.replace_page_pixmap(pg_i, QPixmap.fromImage(img))

            # Scroll to the match
            scale = (dpi / 72) * self._zoom
            page_y = self._continuous_viewer.page_top_y(pg_i)
            scroll_y = max(0, page_y + int(rect.y0 * scale) - 120)
            QTimer.singleShot(
                40, lambda sy=scroll_y: self._scroll.verticalScrollBar().setValue(sy)
            )

        except Exception as ex:
            print(f"Search render error: {ex}")
            import traceback

            traceback.print_exc()

    # ── Jump to page ──────────────────────────────────────────────────────────

    def cmd_jump_to_page(self):
        if not self._path:
            return
        self._page_jump_input.setText(str(self._cur_page + 1))
        self._page_stack.setCurrentIndex(1)
        self._page_jump_input.setFocus()
        self._page_jump_input.selectAll()

    def _commit_jump(self):
        if self._page_stack.currentIndex() != 1:
            return
        self._page_stack.setCurrentIndex(0)
        text = self._page_jump_input.text().strip()
        try:
            pg = int(text) - 1
            if 0 <= pg < self._page_count:
                self._update_page_label(pg)
                self._scroll_to_page(pg)
        except ValueError:
            pass
        self._page_jump_input.clearFocus()

    # ── TTS helpers ───────────────────────────────────────────────────────────

    def _get_voice_id(self):
        idx = self._voice_combo.currentIndex()
        if 0 <= idx < len(self._tts_voices):
            return self._tts_voices[idx][1]
        return None

    def _get_speed(self):
        return self._speed_slider.value()

    def _stop_reading(self):
        if self._tts_worker:
            try:
                self._tts_worker.done.disconnect(self._on_tts_done)
            except Exception:
                pass
            self._tts_worker.stop()
            self._tts_worker = None
        self._reading = False
        self._clear_tts_highlight()
        self._btn_read.setText("Read Aloud")
        self._btn_read.setActive(False)
        self._tts_panel.setVisible(False)
        self._set_status("Stopped.")

    def cmd_read(self):
        if not self._path:
            return
        if self._reading:
            self._stop_reading()
            return

        segments = []
        self._set_status("Collecting text…")
        QApplication.processEvents()
        for i in range(self._cur_page, self._page_count):
            t = extract_page_text(self._path, i)
            if t.strip():
                segments.append((i, t))
                self._reading_page_texts[i] = t

        if not segments:
            QMessageBox.information(
                self, "No Text", "No readable text found from this page onward."
            )
            return

        self._reading = True
        self._btn_read.setText("Stop Reading")
        self._btn_read.setActive(True)
        self._tts_panel.setVisible(True)
        self._set_status("Reading aloud…")

        self._tts_worker = TtsWorker(
            segments,
            voice_id=self._get_voice_id(),
            rate_getter=self._get_speed,
        )
        self._tts_worker.sentence_read.connect(self._on_sentence_read)
        self._tts_worker.page_started.connect(self._on_tts_page_started)
        self._tts_worker.done.connect(self._on_tts_done)
        self._tts_worker.start()

    def _on_tts_page_started(self, page_idx: int):
        self._tts_page_lbl.setText(f"Reading page {page_idx + 1}")
        # Scroll so the page comes into view
        self._update_page_label(page_idx)
        self._scroll_to_page(page_idx)

    def _on_sentence_read(
        self, page_idx: int, char_start: int, char_end: int, sentence_text: str
    ):
        """
        Called AFTER a sentence has been spoken.
        Update the TTS panel and highlight the sentence on the page.
        """
        if not self._reading:
            return

        self._tts_page_lbl.setText(f"Reading page {page_idx + 1}")
        self._tts_text.setPlainText(sentence_text)
        self._set_status(f"Reading page {page_idx + 1} of {self._page_count}…")

        # Clear the previous highlight page if it differs
        if self._hl_page >= 0 and self._hl_page != page_idx:
            self._continuous_viewer.restore_page(self._hl_page)

        self._hl_page = page_idx
        page_text = self._reading_page_texts.get(page_idx, "")
        if not page_text:
            return

        # Render highlighted page in background
        pm, scroll_y = render_page_highlighted(
            self._path, page_idx, char_start, char_end, page_text, dpi=150
        )
        self._continuous_viewer.replace_page_pixmap(page_idx, pm)

        # Scroll so the highlighted sentence is visible
        if scroll_y is not None:
            page_y = self._continuous_viewer.page_top_y(page_idx)
            target_y = page_y + int(scroll_y * self._zoom)
            QTimer.singleShot(
                30,
                lambda ty=target_y: self._scroll.verticalScrollBar().setValue(ty),
            )

    def _clear_tts_highlight(self):
        if self._hl_page >= 0:
            self._continuous_viewer.restore_page(self._hl_page)
            self._hl_page = -1
        self._reading_page_texts.clear()

    def _on_tts_done(self):
        self._tts_worker = None
        self._reading = False
        self._clear_tts_highlight()
        self._btn_read.setText("Read Aloud")
        self._btn_read.setActive(False)
        self._tts_panel.setVisible(False)
        self._set_status("Done reading.")

    def cmd_save_mp3(self):
        if not self._path or not TTS_AVAILABLE:
            return
        save_path, _ = QFileDialog.getSaveFileName(
            self,
            "Save as MP3",
            os.path.splitext(os.path.basename(self._path))[0] + ".mp3",
            "MP3 Audio (*.mp3)",
        )
        if not save_path:
            return
        self._set_status("Extracting text…")
        QApplication.processEvents()
        all_text = "\n\n".join(
            extract_page_text(self._path, i) for i in range(self._page_count)
        )
        if not all_text.strip():
            QMessageBox.information(
                self, "No Text", "No readable text found in this PDF."
            )
            return
        self._set_status("Saving MP3…")
        QApplication.processEvents()
        try:
            e = pyttsx3.init()
            e.setProperty("rate", self._get_speed())
            vid = self._get_voice_id()
            if vid:
                e.setProperty("voice", vid)
            e.save_to_file(all_text, save_path)
            e.runAndWait()
            play("success")
            QMessageBox.information(self, "Saved", f"Audio saved to:\n{save_path}")
            self._set_status("MP3 saved.")
        except Exception as ex:
            play("error")
            QMessageBox.critical(self, "Error", str(ex))

    def cmd_merge(self):
        paths, _ = QFileDialog.getOpenFileNames(
            self, "Select PDFs to merge", "", "PDF Files (*.pdf)"
        )
        if len(paths) < 2:
            QMessageBox.information(
                self,
                "Merge PDFs",
                "You cannot merge one PDF.\nPlease select at least two (2) PDF files.",
            )
            return
        save_path, _ = QFileDialog.getSaveFileName(
            self, "Save merged PDF", "merged.pdf", "PDF Files (*.pdf)"
        )
        if not save_path:
            return
        self._set_status("Merging…")
        QApplication.processEvents()
        try:
            w = PdfWriter()
            for p in paths:
                for pg in PdfReader(p).pages:
                    w.add_page(pg)
            with open(save_path, "wb") as f:
                w.write(f)
            play("success")
            QMessageBox.information(self, "Done", f"Merged PDF saved to:\n{save_path}")
            self._set_status("Merged.")
        except Exception as ex:
            play("error")
            QMessageBox.critical(self, "Error", str(ex))

    def cmd_file_ops(self):
        if not self._path:
            return
        dlg = FileOpsDialog(self._path, self._page_count, self)
        dlg._cur_page_hint = self._cur_page
        if dlg.exec() != QDialog.DialogCode.Accepted or not dlg.result:
            return

        op = dlg.result[0]
        base = os.path.splitext(os.path.basename(self._path))[0]

        if op == "split_all":
            out_dir = QFileDialog.getExistingDirectory(
                self, "Choose output folder for split pages"
            )
            if not out_dir:
                return
            kw = {"inp": self._path, "out_dir": out_dir, "base": base}

        elif op == "split_range":
            suffix = f"_p{dlg.result[1]+1}-{dlg.result[2]+1}"
            save_path, _ = QFileDialog.getSaveFileName(
                self,
                "Save extracted pages as",
                base + suffix + ".pdf",
                "PDF Files (*.pdf)",
            )
            if not save_path:
                return
            kw = {
                "inp": self._path,
                "out": save_path,
                "start": dlg.result[1],
                "end": dlg.result[2],
            }

        elif op == "rotate":
            save_path, _ = QFileDialog.getSaveFileName(
                self,
                "Save rotated PDF as",
                base + "_rotated.pdf",
                "PDF Files (*.pdf)",
            )
            if not save_path:
                return
            kw = {
                "inp": self._path,
                "out": save_path,
                "degrees": dlg.result[1],
                "pages": dlg.result[2],
            }

        elif op == "watermark":
            save_path, _ = QFileDialog.getSaveFileName(
                self,
                "Save watermarked PDF as",
                base + "_watermarked.pdf",
                "PDF Files (*.pdf)",
            )
            if not save_path:
                return
            kw = {
                "inp": self._path,
                "out": save_path,
                "text": dlg.result[1],
                "opacity": dlg.result[2],
            }

        elif op == "password":
            save_path, _ = QFileDialog.getSaveFileName(
                self,
                "Save encrypted PDF as",
                base + "_protected.pdf",
                "PDF Files (*.pdf)",
            )
            if not save_path:
                return
            kw = {
                "inp": self._path,
                "out": save_path,
                "user_pw": dlg.result[1],
                "owner_pw": dlg.result[2],
            }
        else:
            return

        self._file_ops_worker = FileOpsWorker(op, **kw)
        self._file_ops_worker.progress.connect(self._on_tool_progress)
        self._file_ops_worker.finished.connect(self._on_file_ops_done)
        self._set_progress(0)
        self._set_status("Processing…")
        self._file_ops_worker.start()

    def _on_file_ops_done(self, ok, detail):
        self._set_progress(0)
        if ok:
            play("done")
            self._set_status("Done.")
            QMessageBox.information(self, "Done", detail)
        else:
            play("error")
            self._set_status("Failed.")
            QMessageBox.critical(self, "Error", f"Operation failed.\n{detail}")

    def cmd_tools(self):
        if not self._path:
            return
        dlg = PdfToolsDialog(self._path, self._page_count, self)
        if dlg.exec() != QDialog.DialogCode.Accepted or not dlg.result:
            return

        op = dlg.result[0]
        suffix = "_resized" if op == "dim" else "_compressed"
        save_path, _ = QFileDialog.getSaveFileName(
            self,
            "Save as",
            os.path.splitext(os.path.basename(self._path))[0] + suffix + ".pdf",
            "PDF Files (*.pdf)",
        )
        if not save_path:
            return

        orig_kb = os.path.getsize(self._path) / 1024
        kw = {
            "inp": self._path,
            "out": save_path,
            "orig_kb": orig_kb,
            "pages": self._page_count,
        }

        if op == "kb":
            kw["target_kb"] = dlg.result[1]
        elif op == "dim":
            kw["w_mm"] = dlg.result[1]
            kw["h_mm"] = dlg.result[2]
        else:
            kw["level"] = dlg.result[1]

        self._tool_worker = PdfToolWorker(op, **kw)
        self._tool_worker.progress.connect(self._on_tool_progress)
        self._tool_worker.finished.connect(self._on_tool_done)
        self._set_progress(0)
        self._set_status("Processing…")
        self._tool_worker.start()

    def _on_tool_progress(self, val, maximum, msg):
        pct = int(val / maximum * 100) if maximum else 0
        self._set_progress(pct)
        self._set_status(msg)

    def _on_tool_done(self, ok, detail):
        self._set_progress(0)
        if ok:
            play("done")
            self._set_status("Done.")
            QMessageBox.information(self, "Complete", detail)
        else:
            play("error")
            self._set_status("Failed.")
            QMessageBox.critical(self, "Error", f"Operation failed.\n{detail}")


# ─────────────────────────────────────────────────────────────────────────────
#  Entry Point
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    app = QApplication(sys.argv)
    app.setStyle("Fusion")

    pal = app.palette()
    pal.setColor(QPalette.ColorRole.Window, QColor(C["bg"]))
    pal.setColor(QPalette.ColorRole.WindowText, QColor(C["text"]))
    pal.setColor(QPalette.ColorRole.Base, QColor(C["surface"]))
    pal.setColor(QPalette.ColorRole.AlternateBase, QColor(C["surface2"]))
    pal.setColor(QPalette.ColorRole.Text, QColor(C["text"]))
    pal.setColor(QPalette.ColorRole.Button, QColor(C["surface2"]))
    pal.setColor(QPalette.ColorRole.ButtonText, QColor(C["text"]))
    pal.setColor(QPalette.ColorRole.Highlight, QColor(C["accent"]))
    pal.setColor(QPalette.ColorRole.HighlightedText, QColor("#FFFFFF"))
    app.setPalette(pal)

    win = TrixieWindow()
    win.show()
    sys.exit(app.exec())
