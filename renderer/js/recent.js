import { mountIcons } from "./icons.js";
import { showConfirm } from "./modals.js";

const KEY = "hello-c-recent";
const VIEW_KEY = "hello-c-recent-view";
const MAX = 12;

export function loadRecent() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

export function getRecentViewMode() {
  return localStorage.getItem(VIEW_KEY) || "list";
}

export function setRecentViewMode(mode) {
  localStorage.setItem(VIEW_KEY, mode);
}

function saveRecent(list) {
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
}

function dirFromPath(filePath) {
  const i = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return i > 0 ? filePath.slice(0, i) : filePath;
}

function shortenPath(filePath, maxLen = 32) {
  if (!filePath || filePath.length <= maxLen) return filePath;
  const sep = filePath.includes("\\") ? "\\" : "/";
  const parts = filePath.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return `…${filePath.slice(-maxLen + 1)}`;
  const tail = parts[parts.length - 1];
  const parent = parts[parts.length - 2];
  const short = `${parent}${sep}${tail}`;
  if (short.length <= maxLen) return short;
  return `…${sep}${parent}${sep}${tail}`.slice(-maxLen);
}

function formatOpenedAt(ts) {
  if (!ts) return "Unknown";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

export function addRecent(filePath, name, pages, sizeKb, dir) {
  const list = loadRecent().filter((r) => r.path !== filePath);
  list.unshift({
    path: filePath,
    name,
    pages,
    sizeKb,
    at: Date.now(),
    dir: dir || dirFromPath(filePath),
  });
  saveRecent(list);
  const query = document.getElementById("top-search")?.value || "";
  renderRecentList(undefined, query);
}

export function clearAllRecent() {
  localStorage.removeItem(KEY);
  renderRecentList();
}

export function removeRecentPaths(paths) {
  const set = new Set(paths);
  saveRecent(loadRecent().filter((r) => !set.has(r.path)));
  renderRecentList();
}

export function renderRecentList(onOpen, query = "") {
  const container = document.getElementById("recent-list");
  if (!container) return;
  const q = query.trim().toLowerCase();
  let list = loadRecent();
  if (q) list = list.filter((item) => item.name.toLowerCase().includes(q));

  const openHandler = onOpen || container._onOpen || (() => {});
  const viewMode = getRecentViewMode();
  const selectMode = container._selectMode || false;
  const selected = container._selected || new Set();

  container.className = `recent-list recent-${viewMode}${selectMode ? " selecting" : ""}`;

  if (!list.length) {
    container.innerHTML = q
      ? `<p class="recent-empty">No recent files match "${query}"</p>`
      : `<p class="recent-empty">No recent files yet</p>`;
    return;
  }

  container.innerHTML = "";
  list.forEach((item) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `recent-item${selected.has(item.path) ? " selected" : ""}`;
    row.dataset.path = item.path;
    const folder = item.dir || dirFromPath(item.path);
    const folderDisplay = viewMode === "grid" ? shortenPath(folder, 36) : folder;
    const opened = formatOpenedAt(item.at);
    row.innerHTML = `
      ${selectMode ? `<input type="checkbox" class="recent-check" ${selected.has(item.path) ? "checked" : ""} />` : ""}
      <span class="recent-info">
        <span class="recent-name" title="${item.name}">${item.name}</span>
        <span class="recent-meta">${opened} · ${item.pages} pg · ${item.sizeKb} KB</span>
        <span class="recent-dir" title="${folder}">${folderDisplay}</span>
      </span>
    `;
    row.addEventListener("click", (e) => {
      if (selectMode) {
        e.preventDefault();
        if (selected.has(item.path)) selected.delete(item.path);
        else selected.add(item.path);
        container._selected = selected;
        renderRecentList(onOpen, query);
        return;
      }
      openHandler(item.path);
    });
    container.appendChild(row);
  });
}

export function setRecentOpenHandler(fn) {
  const container = document.getElementById("recent-list");
  if (container) container._onOpen = fn;
}

export function initRecentToolbar({ onOpen, showToast }) {
  const toolbar = document.getElementById("recent-toolbar");
  if (!toolbar || toolbar.dataset.wired) return;
  toolbar.dataset.wired = "1";

  const refreshBtns = () => {
    const mode = getRecentViewMode();
    toolbar.querySelector('[data-view="list"]')?.classList.toggle("active", mode === "list");
    toolbar.querySelector('[data-view="grid"]')?.classList.toggle("active", mode === "grid");
    const container = document.getElementById("recent-list");
    const selecting = container?._selectMode;
    toolbar.querySelector("#btn-recent-select")?.classList.toggle("active", selecting);
    toolbar.querySelector("#btn-recent-clear-sel")?.classList.toggle("hidden", !selecting);
  };

  toolbar.querySelector('[data-view="list"]')?.addEventListener("click", () => {
    setRecentViewMode("list");
    refreshBtns();
    renderRecentList(onOpen, document.getElementById("top-search")?.value || "");
  });
  toolbar.querySelector('[data-view="grid"]')?.addEventListener("click", () => {
    setRecentViewMode("grid");
    refreshBtns();
    renderRecentList(onOpen, document.getElementById("top-search")?.value || "");
  });

  toolbar.querySelector("#btn-recent-select")?.addEventListener("click", () => {
    const container = document.getElementById("recent-list");
    container._selectMode = !container._selectMode;
    if (!container._selectMode) container._selected = new Set();
    refreshBtns();
    renderRecentList(onOpen, document.getElementById("top-search")?.value || "");
  });

  toolbar.querySelector("#btn-recent-clear-all")?.addEventListener("click", async () => {
    if (!loadRecent().length) return;
    const ok = await showConfirm({
      title: "Clear recent files?",
      message: "This removes all entries from your recent list. Your PDF files on disk are not deleted.",
      confirmLabel: "Clear all",
      danger: true,
      icon: "trash2",
    });
    if (!ok) return;
    clearAllRecent();
    showToast?.("Recent files cleared.", "success");
    refreshBtns();
  });

  toolbar.querySelector("#btn-recent-clear-sel")?.addEventListener("click", () => {
    const container = document.getElementById("recent-list");
    const selected = [...(container._selected || [])];
    if (!selected.length) {
      showToast?.("Select files to remove.", "info");
      return;
    }
    removeRecentPaths(selected);
    container._selected = new Set();
    container._selectMode = false;
    showToast?.(`Removed ${selected.length} file(s) from recent.`, "success");
    refreshBtns();
    renderRecentList(onOpen, document.getElementById("top-search")?.value || "");
  });

  refreshBtns();
  mountIcons(toolbar);
}
