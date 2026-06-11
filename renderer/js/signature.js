import { PDFDocument } from "../../node_modules/pdf-lib/dist/pdf-lib.esm.min.js";
import SignaturePad from "../../node_modules/signature_pad/dist/signature_pad.js";
import { showModal } from "./modals.js";
import { svgIcon } from "./icons.js";

const STORE_KEY = "hello_c_signatures";

export function loadSavedSignatures() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
  } catch {
    return [];
  }
}

export function saveSignaturePreset(sig) {
  const all = loadSavedSignatures();
  all.unshift(sig);
  localStorage.setItem(STORE_KEY, JSON.stringify(all.slice(0, 20)));
}

function removeSignaturePreset(id) {
  const all = loadSavedSignatures().filter((s) => s.id !== id);
  localStorage.setItem(STORE_KEY, JSON.stringify(all));
}

function uid() {
  return `sig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function renderTypedSignature(text, fontSize = 72) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const font = `${fontSize}px "Dancing Script", "Segoe Script", cursive`;
  ctx.font = font;
  const metrics = ctx.measureText(text);
  canvas.width = Math.ceil(metrics.width) + 48;
  canvas.height = Math.ceil(fontSize * 1.35);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = font;
  ctx.fillStyle = "#111827";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 24, canvas.height / 2);
  return canvas.toDataURL("image/png");
}

function ensureTransparentDataUrl(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (r > 245 && g > 245 && b > 245) data[i + 3] = 0;
      }
      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function wireTabs(root) {
  const tabs = root.querySelectorAll(".sig-tab");
  const panels = root.querySelectorAll(".sig-panel");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      panels.forEach((p) => p.classList.add("hidden"));
      tab.classList.add("active");
      root.querySelector(`#sig-panel-${tab.dataset.sigTab}`)?.classList.remove("hidden");
    });
  });
}

function renderSavedList(root, onPick) {
  const list = root.querySelector("#sig-saved-list");
  if (!list) return;
  const saved = loadSavedSignatures();
  if (!saved.length) {
    list.innerHTML = `<p class="form-desc">No saved signatures yet. Create one in Draw, Type, or Upload.</p>`;
    return;
  }
  list.innerHTML = saved
    .map(
      (s) => `
    <div class="sig-saved-item" data-id="${s.id}" role="button" tabindex="0">
      <img src="${s.dataUrl}" alt="${s.name}" />
      <span>${s.name}</span>
      <button type="button" class="sig-saved-del" data-del="${s.id}" title="Remove">×</button>
    </div>`
    )
    .join("");
  list.querySelectorAll(".sig-saved-item").forEach((row) => {
    const pick = (e) => {
      if (e.target.closest("[data-del]")) return;
      const sig = saved.find((s) => s.id === row.dataset.id);
      if (sig) onPick(sig.dataUrl);
    };
    row.addEventListener("click", pick);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") pick(e);
    });
  });
  list.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeSignaturePreset(btn.dataset.del);
      renderSavedList(root, onPick);
    });
  });
}

export function showSignaturePicker({ showToast }) {
  const bodyHtml = `
    <div class="sig-tabs">
      <button type="button" class="sig-tab active" data-sig-tab="draw">Draw</button>
      <button type="button" class="sig-tab" data-sig-tab="type">Type</button>
      <button type="button" class="sig-tab" data-sig-tab="upload">Upload</button>
      <button type="button" class="sig-tab" data-sig-tab="saved">Saved</button>
    </div>
    <div id="sig-panel-draw" class="sig-panel">
      <p class="form-desc">Draw your signature below. The background stays transparent.</p>
      <div class="sig-canvas-wrap sig-transparent-bg">
        <canvas id="sig-draw-canvas" width="520" height="200"></canvas>
      </div>
      <button type="button" class="btn-ghost sm" id="sig-draw-clear">Clear</button>
    </div>
    <div id="sig-panel-type" class="sig-panel hidden">
      <p class="form-desc">Type your name — shown in cursive on a transparent background.</p>
      <input class="form-input sig-type-input" id="sig-type-input" placeholder="Your name" maxlength="48" />
      <div class="sig-type-preview-wrap sig-transparent-bg">
        <canvas id="sig-type-preview" width="520" height="120"></canvas>
      </div>
    </div>
    <div id="sig-panel-upload" class="sig-panel hidden">
      <p class="form-desc">Upload a PNG or JPG. White areas are made transparent automatically.</p>
      <label class="sig-file-label">
        <input type="file" id="sig-upload-input" class="sig-file-input" accept="image/png,image/jpeg,image/webp" />
        <span class="sig-file-btn">Choose image</span>
        <span class="sig-file-name" id="sig-file-name">No file chosen</span>
      </label>
      <div id="sig-upload-preview" class="sig-upload-preview sig-transparent-bg hidden"></div>
    </div>
    <div id="sig-panel-saved" class="sig-panel hidden">
      <div id="sig-saved-list" class="sig-saved-list"></div>
    </div>
    <div class="sig-footer-fields">
      <label class="sig-save-label"><input type="checkbox" id="sig-save-preset" checked /> Save to my signatures</label>
      <input class="form-input sig-preset-input" id="sig-preset-name" placeholder="Signature name (optional)" />
    </div>
  `;

  let pad = null;
  let uploadDataUrl = null;
  let pickedFromSaved = null;

  return showModal({
    title: "Create Signature",
    bodyHtml,
    confirmLabel: "Use Signature",
    modalClass: "sig-modal",
    onMount: (root) => {
      wireTabs(root);
      const canvas = root.querySelector("#sig-draw-canvas");
      pad = new SignaturePad(canvas, {
        backgroundColor: "rgba(0,0,0,0)",
        penColor: "#111827",
      });

      root.querySelector("#sig-draw-clear")?.addEventListener("click", () => pad.clear());

      const typeInput = root.querySelector("#sig-type-input");
      const typePreview = root.querySelector("#sig-type-preview");
      const refreshTypePreview = () => {
        const text = typeInput.value.trim();
        const ctx = typePreview.getContext("2d");
        ctx.clearRect(0, 0, typePreview.width, typePreview.height);
        if (!text) return;
        ctx.font = '64px "Dancing Script", "Segoe Script", cursive';
        ctx.fillStyle = "#111827";
        ctx.textBaseline = "middle";
        ctx.fillText(text, 16, typePreview.height / 2);
      };
      typeInput?.addEventListener("input", refreshTypePreview);

      root.querySelector("#sig-upload-input")?.addEventListener("change", async (e) => {
        const file = e.target.files?.[0];
        const nameEl = root.querySelector("#sig-file-name");
        if (!file) {
          if (nameEl) nameEl.textContent = "No file chosen";
          return;
        }
        if (nameEl) nameEl.textContent = file.name;
        const reader = new FileReader();
        reader.onload = async () => {
          uploadDataUrl = await ensureTransparentDataUrl(reader.result);
          const prev = root.querySelector("#sig-upload-preview");
          prev.classList.remove("hidden");
          prev.innerHTML = `<img src="${uploadDataUrl}" alt="Upload preview" />`;
        };
        reader.readAsDataURL(file);
      });

      renderSavedList(root, (dataUrl) => {
        pickedFromSaved = dataUrl;
        showToast("Signature selected — click Use Signature", "info");
      });
    },
    onConfirm: async (root) => {
      const activeTab = root.querySelector(".sig-tab.active")?.dataset.sigTab;
      let dataUrl = pickedFromSaved;

      if (!dataUrl) {
        if (activeTab === "draw") {
          if (!pad || pad.isEmpty()) {
            showToast("Draw your signature first.", "error");
            return false;
          }
          dataUrl = pad.toDataURL("image/png");
        } else if (activeTab === "type") {
          const text = root.querySelector("#sig-type-input")?.value?.trim();
          if (!text) {
            showToast("Enter your name to sign.", "error");
            return false;
          }
          dataUrl = renderTypedSignature(text);
        } else if (activeTab === "upload") {
          if (!uploadDataUrl) {
            showToast("Upload a signature image.", "error");
            return false;
          }
          dataUrl = uploadDataUrl;
        } else if (activeTab === "saved") {
          showToast("Select a saved signature.", "error");
          return false;
        }
      }

      dataUrl = await ensureTransparentDataUrl(dataUrl);

      if (root.querySelector("#sig-save-preset")?.checked && !pickedFromSaved) {
        const name =
          root.querySelector("#sig-preset-name")?.value?.trim() ||
          `Signature ${new Date().toLocaleDateString()}`;
        saveSignaturePreset({
          id: uid(),
          name,
          dataUrl,
          createdAt: Date.now(),
        });
      }

      pickedFromSaved = null;
      return dataUrl;
    },
  });
}

export class SignaturePlacer {
  constructor(viewer) {
    this.viewer = viewer;
    this.active = false;
    this.placing = false;
    this.placementDataUrl = null;
    this.lastDataUrl = null;
    this.placements = [];
    this._drag = null;
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    this._handlePlaceClick = this._handlePlaceClick.bind(this);
  }

  isActive() {
    return this.active;
  }

  _setBarLabel(text) {
    const el = document.getElementById("sign-bar-label");
    if (el) el.textContent = text;
  }

  _teardownPlacementMode() {
    this.placing = false;
    this.placementDataUrl = null;
    this.viewer.container.classList.remove("sig-place-mode");
    this.viewer.container.removeEventListener("click", this._handlePlaceClick, true);
  }

  startPlacement(dataUrl) {
    this._teardownPlacementMode();
    this.active = true;
    this.placing = true;
    this.placementDataUrl = dataUrl;
    this.lastDataUrl = dataUrl;
    document.getElementById("sign-bar")?.classList.remove("hidden");
    this.viewer.container.classList.add("sig-place-mode");
    this._setBarLabel("Click on the page where you want your signature");
    this.viewer.container.addEventListener("click", this._handlePlaceClick, true);
  }

  enable(dataUrl) {
    this.startPlacement(dataUrl);
  }

  _handlePlaceClick(e) {
    if (!this.placing || !this.placementDataUrl) return;
    if (e.target.closest(".sig-overlay") || e.target.closest(".sig-resize-handle")) return;

    const pageWrap = e.target.closest(".page-wrap");
    if (!pageWrap) return;

    const pageIndex = parseInt(pageWrap.dataset.page, 10);
    const img = pageWrap.querySelector("img");
    if (!img || Number.isNaN(pageIndex)) return;

    e.preventDefault();
    e.stopPropagation();

    const rect = img.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    this.addToPage(pageIndex, this.placementDataUrl, { centerX: clickX, centerY: clickY });
    this.placing = false;
    this.placementDataUrl = null;
    this.viewer.container.classList.remove("sig-place-mode");
    this._setBarLabel("Drag to adjust · Add another or save");
  }

  disable() {
    this._teardownPlacementMode();
    this.active = false;
    document.getElementById("sign-bar")?.classList.add("hidden");
    for (const p of this.placements) p.el.remove();
    this.placements = [];
    this._endDrag();
  }

  placeAnother() {
    if (this.lastDataUrl) this.startPlacement(this.lastDataUrl);
  }

  addToPage(pageIndex, dataUrl, { centerX, centerY } = {}) {
    const page = this.viewer.pageEls[pageIndex];
    if (!page?.wrap || !page.img) return;

    const el = document.createElement("div");
    el.className = "sig-overlay";
    const img = document.createElement("img");
    img.src = dataUrl;
    img.draggable = false;
    el.appendChild(img);

    const handle = document.createElement("div");
    handle.className = "sig-resize-handle";
    el.appendChild(handle);

    const imgW = page.img.offsetWidth;
    const imgH = page.img.offsetHeight;
    const w = Math.min(180, imgW * 0.35);
    const h = w * 0.4;

    let x = (imgW - w) / 2;
    let y = imgH - h - 48;
    if (centerX != null && centerY != null) {
      x = centerX - w / 2;
      y = centerY - h / 2;
      x = Math.max(0, Math.min(x, imgW - w));
      y = Math.max(0, Math.min(y, imgH - h));
    }

    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;

    el.addEventListener("mousedown", (e) => this._startDrag(e, el, pageIndex, "move"));
    handle.addEventListener("mousedown", (e) => this._startDrag(e, el, pageIndex, "resize"));
    el.addEventListener("touchstart", (e) => this._startDrag(e, el, pageIndex, "move"), { passive: false });
    handle.addEventListener("touchstart", (e) => this._startDrag(e, el, pageIndex, "resize"), { passive: false });

    page.wrap.appendChild(el);
    this.placements.push({ page: pageIndex, el, dataUrl, wrap: page.wrap, img: page.img });
    el.classList.add("selected");
    this.placements.forEach((p) => p.el.classList.toggle("selected", p.el === el));
    el.addEventListener("mousedown", () => {
      this.placements.forEach((p) => p.el.classList.toggle("selected", p.el === el));
    });
  }

  _pointer(e) {
    if (e.touches?.length) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  }

  _startDrag(e, el, pageIndex, mode) {
    e.preventDefault();
    e.stopPropagation();
    const p = this._pointer(e);
    const rect = el.getBoundingClientRect();
    const wrapRect = this.viewer.pageEls[pageIndex].wrap.getBoundingClientRect();
    this._drag = {
      el,
      pageIndex,
      mode,
      startX: p.x,
      startY: p.y,
      origLeft: parseFloat(el.style.left),
      origTop: parseFloat(el.style.top),
      origW: parseFloat(el.style.width),
      origH: parseFloat(el.style.height),
      wrapRect,
    };
    document.addEventListener("mousemove", this._onMove);
    document.addEventListener("mouseup", this._onUp);
    document.addEventListener("touchmove", this._onMove, { passive: false });
    document.addEventListener("touchend", this._onUp);
  }

  _onMove(e) {
    if (!this._drag) return;
    e.preventDefault();
    const p = this._pointer(e);
    const dx = p.x - this._drag.startX;
    const dy = p.y - this._drag.startY;
    const { el, mode, origLeft, origTop, origW, origH, wrapRect } = this._drag;
    const page = this.viewer.pageEls[this._drag.pageIndex];
    const maxW = page.img.offsetWidth;
    const maxH = page.img.offsetHeight;

    if (mode === "move") {
      let left = origLeft + dx;
      let top = origTop + dy;
      const w = parseFloat(el.style.width);
      const h = parseFloat(el.style.height);
      left = Math.max(0, Math.min(left, maxW - w));
      top = Math.max(0, Math.min(top, maxH - h));
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    } else {
      let w = Math.max(40, origW + dx);
      let h = Math.max(20, origH + dy);
      w = Math.min(w, maxW - origLeft);
      h = Math.min(h, maxH - origTop);
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    }
  }

  _onUp() {
    this._endDrag();
  }

  _endDrag() {
    document.removeEventListener("mousemove", this._onMove);
    document.removeEventListener("mouseup", this._onUp);
    document.removeEventListener("touchmove", this._onMove);
    document.removeEventListener("touchend", this._onUp);
    this._drag = null;
  }

  hasPlacements() {
    return this.placements.length > 0;
  }

  async embedAndSave(pdfPath, outPath) {
    const buf = await window.pdfApi.readFile(pdfPath);
    const pdfDoc = await PDFDocument.load(buf);
    const pages = pdfDoc.getPages();

    for (const placement of this.placements) {
      const { page, el, dataUrl } = placement;
      if (page >= pages.length) continue;

      const pageEl = this.viewer.pageEls[page];
      const img = pageEl?.img;
      if (!img) continue;

      const pdfPage = pages[page];
      const { width: pdfW, height: pdfH } = pdfPage.getSize();
      const imgW = img.offsetWidth;
      const imgH = img.offsetHeight;

      const left = parseFloat(el.style.left);
      const top = parseFloat(el.style.top);
      const w = parseFloat(el.style.width);
      const h = parseFloat(el.style.height);

      const x = (left / imgW) * pdfW;
      const width = (w / imgW) * pdfW;
      const height = (h / imgH) * pdfH;
      const y = pdfH - ((top + h) / imgH) * pdfH;

      const bytes = dataUrlToBytes(dataUrl);
      const isJpeg = dataUrl.startsWith("data:image/jpeg") || dataUrl.startsWith("data:image/jpg");
      const image = isJpeg ? await pdfDoc.embedJpg(bytes) : await pdfDoc.embedPng(bytes);

      pdfPage.drawImage(image, { x, y, width, height });
    }

    const saved = await pdfDoc.save();
    await window.pdfApi.writeFile(outPath, saved);
    return true;
  }
}

export function showComingSoon(feature) {
  return showModal({
    title: "Coming Soon",
    bodyHtml: `
      <div class="coming-soon-body">
        <span class="coming-soon-icon">${svgIcon("bell", 32)}</span>
        <p><strong>${feature}</strong> is on the way.</p>
        <p class="form-desc">We're still building this feature — check back in a future update.</p>
      </div>`,
    confirmLabel: "Got it",
    onConfirm: () => true,
  });
}
