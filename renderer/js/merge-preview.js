import { mountIcons, svgIcon } from "./icons.js";
import { showModal } from "./modals.js";

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getOrderedPaths(listEl) {
  return [...listEl.querySelectorAll(".merge-item")].map((el) => el.dataset.path);
}

function updateOrderBadges(listEl) {
  listEl.querySelectorAll(".merge-item").forEach((el, i) => {
    const badge = el.querySelector(".merge-order");
    if (badge) badge.textContent = i + 1;
  });
}

function updateSummary(body, listEl) {
  const summary = body.querySelector("#merge-summary");
  if (!summary) return;
  const items = listEl.querySelectorAll(".merge-item");
  let pages = 0;
  items.forEach((el) => {
    pages += parseInt(el.dataset.pages || "0", 10);
  });
  summary.textContent = `${items.length} file${items.length !== 1 ? "s" : ""} · ${pages} total pages`;
}

function setupDragReorder(listEl, body) {
  let dragEl = null;

  const getAfter = (y) => {
    const items = [...listEl.querySelectorAll(".merge-item:not(.dragging)")];
    return items.reduce(
      (closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
          return { offset, element: child };
        }
        return closest;
      },
      { offset: Number.NEGATIVE_INFINITY, element: null }
    ).element;
  };

  listEl.querySelectorAll(".merge-item").forEach((item) => {
    const handle = item.querySelector(".merge-drag");
    if (!handle) return;

    handle.addEventListener("mousedown", () => {
      item.draggable = true;
    });

    item.addEventListener("dragstart", (e) => {
      dragEl = item;
      item.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", item.dataset.path);
    });

    item.addEventListener("dragend", () => {
      item.classList.remove("dragging");
      item.draggable = false;
      dragEl = null;
      updateOrderBadges(listEl);
      updateSummary(body, listEl);
    });

    item.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!dragEl || dragEl === item) return;
      const after = getAfter(e.clientY);
      if (after == null) listEl.appendChild(dragEl);
      else listEl.insertBefore(dragEl, after);
    });
  });
}

function wireMoveButtons(listEl, body, showToast) {
  listEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-merge-action]");
    if (!btn) return;
    const item = btn.closest(".merge-item");
    if (!item) return;

    const action = btn.dataset.mergeAction;
    if (action === "remove") {
      if (listEl.querySelectorAll(".merge-item").length <= 2) {
        showToast?.("Keep at least 2 files to merge.", "error");
        return;
      }
      item.classList.add("merge-item-exit");
      setTimeout(() => {
        item.remove();
        updateOrderBadges(listEl);
        updateSummary(body, listEl);
        setupDragReorder(listEl, body);
      }, 200);
      return;
    }

    if (action === "up") {
      const prev = item.previousElementSibling;
      if (prev) listEl.insertBefore(item, prev);
    }
    if (action === "down") {
      const next = item.nextElementSibling;
      if (next) listEl.insertBefore(next, item);
    }
    updateOrderBadges(listEl);
    updateSummary(body, listEl);
  });
}

async function buildMergeItem(path, index) {
  const name = await window.pdfApi.basename(path);
  const item = document.createElement("div");
  item.className = "merge-item loading";
  item.dataset.path = path;
  item.dataset.pages = "0";
  item.innerHTML = `
    <div class="merge-drag" title="Drag to reorder">
      <span data-icon="gripVertical" data-icon-size="16"></span>
    </div>
    <span class="merge-order">${index + 1}</span>
    <div class="merge-thumb">
      <div class="merge-thumb-skeleton"></div>
    </div>
    <div class="merge-meta">
      <span class="merge-name" title="${name}">${name}</span>
      <span class="merge-details">Loading preview…</span>
    </div>
    <div class="merge-actions">
      <button type="button" class="merge-action-btn" data-merge-action="up" title="Move up">
        <span data-icon="arrowUp" data-icon-size="14"></span>
      </button>
      <button type="button" class="merge-action-btn" data-merge-action="down" title="Move down">
        <span data-icon="arrowDown" data-icon-size="14"></span>
      </button>
      <button type="button" class="merge-action-btn danger" data-merge-action="remove" title="Remove">
        <span data-icon="trash2" data-icon-size="14"></span>
      </button>
    </div>
  `;

  mountIcons(item);

  try {
    const [preview, stat] = await Promise.all([
      window.pdfApi.runOp({ op: "pdf_preview", path, dpi: 96 }),
      window.pdfApi.stat(path),
    ]);

    item.dataset.pages = String(preview.pages || 0);
    const thumb = item.querySelector(".merge-thumb");
    const details = item.querySelector(".merge-details");

    if (preview.ok && preview.image) {
      thumb.innerHTML = `<img src="data:image/png;base64,${preview.image}" alt="" />`;
    } else {
      thumb.innerHTML = `<div class="merge-thumb-fallback">${svgIcon("fileText", 32)}</div>`;
    }

    details.textContent = `${preview.pages || 0} page${preview.pages !== 1 ? "s" : ""} · ${formatSize(stat.size)}`;
    item.classList.remove("loading");
  } catch {
    item.querySelector(".merge-details").textContent = "Preview unavailable";
    item.classList.remove("loading");
  }

  return item;
}

async function renderMergeList(body, paths, showToast) {
  const listEl = body.querySelector("#merge-list");
  listEl.innerHTML = "";

  const placeholders = paths.map((path, i) => {
    const div = document.createElement("div");
    div.className = "merge-item loading merge-item-enter";
    div.dataset.path = path;
    div.innerHTML = `
      <div class="merge-drag"><span data-icon="gripVertical" data-icon-size="16"></span></div>
      <span class="merge-order">${i + 1}</span>
      <div class="merge-thumb"><div class="merge-thumb-skeleton"></div></div>
      <div class="merge-meta">
        <span class="merge-name">…</span>
        <span class="merge-details">Loading…</span>
      </div>
      <div class="merge-actions"></div>
    `;
    listEl.appendChild(div);
    return { path, el: div };
  });

  mountIcons(listEl);
  updateSummary(body, listEl);

  await Promise.all(
    placeholders.map(async ({ path, el }, i) => {
      const built = await buildMergeItem(path, i);
      built.classList.add("merge-item-enter");
      el.replaceWith(built);
    })
  );

  setupDragReorder(listEl, body);
  wireMoveButtons(listEl, body, showToast);
  updateOrderBadges(listEl);
  updateSummary(body, listEl);
}

export async function showMergePreview(initialPaths, { showToast } = {}) {
  let paths = [...initialPaths];

  const result = await showModal({
    title: "Merge PDFs",
    modalClass: "modal-lg",
    confirmLabel: "Merge PDFs",
    bodyHtml: `
      <p class="form-desc">Preview your files and drag to set the merge order. Files are combined from top to bottom.</p>
      <div id="merge-summary" class="merge-summary">Loading…</div>
      <div id="merge-list" class="merge-list"></div>
      <button type="button" class="merge-add-btn" id="merge-add-files">
        <span data-icon="plus" data-icon-size="16"></span>
        Add more files
      </button>
    `,
    onMount: async (body) => {
      await renderMergeList(body, paths, showToast);

      body.querySelector("#merge-add-files").addEventListener("click", async () => {
        const added = await window.pdfApi.openPdfs();
        const listEl = body.querySelector("#merge-list");
        const existing = new Set(getOrderedPaths(listEl));
        const newPaths = added.filter((p) => !existing.has(p));
        if (!newPaths.length) return;

        const startIdx = listEl.querySelectorAll(".merge-item").length;
        for (let i = 0; i < newPaths.length; i++) {
          const item = await buildMergeItem(newPaths[i], startIdx + i);
          item.classList.add("merge-item-enter");
          listEl.appendChild(item);
        }
        setupDragReorder(listEl, body);
        updateOrderBadges(listEl);
        updateSummary(body, listEl);
      });
    },
    onConfirm: (body) => {
      const ordered = getOrderedPaths(body.querySelector("#merge-list"));
      if (ordered.length < 2) {
        showToast?.("Need at least 2 PDFs to merge.", "error");
        return false;
      }
      return ordered;
    },
  });

  return result;
}
