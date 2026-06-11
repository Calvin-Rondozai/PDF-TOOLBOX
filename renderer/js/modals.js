import { mountIcons, svgIcon } from "./icons.js";

export function showConfirm({
  title = "Confirm",
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  icon = "alertCircle",
}) {
  return showModal({
    title,
    modalClass: `confirm-modal${danger ? " confirm-danger" : ""}`,
    confirmLabel,
    bodyHtml: `
      <div class="confirm-body">
        <span class="confirm-icon${danger ? " danger" : ""}">${svgIcon(icon, 28)}</span>
        <p class="confirm-message">${message}</p>
      </div>`,
    onMount: (body) => {
      const cancelBtn = document.getElementById("modal-cancel");
      if (cancelBtn) cancelBtn.textContent = cancelLabel;
    },
    onConfirm: () => true,
  });
}

export function showModal({ title, bodyHtml, onConfirm, onMount, confirmLabel = "Apply", modalClass = "" }) {
  const overlay = document.getElementById("modal-overlay");
  const modal = document.getElementById("modal");
  const modalTitle = document.getElementById("modal-title");
  const modalBody = document.getElementById("modal-body");
  const confirmBtn = document.getElementById("modal-confirm");
  const cancelBtn = document.getElementById("modal-cancel");
  const closeBtn = document.getElementById("modal-close");

  modal.className = `modal animate-modal${modalClass ? ` ${modalClass}` : ""}`;
  modalTitle.textContent = title;
  modalBody.innerHTML = bodyHtml;
  confirmBtn.textContent = confirmLabel;
  overlay.classList.remove("hidden");
  mountIcons(overlay);
  if (onMount) onMount(modalBody);

  return new Promise((resolve) => {
    const cleanup = () => {
      overlay.classList.add("hidden");
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
      closeBtn.onclick = null;
      cancelBtn.textContent = "Cancel";
    };

    const finish = (result) => {
      cleanup();
      resolve(result);
    };

    confirmBtn.onclick = async () => {
      if (onConfirm) {
        const r = await onConfirm(modalBody);
        if (r !== false) finish(r);
      } else {
        finish(true);
      }
    };
    cancelBtn.onclick = () => finish(null);
    closeBtn.onclick = () => finish(null);
  });
}

export function toolsModalHtml() {
  return `
    <div class="tab-row" id="tools-tabs">
      <button class="tab-btn active" data-tab="kb">Target Size</button>
      <button class="tab-btn" data-tab="dim">Page Size</button>
      <button class="tab-btn" data-tab="std">Compress</button>
    </div>
    <div id="tab-kb" class="tab-panel">
      <p class="form-desc">Compress until the file is at or below your target size.</p>
      <div class="form-row">
        <label>Target</label>
        <input class="form-input" id="kb-val" value="200" />
        <label><input type="radio" name="kb-unit" value="kb" checked /> KB</label>
        <label><input type="radio" name="kb-unit" value="mb" /> MB</label>
      </div>
      <div class="chip-row">
        <button class="chip" data-kb="100">100 KB</button>
        <button class="chip" data-kb="200">200 KB</button>
        <button class="chip" data-kb="500">500 KB</button>
        <button class="chip" data-kb="1" data-unit="mb">1 MB</button>
      </div>
    </div>
    <div id="tab-dim" class="tab-panel hidden">
      <p class="form-desc">Resize every page. Content is scaled to fit, centred.</p>
      <div class="form-row">
        <label>Width</label><input class="form-input" id="dim-w" value="210" />
        <label>Height</label><input class="form-input" id="dim-h" value="297" />
        <label>mm</label>
      </div>
      <div class="chip-row">
        <button class="chip" data-w="210" data-h="297">A4</button>
        <button class="chip" data-w="297" data-h="420">A3</button>
        <button class="chip" data-w="216" data-h="279">Letter</button>
        <button class="chip" data-w="148" data-h="210">A5</button>
      </div>
    </div>
    <div id="tab-std" class="tab-panel hidden">
      <p class="form-desc">Reduce file size without targeting an exact number.</p>
      <div class="radio-group">
        <label class="radio-opt"><input type="radio" name="std-level" value="light" /> Light — deflate only</label>
        <label class="radio-opt"><input type="radio" name="std-level" value="balanced" checked /> Balanced — 120 DPI (recommended)</label>
        <label class="radio-opt"><input type="radio" name="std-level" value="aggressive" /> Aggressive — 72 DPI</label>
      </div>
    </div>
  `;
}

export function fileOpsModalHtml(pageCount) {
  return `
    <div class="tab-row" id="ops-tabs">
      <button class="tab-btn active" data-tab="split">Split</button>
      <button class="tab-btn" data-tab="extract">Extract</button>
      <button class="tab-btn" data-tab="rotate">Rotate</button>
      <button class="tab-btn" data-tab="watermark">Watermark</button>
      <button class="tab-btn" data-tab="password">Password</button>
    </div>
    <div id="tab-split" class="tab-panel">
      <p class="form-desc">Split into individual pages — one PDF file per page.</p>
    </div>
    <div id="tab-extract" class="tab-panel hidden">
      <p class="form-desc">Extract a page range into a new PDF (pages 1–${pageCount}).</p>
      <div class="form-row">
        <label>From</label><input class="form-input" id="ext-from" value="1" />
        <label>To</label><input class="form-input" id="ext-to" value="${pageCount}" />
      </div>
    </div>
    <div id="tab-rotate" class="tab-panel hidden">
      <p class="form-desc">Rotate pages clockwise.</p>
      <div class="form-row">
        <label>Degrees</label>
        <select class="form-input" id="rot-deg" style="width:120px">
          <option value="90">90°</option>
          <option value="180">180°</option>
          <option value="270">270°</option>
        </select>
      </div>
      <div class="form-row">
        <label>Pages</label>
        <label class="radio-opt"><input type="radio" name="rot-scope" value="all" checked /> All pages</label>
        <label class="radio-opt"><input type="radio" name="rot-scope" value="range" /> Range</label>
      </div>
      <div class="form-row hidden" id="rot-range-row">
        <label>From</label><input class="form-input" id="rot-from" value="1" />
        <label>To</label><input class="form-input" id="rot-to" value="${pageCount}" />
      </div>
    </div>
    <div id="tab-watermark" class="tab-panel hidden">
      <p class="form-desc">Add a diagonal watermark to every page.</p>
      <div class="form-row">
        <label>Text</label><input class="form-input" id="wm-text" value="CONFIDENTIAL" style="width:200px" />
      </div>
      <div class="form-row">
        <label>Opacity</label>
        <input type="range" id="wm-opacity" min="10" max="80" value="25" style="flex:1" />
        <span id="wm-op-lbl">25%</span>
      </div>
      <div class="chip-row">
        <button class="chip" data-wm="CONFIDENTIAL">CONFIDENTIAL</button>
        <button class="chip" data-wm="DRAFT">DRAFT</button>
        <button class="chip" data-wm="SAMPLE">SAMPLE</button>
      </div>
    </div>
    <div id="tab-password" class="tab-panel hidden">
      <p class="form-desc">Encrypt with AES-256 password protection.</p>
      <div class="form-row">
        <label>Password</label><input class="form-input" id="pw-user" type="password" style="width:180px" />
      </div>
      <div class="form-row">
        <label>Confirm</label><input class="form-input" id="pw-confirm" type="password" style="width:180px" />
      </div>
    </div>
  `;
}

export function wireTabs(container, prefix) {
  const tabs = container.querySelectorAll(".tab-btn");
  tabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");
      container.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
      const panel = container.querySelector(`#tab-${btn.dataset.tab}`);
      if (panel) panel.classList.remove("hidden");
    });
  });
}

export function getActiveTab(container) {
  const active = container.querySelector(".tab-btn.active");
  return active ? active.dataset.tab : null;
}
