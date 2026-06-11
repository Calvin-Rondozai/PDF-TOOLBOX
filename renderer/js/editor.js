/** PDF page editor — overlay annotations and real text editing */

export class PdfEditor {
  constructor(viewerEl) {
    this.viewerEl = viewerEl;
    this.active = false;
    this.tool = "modify";
    this.edits = [];
    this._drag = null;
    this._spans = {};
    this._path = null;
    this.onChange = null;
  }

  setPath(path) {
    this._path = path;
    this._spans = {};
  }

  setTool(tool) {
    this.tool = tool;
    document.querySelectorAll(".edit-tool-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.editTool === tool);
    });
    this.refreshOverlays();
  }

  async enable(path) {
    this.active = true;
    this._path = path;
    this.edits = [];
    document.getElementById("edit-bar")?.classList.remove("hidden");
    await this._loadVisibleSpans();
    this._attachOverlays();
  }

  disable() {
    this.active = false;
    document.getElementById("edit-bar")?.classList.add("hidden");
    this.viewerEl.querySelectorAll(".page-edit-overlay, .text-span-hit").forEach((el) => el.remove());
    this.edits = [];
    this._spans = {};
  }

  async _loadVisibleSpans() {
    if (!this._path) return;
    for (const wrap of this.viewerEl.querySelectorAll(".page-wrap")) {
      const page = parseInt(wrap.dataset.page, 10);
      if (this._spans[page]) continue;
      const r = await window.pdfApi.runOp({
        op: "get_text_spans",
        path: this._path,
        page,
      });
      this._spans[page] = r.spans || [];
    }
  }

  _attachOverlays() {
    this.viewerEl.querySelectorAll(".page-wrap").forEach((wrap) => {
      wrap.querySelectorAll(".page-edit-overlay, .text-span-hit").forEach((el) => el.remove());
      const page = parseInt(wrap.dataset.page, 10);
      const overlay = document.createElement("div");
      overlay.className = "page-edit-overlay";
      overlay.dataset.page = page;
      const img = wrap.querySelector("img");
      if (img) {
        overlay.style.width = img.style.width || `${img.width}px`;
        overlay.style.height = img.style.height || `${img.height}px`;
      }
      overlay.addEventListener("mousedown", (e) => this._onPointerDown(e, page, overlay));
      overlay.addEventListener("mousemove", (e) => this._onPointerMove(e, page, overlay));
      overlay.addEventListener("mouseup", (e) => this._onPointerUp(e, page, overlay));
      wrap.appendChild(overlay);

      if (this.tool === "modify") this._renderSpanHits(page, overlay);
    });
  }

  _renderSpanHits(page, overlay) {
    const img = overlay.parentElement?.querySelector("img");
    if (!img) return;
    const scaleX = overlay.offsetWidth / (img.naturalWidth || overlay.offsetWidth);
    const scaleY = overlay.offsetHeight / (img.naturalHeight || overlay.offsetHeight);

    (this._spans[page] || []).forEach((span, idx) => {
      const hit = document.createElement("button");
      hit.type = "button";
      hit.className = "text-span-hit";
      hit.dataset.idx = idx;
      hit.title = "Click to edit this text";
      hit.textContent = span.text.length > 40 ? `${span.text.slice(0, 40)}…` : span.text;
      Object.assign(hit.style, {
        left: `${span.x0 * scaleX}px`,
        top: `${span.y0 * scaleY}px`,
        width: `${Math.max(20, (span.x1 - span.x0) * scaleX)}px`,
        minHeight: `${Math.max(14, (span.y1 - span.y0) * scaleY)}px`,
        fontSize: `${Math.max(8, (span.size || 11) * scaleY)}px`,
      });
      hit.addEventListener("click", (e) => {
        e.stopPropagation();
        this._editSpan(page, idx, span, overlay);
      });
      overlay.appendChild(hit);
    });
  }

  _editSpan(page, idx, span, overlay) {
    const newText = prompt("Edit text:", span.text);
    if (newText === null || newText === span.text) return;
    this.edits.push({
      type: "replace_text",
      page,
      x0: span.x0,
      y0: span.y0,
      x1: span.x1,
      y1: span.y1,
      text: newText,
      old_text: span.text,
      size: span.size || 11,
    });
    this._spans[page][idx].text = newText;
    this._renderSpanHits(page, overlay);
    this.onChange?.();
  }

  async refreshOverlays() {
    if (!this.active) return;
    await this._loadVisibleSpans();
    this.viewerEl.querySelectorAll(".page-edit-overlay, .text-span-hit").forEach((el) => el.remove());
    this._attachOverlays();
    this._renderMarks();
  }

  _pageCoords(e, overlay) {
    const r = overlay.getBoundingClientRect();
    const scaleX = overlay.offsetWidth / r.width;
    const scaleY = overlay.offsetHeight / r.height;
    return {
      x: (e.clientX - r.left) * scaleX,
      y: (e.clientY - r.top) * scaleY,
    };
  }

  _onPointerDown(e, page, overlay) {
    if (!this.active || e.button !== 0 || this.tool === "modify") return;
    const pt = this._pageCoords(e, overlay);
    if (this.tool === "text") {
      const text = prompt("Enter text to add:");
      if (!text?.trim()) return;
      const edit = { type: "text", page, x: pt.x, y: pt.y, text: text.trim(), size: 14 };
      this.edits.push(edit);
      this._renderMarks();
      this.onChange?.();
      return;
    }
    this._drag = { page, overlay, x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y, tool: this.tool };
  }

  _onPointerMove(e, page, overlay) {
    if (!this._drag || this._drag.page !== page) return;
    const pt = this._pageCoords(e, overlay);
    this._drag.x1 = pt.x;
    this._drag.y1 = pt.y;
    this._renderDragPreview();
  }

  _onPointerUp(e, page) {
    if (!this._drag || this._drag.page !== page) return;
    const d = this._drag;
    const x0 = Math.min(d.x0, d.x1);
    const y0 = Math.min(d.y0, d.y1);
    const x1 = Math.max(d.x0, d.x1);
    const y1 = Math.max(d.y0, d.y1);
    if (x1 - x0 > 8 && y1 - y0 > 8) {
      this.edits.push({
        type: d.tool,
        page: d.page,
        x0, y0, x1, y1,
        color: d.tool === "highlight" ? [1, 1, 0] : [0.23, 0.39, 0.9],
      });
      this.onChange?.();
    }
    this._drag = null;
    this._renderMarks();
  }

  _renderDragPreview() {
    this._renderMarks();
    if (!this._drag) return;
    const overlay = this._drag.overlay;
    let box = overlay.querySelector(".edit-drag-preview");
    if (!box) {
      box = document.createElement("div");
      box.className = "edit-drag-preview";
      overlay.appendChild(box);
    }
    const x0 = Math.min(this._drag.x0, this._drag.x1);
    const y0 = Math.min(this._drag.y0, this._drag.y1);
    const w = Math.abs(this._drag.x1 - this._drag.x0);
    const h = Math.abs(this._drag.y1 - this._drag.y0);
    Object.assign(box.style, {
      left: `${x0}px`, top: `${y0}px`, width: `${w}px`, height: `${h}px`,
      background: this._drag.tool === "highlight" ? "rgba(255,235,59,0.45)" : "rgba(99,102,241,0.2)",
      border: this._drag.tool === "highlight" ? "none" : "2px solid var(--primary)",
    });
  }

  _renderMarks() {
    this.viewerEl.querySelectorAll(".page-edit-overlay").forEach((overlay) => {
      overlay.querySelectorAll(".edit-mark, .edit-drag-preview").forEach((el) => el.remove());
      const page = parseInt(overlay.dataset.page, 10);
      const img = overlay.parentElement?.querySelector("img");
      const scale = img ? overlay.offsetWidth / (img.naturalWidth || overlay.offsetWidth) : 1;

      this.edits.filter((ed) => ed.page === page).forEach((ed) => {
        if (ed.type === "replace_text") return;
        const el = document.createElement("div");
        el.className = "edit-mark";
        if (ed.type === "text") {
          el.className += " edit-mark-text";
          el.textContent = ed.text;
          el.style.left = `${ed.x}px`;
          el.style.top = `${ed.y}px`;
          el.style.fontSize = `${(ed.size || 14) * scale}px`;
        } else {
          el.style.left = `${ed.x0}px`;
          el.style.top = `${ed.y0}px`;
          el.style.width = `${ed.x1 - ed.x0}px`;
          el.style.height = `${ed.y1 - ed.y0}px`;
          el.style.background = ed.type === "highlight" ? "rgba(255,235,59,0.45)" : "transparent";
          el.style.border = ed.type === "rect" ? "2px solid var(--primary)" : "none";
        }
        overlay.appendChild(el);
      });
    });
  }

  getEditsForSave(zoom = 1) {
    return this.edits.map((ed) => {
      const copy = { ...ed };
      if (copy.type === "text") {
        copy.x /= zoom;
        copy.y /= zoom;
        copy.size = (copy.size || 14) / zoom;
      } else if (copy.type === "replace_text") {
        copy.x0 /= zoom;
        copy.y0 /= zoom;
        copy.x1 /= zoom;
        copy.y1 /= zoom;
        copy.size = (copy.size || 11) / zoom;
      } else {
        copy.x0 /= zoom;
        copy.y0 /= zoom;
        copy.x1 /= zoom;
        copy.y1 /= zoom;
      }
      return copy;
    });
  }

  hasEdits() {
    return this.edits.length > 0;
  }
}
