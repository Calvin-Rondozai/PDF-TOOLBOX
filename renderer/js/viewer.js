export class PdfViewer {
  constructor(container) {
    this.container = container;
    this.path = null;
    this.zoom = 1.0;
    this.dpi = 150;
    this.pageCount = 0;
    this.currentPage = 0;
    this.pageEls = [];
    this.searchResults = [];
    this.searchIndex = -1;
    this.rendering = false;
  }

  _highlightsForPage(pageIndex) {
    return this.searchResults
      .filter((r) => r.page === pageIndex)
      .map((r) => ({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 }));
  }

  _activeHiForPage(pageIndex) {
    if (this.searchIndex < 0 || !this.searchResults.length) return -1;
    const active = this.searchResults[this.searchIndex];
    if (active.page !== pageIndex) return -1;
    const onPage = this.searchResults.filter((r) => r.page === pageIndex);
    return onPage.findIndex(
      (r) => r.x0 === active.x0 && r.y0 === active.y0 && r.x1 === active.x1
    );
  }

  async loadFromPath(filePath) {
    this.destroy();
    this.path = filePath;
    const r = await window.pdfApi.runOp({ op: "get_page_count", path: filePath });
    this.pageCount = r.count || 0;
    this.currentPage = 0;
    this.pageEls = [];
    this.container.innerHTML = "";

    for (let i = 0; i < this.pageCount; i++) {
      const wrap = document.createElement("div");
      wrap.className = "page-wrap";
      wrap.dataset.page = i;
      const placeholder = document.createElement("div");
      placeholder.className = "page-placeholder";
      placeholder.textContent = `Loading page ${i + 1}…`;
      wrap.appendChild(placeholder);
      this.container.appendChild(wrap);
      this.pageEls.push({ wrap, img: null, loaded: false });
    }

    const initial = Math.min(4, this.pageCount);
    const firstBatch = [...Array(initial).keys()];
    await Promise.all(firstBatch.map((i) => this.renderPage(i)));
    this.renderVisiblePages();
    return this.pageCount;
  }

  async renderPage(pageIndex, force = false) {
    if (pageIndex < 0 || pageIndex >= this.pageCount) return;
    const el = this.pageEls[pageIndex];
    if (!force && el.loaded && el.img) return;

    const highlights = this._highlightsForPage(pageIndex);
    const activeHi = this._activeHiForPage(pageIndex);

    const r = await window.pdfApi.runOp({
      op: "render_page",
      path: this.path,
      page: pageIndex,
      dpi: this.dpi,
      zoom: this.zoom,
      highlights: highlights.length ? highlights : undefined,
      active_hi: activeHi,
    });

    if (!r.ok || !r.image) return;

    const preservedOverlays = [...el.wrap.querySelectorAll(".sig-overlay")];
    el.wrap.innerHTML = "";
    const img = document.createElement("img");
    img.src = `data:image/png;base64,${r.image}`;
    img.alt = `Page ${pageIndex + 1}`;
    img.dataset.page = pageIndex;
    img.style.width = `${Math.round(r.width)}px`;
    img.style.height = `${Math.round(r.height)}px`;
    el.wrap.appendChild(img);
    for (const overlay of preservedOverlays) el.wrap.appendChild(overlay);
    el.img = img;
    el.loaded = true;
  }

  async renderVisiblePages() {
    if (this.rendering || !this.path) return;
    this.rendering = true;
    const rect = this.container.getBoundingClientRect();
    const top = this.container.scrollTop;
    const bottom = top + rect.height + 400;

    const toRender = [];
    for (let i = 0; i < this.pageCount; i++) {
      const wrap = this.pageEls[i].wrap;
      const y = wrap.offsetTop;
      const h = wrap.offsetHeight || 900;
      if (y + h >= top - 200 && y <= bottom && !this.pageEls[i].loaded) {
        toRender.push(i);
      }
    }
    await Promise.all(toRender.map((i) => this.renderPage(i)));
    this.rendering = false;
  }

  async refreshHighlights() {
    if (!this.path) return;
    const pages = new Set();
    if (this.searchIndex >= 0) {
      pages.add(this.searchResults[this.searchIndex].page);
    }
    for (const r of this.searchResults) pages.add(r.page);

    const visible = [];
    const rect = this.container.getBoundingClientRect();
    const top = this.container.scrollTop;
    const bottom = top + rect.height + 400;
    for (let i = 0; i < this.pageCount; i++) {
      if (!pages.has(i)) continue;
      const wrap = this.pageEls[i].wrap;
      const y = wrap.offsetTop;
      const h = wrap.offsetHeight || 900;
      if (y + h >= top - 200 && y <= bottom) visible.push(i);
    }

    await Promise.all(
      visible.map((i) => {
        this.pageEls[i].loaded = false;
        return this.renderPage(i, true);
      })
    );
  }

  async setZoom(zoom) {
    this.zoom = Math.max(0.5, Math.min(3, zoom));
    for (const el of this.pageEls) {
      el.loaded = false;
      el.img = null;
      el.wrap.innerHTML = `<div class="page-placeholder">Loading…</div>`;
    }
    await this.renderVisiblePages();
    return this.zoom;
  }

  scrollToPage(pageIndex) {
    const wrap = this.pageEls[pageIndex]?.wrap;
    if (wrap) {
      wrap.scrollIntoView({ behavior: "smooth", block: "start" });
      this.currentPage = pageIndex;
      this.renderVisiblePages();
    }
  }

  getPageAtScroll() {
    const rect = this.container.getBoundingClientRect();
    const mid = rect.top + rect.height / 3;
    for (let i = 0; i < this.pageEls.length; i++) {
      const r = this.pageEls[i].wrap.getBoundingClientRect();
      if (r.top <= mid && r.bottom >= mid) return i;
    }
    return this.currentPage;
  }

  async search(query) {
    this.searchResults = [];
    this.searchIndex = -1;
    if (!query || !this.path) return [];

    const r = await window.pdfApi.runOp({ op: "search", path: this.path, query });
    this.searchResults = r.results || [];
    if (this.searchResults.length) {
      this.searchIndex = 0;
      this.scrollToPage(this.searchResults[0].page);
      await this.refreshHighlights();
    }
    return this.searchResults;
  }

  async searchNext() {
    if (!this.searchResults.length) return 0;
    this.searchIndex = (this.searchIndex + 1) % this.searchResults.length;
    this.scrollToPage(this.searchResults[this.searchIndex].page);
    await this.refreshHighlights();
    return this.searchIndex;
  }

  async searchPrev() {
    if (!this.searchResults.length) return 0;
    this.searchIndex =
      (this.searchIndex - 1 + this.searchResults.length) % this.searchResults.length;
    this.scrollToPage(this.searchResults[this.searchIndex].page);
    await this.refreshHighlights();
    return this.searchIndex;
  }

  async clearSearch() {
    this.searchResults = [];
    this.searchIndex = -1;
    const toRefresh = [];
    for (let i = 0; i < this.pageCount; i++) {
      if (this.pageEls[i].loaded) toRefresh.push(i);
    }
    await Promise.all(
      toRefresh.map((i) => {
        this.pageEls[i].loaded = false;
        return this.renderPage(i, true);
      })
    );
  }

  destroy() {
    this.container.innerHTML = "";
    this.pageEls = [];
    this.path = null;
    this.pageCount = 0;
  }
}
