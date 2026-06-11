import { PdfViewer } from "./viewer.js";
import { TtsReader } from "./tts.js";
import { mountIcons, svgIcon } from "./icons.js";
import { SignaturePlacer, showSignaturePicker, showComingSoon } from "./signature.js";
import {
  initSettings,
  loadSettings,
  mountSettingsView,
  setSidebarCollapsed,
  isSidebarCollapsed,
} from "./settings.js";
import { buildHomeGrid, refreshHomeGrid, NEEDS_DOC_ACTIONS } from "./home.js";
import { playNotificationSound } from "./sounds.js";
import { addRecent, renderRecentList, setRecentOpenHandler, initRecentToolbar } from "./recent.js";
import { showPageManager } from "./page-manager.js";
import { showConvertModal } from "./convert.js";
import {
  showModal,
  toolsModalHtml,
  fileOpsModalHtml,
  wireTabs,
  getActiveTab,
} from "./modals.js";
import { showMergePreview } from "./merge-preview.js";
import { mountAiView } from "./ai.js";

const state = { path: null, pageCount: 0, baseName: "" };
const viewer = new PdfViewer(document.getElementById("viewer"));
const signer = new SignaturePlacer(viewer);
const tts = new TtsReader();

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function setStatus(msg) {
  $("#status-text").textContent = msg;
}

function showToast(msg, type = "info") {
  const wrap = $("#toast-wrap");
  const text = $("#toast-text");
  const icon = $("#toast-icon");
  const toast = $("#toast");
  if (!wrap || !text) return;

  text.textContent = msg;
  toast.className = `toast ${type}`;
  const iconName = type === "success" ? "checkCircle" : type === "error" ? "alertCircle" : "bell";
  icon.innerHTML = svgIcon(iconName, 18);

  wrap.classList.remove("hidden");
  requestAnimationFrame(() => wrap.classList.add("show"));
  playNotificationSound();

  clearTimeout(showToast._hideT);
  clearTimeout(showToast._t);
  showToast._hideT = setTimeout(() => {
    wrap.classList.remove("show");
    showToast._t = setTimeout(() => wrap.classList.add("hidden"), 480);
  }, 3600);
}

function setProgress(show, pct = 0, msg = "", title = "Processing…") {
  const popup = $("#progress-popup");
  if (show) {
    popup.classList.remove("hidden");
    $("#progress-fill").style.width = `${pct}%`;
    $("#progress-msg").textContent = msg || "Please wait…";
    $("#progress-title").textContent = title;
  } else {
    popup.classList.add("hidden");
  }
}

let currentView = "home";

function updateTopSearch(view) {
  const input = $("#top-search");
  if (!input) return;
  if (view === "home") {
    input.placeholder = "Search recent files…";
    input.disabled = false;
    renderRecentList((path) => openPdf(path), input.value);
  } else if (view === "document") {
    input.placeholder = "Search in document…";
    input.disabled = !state.path;
  } else {
    input.placeholder = "Search…";
    input.disabled = true;
    input.value = "";
  }
}

function showView(name) {
  currentView = name;
  $("#view-home").classList.toggle("hidden", name !== "home");
  $("#view-document").classList.toggle("hidden", name !== "document");
  $("#view-settings").classList.toggle("hidden", name !== "settings");
  $("#view-ai").classList.toggle("hidden", name !== "ai");
  const fullPage = name === "settings" || name === "ai";
  document.querySelector(".topbar")?.classList.toggle("hidden", fullPage);
  document.querySelector(".main-shell")?.classList.toggle("settings-active", fullPage);
  updateTopSearch(name);
}

function setActiveNav(nav) {
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.nav === nav));
}

function enableDocActions(enabled) {
  $$(
    '[data-action="tools"], [data-action="fileops"], [data-action="pages"], [data-action="sign"], [data-action="read"], [data-action="save-audio"]'
  ).forEach((b) => {
    b.disabled = false;
    b.classList.toggle("nav-needs-doc", !enabled);
  });
  refreshHomeGrid();
  $("#fab-read")?.classList.toggle("hidden", !enabled);
}

async function runAction(action) {
  if (NEEDS_DOC_ACTIONS.has(action) && !state.path) {
    await promptOpenPdf(action);
    return;
  }
  await handlers[action]?.();
}

function updatePageUI(pageIndex) {
  $("#page-input").value = pageIndex + 1;
  $("#page-total").textContent = state.pageCount;
  viewer.currentPage = pageIndex;
}

async function openPdf(filePath, { scrollToPage: scrollTarget } = {}) {
  if (!filePath) return;
  setProgress(true, 0, "Reading document…", "Opening PDF");
  setStatus("Loading PDF…");
  try {
    state.path = filePath;
    state.baseName = (await window.pdfApi.basename(filePath)).replace(/\.pdf$/i, "");
    const count = await viewer.loadFromPath(filePath);
    state.pageCount = count;

    const stat = await window.pdfApi.stat(filePath);
    const name = stat.name.replace(/\.pdf$/i, "");
    const sizeKb = (stat.size / 1024).toFixed(1);
    $("#doc-title").textContent = name;
    $("#doc-meta").textContent = `${count} pages · ${sizeKb} KB`;
    $("#page-total").textContent = count;
    $("#page-input").value = "1";
    $("#zoom-label").textContent = "100%";
    viewer.zoom = 1.0;
    $("#top-search").disabled = false;

    const dir = await window.pdfApi.dirname(filePath);
    addRecent(filePath, stat.name, count, sizeKb, dir);

    showView("document");
    setActiveNav("viewer");
    $("#viewer").classList.remove("hidden");
    enableDocActions(true);
    signer.disable();

    if (scrollTarget != null && scrollTarget >= 0 && scrollTarget < count) {
      await viewer.renderVisiblePages();
      viewer.scrollToPage(scrollTarget);
      updatePageUI(scrollTarget);
    }

    setStatus(`Opened ${stat.name}`);
    showToast(`Opened ${stat.name}`, "success");
  } catch (e) {
    showToast(`Failed to open: ${e.message}`, "error");
    setStatus("Open failed.");
  } finally {
    setProgress(false);
  }
}

async function runOp(payload, title = "Processing…") {
  progressTitle = title;
  setProgress(true, 0, "Starting…", title);
  try {
    return await window.pdfApi.runOp(payload);
  } finally {
    setProgress(false);
    progressTitle = "Processing…";
  }
}

let progressTitle = "Processing…";
window.pdfApi.onProgress((msg) => {
  const pct = msg.max ? Math.round((msg.val / msg.max) * 100) : 0;
  setProgress(true, pct, msg.msg || "Please wait…", progressTitle);
});

async function checkBackend() {
  try {
    await window.pdfApi.ping();
  } catch {
    /* backend unavailable — tools will fail at runtime */
  }
}

function applyTtsFromSettings() {
  const s = loadSettings();
  const rate = s.ttsRate ?? 1.0;
  const voiceVal = s.ttsVoice || "";
  tts.setRate(rate);
  if (voiceVal && !voiceVal.startsWith("py:")) tts.setVoice(voiceVal);
  return { rate, voiceVal };
}

async function promptOpenPdf(action) {
  showToast("Open a PDF first to use this tool.", "info");
  const path = await window.pdfApi.openPdf();
  if (!path) return;
  await openPdf(path);
  handlers[action]?.();
}

function setNavLabel(btn, text) {
  const label = btn.querySelector("span:last-child");
  if (label) label.textContent = text;
}

async function startSignMode() {
  if (!state.path) return;
  showView("document");
  setActiveNav("sign");
  const dataUrl = await showSignaturePicker({ showToast });
  if (!dataUrl) return;
  signer.startPlacement(dataUrl);
  setStatus("Click on the page where you want your signature.");
}

const handlers = {
  home: () => {
    showView("home");
    setActiveNav("home");
    $("#greeting").textContent = "Welcome back";
    $("#doc-subtitle").textContent = "Choose a tool from the grid below";
    setStatus("Home");
  },

  settings: async () => {
    await mountSettingsView({
      appVersion: window.appInfo?.version || "1.0.0",
      developer: window.appInfo?.developer || "Calvin",
      showToast,
    });
    showView("settings");
    setActiveNav("settings");
    setStatus("Settings");
  },

  ai: async () => {
    await mountAiView({
      showToast,
      getOpenDocPath: () => state.path,
    });
    showView("ai");
    setActiveNav("ai");
    setStatus("Ask Chenny");
  },

  convert: async () => {
    await showConvertModal({ runOp, showToast, openPdf });
  },

  pages: async () => {
    if (!state.path) return;
    const result = await showPageManager(state.path, state.pageCount, { showToast });
    if (!result) return;
    const suffixMap = {
      reorder_pages: "_reordered",
      duplicate_pages: "_duplicated",
      rotate: "_rotated",
      rotate_map: "_rotated",
    };
    const out = await window.pdfApi.savePdf(`${state.baseName}${suffixMap[result.op] || "_pages"}.pdf`);
    if (!out) return;
    const r = await runOp({ inp: state.path, out, ...result }, "Managing pages");
    if (r.ok) {
      showToast(r.detail, "success");
      let scrollTo = null;
      if (result.op === "duplicate_pages" && result.pages?.length) {
        const first = [...result.pages].sort((a, b) => a - b)[0];
        scrollTo = first + 1;
      }
      await openPdf(out, { scrollToPage: scrollTo });
    } else {
      showToast(r.detail, "error");
    }
  },

  open: async () => {
    const path = await window.pdfApi.openPdf();
    await openPdf(path);
  },

  merge: async () => {
    let picked = await window.pdfApi.openPdfs();
    if (!picked.length) return;
    if (picked.length === 1) {
      showToast("Now pick the second PDF to merge with.", "info");
      const second = await window.pdfApi.openPdf();
      if (!second) return;
      picked = [...picked, second];
    }
    if (picked.length < 2) {
      showToast("Select at least 2 PDF files to merge.", "error");
      return;
    }
    const ordered = await showMergePreview(picked, { showToast });
    if (!ordered) return;
    const out = await window.pdfApi.savePdf("merged.pdf");
    if (!out) return;
    const r = await runOp({ op: "merge", paths: ordered, out }, "Merging PDFs");
    if (r.ok) {
      showToast(r.detail, "success");
      await openPdf(out);
    } else {
      showToast(r.detail, "error");
    }
  },

  tools: async () => {
    if (!state.path) return;
    const result = await showModal({
      title: "PDF Tools",
      bodyHtml: toolsModalHtml(),
      confirmLabel: "Process",
      onMount: (body) => {
        wireTabs(body);
        body.querySelectorAll("[data-kb]").forEach((c) => {
          c.addEventListener("click", () => {
            body.querySelector("#kb-val").value = c.dataset.kb;
            if (c.dataset.unit === "mb") body.querySelector('[name="kb-unit"][value="mb"]').checked = true;
          });
        });
        body.querySelectorAll("[data-w]").forEach((c) => {
          c.addEventListener("click", () => {
            body.querySelector("#dim-w").value = c.dataset.w;
            body.querySelector("#dim-h").value = c.dataset.h;
          });
        });
      },
      onConfirm: (body) => {
        const tab = getActiveTab(body);
        if (tab === "kb") {
          const val = parseFloat(body.querySelector("#kb-val").value);
          if (!val || val <= 0) { showToast("Enter a valid target size.", "error"); return false; }
          const unit = body.querySelector('[name="kb-unit"]:checked').value;
          return { op: "compress_kb", target_kb: unit === "mb" ? val * 1024 : val };
        }
        if (tab === "dim") {
          const w = parseFloat(body.querySelector("#dim-w").value);
          const h = parseFloat(body.querySelector("#dim-h").value);
          if (!w || !h) { showToast("Enter valid dimensions.", "error"); return false; }
          return { op: "resize", w_mm: w, h_mm: h };
        }
        return { op: "compress_std", level: body.querySelector('[name="std-level"]:checked').value };
      },
    });
    if (!result) return;
    const suffix = result.op === "resize" ? "_resized" : "_compressed";
    const out = await window.pdfApi.savePdf(`${state.baseName}${suffix}.pdf`);
    if (!out) return;
    const r = await runOp({ inp: state.path, out, ...result }, "Processing PDF");
    showToast(r.ok ? r.detail.replace(/\n/g, " · ") : r.detail, r.ok ? "success" : "error");
  },

  fileops: async () => {
    if (!state.path) return;
    const result = await showModal({
      title: "File Operations",
      bodyHtml: fileOpsModalHtml(state.pageCount),
      confirmLabel: "Apply",
      onMount: (body) => {
        wireTabs(body);
        body.querySelector("#wm-opacity")?.addEventListener("input", (e) => {
          body.querySelector("#wm-op-lbl").textContent = `${e.target.value}%`;
        });
        body.querySelectorAll("[data-wm]").forEach((c) => {
          c.addEventListener("click", () => { body.querySelector("#wm-text").value = c.dataset.wm; });
        });
        body.querySelectorAll('[name="rot-scope"]').forEach((r) => {
          r.addEventListener("change", () => {
            const isRange = body.querySelector('[name="rot-scope"][value="range"]').checked;
            body.querySelector("#rot-range-row").classList.toggle("hidden", !isRange);
          });
        });
      },
      onConfirm: (body) => {
        const tab = getActiveTab(body);
        if (tab === "split") return { op: "split_all" };
        if (tab === "extract") {
          const from = parseInt(body.querySelector("#ext-from").value, 10) - 1;
          const to = parseInt(body.querySelector("#ext-to").value, 10) - 1;
          if (from < 0 || to >= state.pageCount || from > to) {
            showToast("Invalid page range.", "error");
            return false;
          }
          return { op: "split_range", start: from, end: to };
        }
        if (tab === "rotate") {
          const deg = parseInt(body.querySelector("#rot-deg").value, 10);
          const scope = body.querySelector('[name="rot-scope"]:checked').value;
          let pages = null;
          if (scope === "range") {
            const from = parseInt(body.querySelector("#rot-from").value, 10) - 1;
            const to = parseInt(body.querySelector("#rot-to").value, 10) - 1;
            if (from < 0 || to >= state.pageCount || from > to) {
              showToast("Invalid page range.", "error");
              return false;
            }
            pages = [];
            for (let i = from; i <= to; i++) pages.push(i);
          }
          return { op: "rotate", degrees: deg, pages };
        }
        if (tab === "watermark") {
          const text = body.querySelector("#wm-text").value.trim();
          if (!text) { showToast("Enter watermark text.", "error"); return false; }
          return { op: "watermark", text, opacity: parseInt(body.querySelector("#wm-opacity").value, 10) / 100 };
        }
        if (tab === "password") {
          const pw = body.querySelector("#pw-user").value;
          const confirm = body.querySelector("#pw-confirm").value;
          if (!pw) { showToast("Enter a password.", "error"); return false; }
          if (pw !== confirm) { showToast("Passwords do not match.", "error"); return false; }
          return { op: "password", user_pw: pw };
        }
        return false;
      },
    });
    if (!result) return;

    if (result.op === "split_all") {
      const outDir = await window.pdfApi.pickFolder();
      if (!outDir) return;
      const r = await runOp({ inp: state.path, out_dir: outDir, base: state.baseName, ...result }, "Splitting PDF");
      showToast(r.detail, r.ok ? "success" : "error");
      return;
    }

    const suffixMap = {
      split_range: `_p${result.start + 1}-${result.end + 1}`,
      rotate: "_rotated",
      watermark: "_watermarked",
      password: "_protected",
    };
    const out = await window.pdfApi.savePdf(`${state.baseName}${suffixMap[result.op] || "_out"}.pdf`);
    if (!out) return;
    const r = await runOp({ inp: state.path, out, ...result }, "Processing PDF");
    showToast(r.detail, r.ok ? "success" : "error");
  },

  ocr: () => showComingSoon("OCR Scan"),

  edit: () => showComingSoon("Edit PDF"),

  sign: startSignMode,

  read: async () => {
    const btn = document.querySelector('[data-action="read"]');
    if (tts.isSpeaking) {
      tts.stop();
      setNavLabel(btn, "Read Aloud");
      btn.classList.remove("active");
      $("#fab-read")?.classList.remove("active");
      $("#tts-sentence")?.classList.add("hidden");
      return;
    }
    const { voiceVal } = applyTtsFromSettings();

    tts.onPageChange = (page) => { viewer.scrollToPage(page); updatePageUI(page); };
    tts.onSentence = (seg) => {
      const el = $("#tts-sentence");
      if (el) {
        el.textContent = seg.text;
        el.classList.remove("hidden");
      }
    };
    tts.onDone = () => {
      setNavLabel(btn, "Read Aloud");
      btn.classList.remove("active");
      $("#fab-read")?.classList.remove("active");
      $("#tts-sentence")?.classList.add("hidden");
    };

    const ok = await tts.startFromPage(
      async (page) => {
        const r = await window.pdfApi.runOp({ op: "extract_page_text", path: state.path, page });
        return r.text || "";
      },
      viewer.getPageAtScroll(),
      state.pageCount
    );
    if (!ok) { showToast("No readable text found.", "error"); return; }
    setNavLabel(btn, "Stop Reading");
    btn.classList.add("active");
    $("#fab-read")?.classList.add("active");
  },

  "save-audio": async () => {
    if (!state.path) return;
    const out = await window.pdfApi.saveAudio(`${state.baseName}.mp3`);
    if (!out) return;
    const { rate, voiceVal } = applyTtsFromSettings();
    const payload = {
      op: "save_tts",
      path: state.path,
      out,
      rate: Math.round(rate * 175),
    };
    if (voiceVal.startsWith("py:")) payload.voice_id = voiceVal.slice(3);
    const r = await runOp(payload, "Generating audio");
    showToast(r.ok ? `Audio saved` : r.detail, r.ok ? "success" : "error");
  },
};

$$(".nav-item").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const action = btn.dataset.action;
    if (!action) return;
    if ((action !== "read" || !tts.isSpeaking) && btn.dataset.nav) {
      setActiveNav(btn.dataset.nav);
    }
    await runAction(action);
  });
});

document.querySelector(".brand-logo")?.addEventListener("click", () => {
  if (!isSidebarCollapsed()) return;
  setSidebarCollapsed(false);
  const icon = $("#btn-sidebar-toggle span");
  if (icon) icon.setAttribute("data-icon", "panelLeft");
  mountIcons($("#btn-sidebar-toggle"));
});

$("#btn-sidebar-toggle")?.addEventListener("click", () => {
  const collapsed = !isSidebarCollapsed();
  setSidebarCollapsed(collapsed);
  const icon = $("#btn-sidebar-toggle span");
  if (icon) icon.setAttribute("data-icon", collapsed ? "panelLeftClose" : "panelLeft");
  mountIcons($("#btn-sidebar-toggle"));
});

$("#fab-read").addEventListener("click", () => runAction("read"));

buildHomeGrid($("#home-grid"), {
  getHasDoc: () => !!state.path,
  onAction: (action) => handlers[action]?.(),
  onNeedDoc: (action) => promptOpenPdf(action),
});
setRecentOpenHandler((path) => openPdf(path));
renderRecentList((path) => openPdf(path));
initRecentToolbar({ onOpen: (path) => openPdf(path), showToast });

$("#btn-zoom-in").addEventListener("click", async () => {
  await viewer.setZoom(viewer.zoom + 0.15);
  $("#zoom-label").textContent = `${Math.round(viewer.zoom * 100)}%`;
});
$("#btn-zoom-out").addEventListener("click", async () => {
  await viewer.setZoom(viewer.zoom - 0.15);
  $("#zoom-label").textContent = `${Math.round(viewer.zoom * 100)}%`;
});

$("#page-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const p = parseInt(e.target.value, 10) - 1;
    if (p >= 0 && p < state.pageCount) {
      viewer.scrollToPage(p);
      updatePageUI(p);
    }
  }
});

const viewerEl = document.getElementById("viewer");
viewerEl.addEventListener("scroll", () => {
  const p = viewer.getPageAtScroll();
  if (p !== viewer.currentPage) updatePageUI(p);
  viewer.renderVisiblePages();
});

async function runSearch(query) {
  if (!query.trim()) return;
  $("#search-bar").classList.remove("hidden");
  $("#search-input").value = query;
  const results = await viewer.search(query);
  $("#search-count").textContent = results.length ? `1 / ${results.length}` : "0 / 0";
}

$("#search-input").addEventListener("keydown", async (e) => {
  if (e.key === "Enter") await runSearch(e.target.value);
  if (e.key === "Escape") $("#search-close").click();
});
$("#top-search").addEventListener("input", (e) => {
  if (currentView === "home") {
    renderRecentList((path) => openPdf(path), e.target.value);
  }
});

$("#top-search").addEventListener("keydown", async (e) => {
  if (e.key === "Enter" && !e.target.disabled) {
    e.preventDefault();
    if (currentView === "home") {
      renderRecentList((path) => openPdf(path), e.target.value);
      return;
    }
    if (currentView === "document") await runSearch(e.target.value);
  }
});
$("#search-close").addEventListener("click", async () => {
  $("#search-bar").classList.add("hidden");
  await viewer.clearSearch();
  $("#search-count").textContent = "0 / 0";
});
$("#search-next").addEventListener("click", async () => {
  const idx = await viewer.searchNext();
  $("#search-count").textContent = `${idx + 1} / ${viewer.searchResults.length}`;
});
$("#search-prev").addEventListener("click", async () => {
  const idx = await viewer.searchPrev();
  $("#search-count").textContent = `${idx + 1} / ${viewer.searchResults.length}`;
});

$("#btn-sign-mode").addEventListener("click", () => runAction("sign"));
$("#btn-cancel-sign").addEventListener("click", () => {
  signer.disable();
  setStatus("Signing cancelled.");
});
$("#btn-add-signature").addEventListener("click", async () => {
  const dataUrl = await showSignaturePicker({ showToast });
  if (!dataUrl) return;
  signer.startPlacement(dataUrl);
  setStatus("Click on the page where you want the next signature.");
});
$("#btn-save-signed").addEventListener("click", async () => {
  if (!signer.hasPlacements()) {
    showToast("Place a signature on the document first.", "error");
    return;
  }
  const out = await window.pdfApi.savePdf(`${state.baseName}_signed.pdf`);
  if (!out) return;
  setProgress(true, 0, "Embedding signatures…", "Saving signed PDF");
  try {
    await signer.embedAndSave(state.path, out);
    showToast("Signed PDF saved.", "success");
    signer.disable();
    await openPdf(out);
  } catch (e) {
    showToast(`Save failed: ${e.message}`, "error");
  } finally {
    setProgress(false);
  }
});

const dropZone = $("#drop-zone");
const viewerWrap = $("#viewer-wrap");
["dragenter", "dragover"].forEach((ev) => {
  viewerWrap.addEventListener(ev, (e) => { e.preventDefault(); });
});
dropZone.addEventListener("drop", async (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file?.path) await openPdf(file.path);
});
$("#drop-open-btn").addEventListener("click", handlers.open);

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "f") {
    e.preventDefault();
    $("#top-search").focus();
  }
  if (e.ctrlKey && e.key === "o") {
    e.preventDefault();
    handlers.open();
  }
});

mountIcons();
initSettings();
if (isSidebarCollapsed()) {
  const icon = $("#btn-sidebar-toggle span");
  if (icon) icon.setAttribute("data-icon", "panelLeftClose");
}
checkBackend();
showView("home");
setStatus("Ready");
