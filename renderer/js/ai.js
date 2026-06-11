import { marked } from "../../node_modules/marked/lib/marked.esm.js";
import { mountIcons, svgIcon } from "./icons.js";
import { ensureApiKey, streamGroq, docSystemPrefix } from "./ai-client.js";

const ASSISTANT_NAME = "Chenny";
const CHAT_STORAGE_KEY = "chenny-chat-sessions";

const QUICK_PROMPTS = [
  { label: "Summarize this document", text: "Summarize this document in clear paragraphs." },
  { label: "Key points", text: "What are the key points of this document?" },
  { label: "Explain simply", text: "Explain this document in simple terms." },
  { label: "Find all dates", text: "Find and list all dates mentioned in this document." },
];

let aiState = {
  sessionId: null,
  path: null,
  name: "",
  text: "",
  info: {},
  chatHistory: [],
};

export function getAiState() {
  return aiState;
}

export function resetAiDocument() {
  persistCurrentSession();
  aiState = { sessionId: null, path: null, name: "", text: "", info: {}, chatHistory: [] };
}

function loadSessions() {
  try {
    return JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveSessions(sessions) {
  localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(sessions.slice(0, 50)));
}

function sessionTitle(messages, docName) {
  const first = messages.find((m) => m.role === "user" && m.content?.trim());
  if (first) {
    const t = first.content.trim();
    return t.length > 48 ? `${t.slice(0, 48)}…` : t;
  }
  return docName || "New chat";
}

function persistCurrentSession() {
  if (!aiState.sessionId && !aiState.chatHistory.length) return;
  const id = aiState.sessionId || `s-${Date.now()}`;
  const sessions = loadSessions().filter((s) => s.id !== id);
  if (!aiState.chatHistory.length) return;

  sessions.unshift({
    id,
    title: sessionTitle(aiState.chatHistory, aiState.name),
    docName: aiState.name || "",
    docPath: aiState.path || "",
    messages: aiState.chatHistory.map((m) => ({ role: m.role, content: m.content })),
    updatedAt: Date.now(),
  });
  saveSessions(sessions);
  aiState.sessionId = id;
}

function chennyAvatar(size = 32) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
    <circle cx="16" cy="16" r="16" fill="#fce7f3"/>
    <ellipse cx="16" cy="22" rx="9" ry="7" fill="#f9a8d4"/>
    <circle cx="16" cy="13" r="6" fill="#fbcfe8"/>
    <path d="M10 11c0-2 2.5-4 6-4s6 2 6 4" fill="#831843" opacity="0.55"/>
    <circle cx="13" cy="14" r="1" fill="#831843"/>
    <circle cx="19" cy="14" r="1" fill="#831843"/>
    <path d="M14 17c1 .8 3 .8 4 0" stroke="#be185d" stroke-width="0.8" fill="none" stroke-linecap="round"/>
  </svg>`;
}

function userAvatar(size = 32) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
    <circle cx="16" cy="16" r="16" fill="var(--border)"/>
    <circle cx="16" cy="12" r="5" fill="var(--text-muted)"/>
    <path d="M6 27c0-5.5 4.5-9 10-9s10 3.5 10 9" fill="var(--text-muted)"/>
  </svg>`;
}

function setAiLoading(root, on, msg = "Thinking…") {
  const el = root.querySelector("#ai-loading");
  const txt = root.querySelector("#ai-loading-msg");
  if (el) el.classList.toggle("hidden", !on);
  if (txt) txt.textContent = msg;
}

async function loadPdfIntoAi(root, filePath, { showToast, keepHistory = false } = {}) {
  if (!filePath) return false;
  if (!keepHistory) persistCurrentSession();
  setAiLoading(root, true, "Reading your PDF…");
  try {
    const r = await window.aiApi.extractPdf(filePath);
    if (!r.ok) throw new Error(r.error || "Extraction failed");
    const name = await window.pdfApi.basename(filePath);
    aiState = {
      sessionId: keepHistory ? aiState.sessionId : null,
      path: filePath,
      name,
      text: r.text,
      info: r.info || {},
      chatHistory: keepHistory ? aiState.chatHistory : [],
    };
    updateDocBar(root);
    renderChatMessages(root);
    showToast?.(`Loaded ${name} (${r.numpages} pages)`, "success");
    return true;
  } catch (e) {
    showToast?.(e.message, "error");
    return false;
  } finally {
    setAiLoading(root, false);
  }
}

function updateDocBar(root) {
  const bar = root.querySelector("#ai-doc-bar");
  if (!bar) return;
  if (!aiState.path) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }
  bar.classList.remove("hidden");
  const chars = aiState.text.length;
  bar.innerHTML = `
    <span class="ai-doc-icon">${svgIcon("fileText", 16)}</span>
    <span class="ai-doc-name" title="${escapeHtml(aiState.name)}">${escapeHtml(aiState.name)}</span>
    <span class="ai-doc-meta">${chars.toLocaleString()} chars</span>
    <button type="button" class="ai-doc-clear" id="ai-clear-doc" title="Clear document">×</button>
  `;
  bar.querySelector("#ai-clear-doc")?.addEventListener("click", () => {
    resetAiDocument();
    updateDocBar(root);
    renderChatMessages(root);
    renderHistoryList(root);
  });
}

function requireDoc(root, showToast) {
  if (!aiState.text?.trim()) {
    showToast?.("Attach a PDF first to chat with Chenny.", "info");
    return false;
  }
  return true;
}

function renderChatMessages(root) {
  const box = root.querySelector("#ai-chat-messages");
  if (!box) return;

  if (!aiState.chatHistory.length) {
    box.innerHTML = `
      <div class="chenny-welcome">
        <div class="chenny-welcome-avatar">${chennyAvatar(72)}</div>
        <h2 class="chenny-greeting">Hi, I'm ${ASSISTANT_NAME}</h2>
        <p class="chenny-greeting-sub">Your AI document assistant. Attach a PDF and ask me anything about it.</p>
        <div class="chenny-suggestions">
          ${QUICK_PROMPTS.map((p, i) => `<button type="button" class="chenny-suggestion" data-prompt-idx="${i}">${escapeHtml(p.label)}</button>`).join("")}
        </div>
      </div>`;
    box.querySelectorAll(".chenny-suggestion").forEach((btn) => {
      btn.addEventListener("click", () => {
        const p = QUICK_PROMPTS[parseInt(btn.dataset.promptIdx, 10)];
        if (p) sendChat(root, p.text, root._aiShowToast);
      });
    });
    return;
  }

  box.innerHTML = aiState.chatHistory
    .map((m, i) => {
      const isUser = m.role === "user";
      const isStreaming = !isUser && i === aiState.chatHistory.length - 1 && !m.content;
      const body = isUser
        ? escapeHtml(m.content)
        : isStreaming
          ? '<span class="ai-typing"><span></span><span></span><span></span></span>'
          : formatMarkdown(m.content);

      if (isUser) {
        return `
    <div class="chenny-msg user">
      <div class="chenny-msg-bubble">${body}</div>
      <div class="chenny-msg-avatar">${userAvatar(28)}</div>
    </div>`;
      }
      return `
    <div class="chenny-msg assistant">
      <div class="chenny-msg-avatar">${chennyAvatar(28)}</div>
      <div class="chenny-msg-content">${body}</div>
    </div>`;
    })
    .join("");
  box.scrollTop = box.scrollHeight;
}

function updateStreamingBubble(root, content) {
  const box = root.querySelector("#ai-chat-messages");
  const rows = box?.querySelectorAll(".chenny-msg.assistant");
  const last = rows?.[rows.length - 1];
  const contentEl = last?.querySelector(".chenny-msg-content");
  if (contentEl) {
    contentEl.innerHTML = content
      ? formatMarkdown(content)
      : '<span class="ai-typing"><span></span><span></span><span></span></span>';
    box.scrollTop = box.scrollHeight;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatMarkdown(text) {
  try {
    return marked.parse(text || "", { breaks: true });
  } catch {
    return escapeHtml(text);
  }
}

function formatHistoryDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function renderHistoryList(root) {
  const list = root.querySelector("#chenny-history-list");
  if (!list) return;
  const sessions = loadSessions();
  if (!sessions.length) {
    list.innerHTML = `<p class="chenny-history-empty">No past chats yet.</p>`;
    return;
  }
  list.innerHTML = sessions
    .map(
      (s) => `
    <button type="button" class="chenny-history-item${s.id === aiState.sessionId ? " active" : ""}" data-session-id="${s.id}">
      <span class="chenny-history-title">${escapeHtml(s.title)}</span>
      <span class="chenny-history-meta">${escapeHtml(s.docName || "No PDF")} · ${formatHistoryDate(s.updatedAt)}</span>
    </button>`
    )
    .join("");

  list.querySelectorAll(".chenny-history-item").forEach((btn) => {
    btn.addEventListener("click", () => openSession(root, btn.dataset.sessionId));
  });
}

function toggleHistoryDrawer(root, open) {
  const drawer = root.querySelector("#chenny-history-drawer");
  const backdrop = root.querySelector("#chenny-history-backdrop");
  if (!drawer) return;
  const show = open ?? drawer.classList.contains("hidden");
  drawer.classList.toggle("hidden", !show);
  backdrop?.classList.toggle("hidden", !show);
  if (show) renderHistoryList(root);
}

async function openSession(root, sessionId) {
  const session = loadSessions().find((s) => s.id === sessionId);
  if (!session) return;
  persistCurrentSession();

  aiState = {
    sessionId: session.id,
    path: session.docPath || null,
    name: session.docName || "",
    text: "",
    info: {},
    chatHistory: session.messages.map((m) => ({ ...m })),
  };

  if (session.docPath) {
    try {
      const r = await window.aiApi.extractPdf(session.docPath);
      if (r.ok) {
        aiState.text = r.text;
        aiState.info = r.info || {};
      }
    } catch {
      /* doc may have moved */
    }
  }

  updateDocBar(root);
  renderChatMessages(root);
  toggleHistoryDrawer(root, false);
}

function startNewChat(root) {
  persistCurrentSession();
  aiState.sessionId = null;
  aiState.chatHistory = [];
  renderChatMessages(root);
  toggleHistoryDrawer(root, false);
  root.querySelector("#ai-chat-input")?.focus();
}

async function sendChat(root, userText, { showToast }) {
  if (!requireDoc(root, showToast)) return;
  if (!(await ensureApiKey(showToast))) return;
  const text = userText.trim();
  if (!text) return;

  if (!aiState.sessionId) aiState.sessionId = `s-${Date.now()}`;

  aiState.chatHistory.push({ role: "user", content: text });
  aiState.chatHistory.push({ role: "assistant", content: "" });
  renderChatMessages(root);

  const idx = aiState.chatHistory.length - 1;
  const messages = [
    { role: "system", content: docSystemPrefix(aiState.text) },
    ...aiState.chatHistory.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
  ];

  const panel = root.querySelector("#ai-chat-panel");
  const sendBtn = root.querySelector("#ai-chat-send");
  const chatInput = root.querySelector("#ai-chat-input");
  panel?.classList.add("is-streaming");
  if (sendBtn) sendBtn.disabled = true;
  if (chatInput) chatInput.disabled = true;

  try {
    await streamGroq(messages, {
      onChunk: (chunk) => {
        aiState.chatHistory[idx].content += chunk;
        updateStreamingBubble(root, aiState.chatHistory[idx].content);
      },
    });
  } catch (e) {
    aiState.chatHistory[idx].content = `Sorry, something went wrong: ${e.message}`;
    showToast?.(e.message, "error");
    renderChatMessages(root);
  } finally {
    panel?.classList.remove("is-streaming");
    if (sendBtn) sendBtn.disabled = false;
    if (chatInput) chatInput.disabled = false;
    updateSendButton(root);
    renderChatMessages(root);
    persistCurrentSession();
    renderHistoryList(root);
  }
}

function updateSendButton(root) {
  const input = root.querySelector("#ai-chat-input");
  const sendBtn = root.querySelector("#ai-chat-send");
  if (!input || !sendBtn) return;
  const hasText = Boolean(input.value.trim());
  const streaming = root.querySelector("#ai-chat-panel")?.classList.contains("is-streaming");
  sendBtn.disabled = !hasText && !streaming;
  sendBtn.classList.toggle("active", hasText);
}

function buildAiHtml() {
  return `
    <div class="chenny-page">
      <div id="chenny-history-backdrop" class="chenny-history-backdrop hidden"></div>
      <aside id="chenny-history-drawer" class="chenny-history-drawer hidden">
        <div class="chenny-history-head">
          <h3>Chat history</h3>
          <button type="button" class="chenny-icon-btn" id="chenny-history-close" title="Close">${svgIcon("x", 18)}</button>
        </div>
        <button type="button" class="chenny-new-chat-btn" id="chenny-new-chat">
          ${svgIcon("plus", 16)} New chat
        </button>
        <div id="chenny-history-list" class="chenny-history-list"></div>
      </aside>

      <header class="chenny-topbar">
        <div class="chenny-topbar-left">
          <button type="button" class="chenny-icon-btn" id="chenny-history-open" title="Chat history">
            ${svgIcon("history", 20)}
          </button>
          <div class="chenny-brand">
            <span class="chenny-brand-avatar">${chennyAvatar(28)}</span>
            <span class="chenny-brand-name">${ASSISTANT_NAME}</span>
          </div>
        </div>
        <div class="chenny-topbar-actions">
          <button type="button" class="chenny-top-btn" id="ai-use-open-doc" title="Use open document">Use open PDF</button>
        </div>
      </header>

      <div id="ai-doc-bar" class="ai-doc-bar hidden"></div>

      <div id="ai-loading" class="ai-loading-banner hidden">
        <div class="progress-popup-spinner sm"></div>
        <span id="ai-loading-msg">Thinking…</span>
      </div>

      <div class="chenny-chat-panel" id="ai-chat-panel">
        <div id="ai-chat-messages" class="chenny-thread"></div>
        <div class="chenny-composer-wrap">
          <div class="chenny-composer">
            <button type="button" class="chenny-composer-btn attach-btn" id="ai-attach" title="Attach PDF">
              ${svgIcon("plus", 20)}
            </button>
            <textarea id="ai-chat-input" class="chenny-composer-input" rows="1" placeholder="Ask anything"></textarea>
            <button type="button" class="chenny-composer-send" id="ai-chat-send" title="Send" disabled>
              ${svgIcon("arrowUp", 18)}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function wireAiView(root, { showToast, getOpenDocPath }) {
  root._aiShowToast = { showToast };

  root.querySelector("#ai-attach")?.addEventListener("click", async () => {
    const path = await window.pdfApi.openPdf();
    if (path) await loadPdfIntoAi(root, path, { showToast });
  });

  root.querySelector("#ai-use-open-doc")?.addEventListener("click", async () => {
    const path = getOpenDocPath?.();
    if (!path) {
      showToast?.("No document is open in the viewer.", "info");
      return;
    }
    await loadPdfIntoAi(root, path, { showToast });
  });

  root.querySelector("#chenny-history-open")?.addEventListener("click", () => toggleHistoryDrawer(root, true));
  root.querySelector("#chenny-history-close")?.addEventListener("click", () => toggleHistoryDrawer(root, false));
  root.querySelector("#chenny-history-backdrop")?.addEventListener("click", () => toggleHistoryDrawer(root, false));
  root.querySelector("#chenny-new-chat")?.addEventListener("click", () => startNewChat(root));

  const chatInput = root.querySelector("#ai-chat-input");
  const autoResizeInput = () => {
    if (!chatInput) return;
    chatInput.style.height = "auto";
    chatInput.style.height = `${Math.min(chatInput.scrollHeight, 160)}px`;
  };

  chatInput?.addEventListener("input", () => {
    autoResizeInput();
    updateSendButton(root);
  });

  const submitChat = () => {
    const text = chatInput?.value?.trim();
    if (!text) return;
    sendChat(root, text, { showToast });
    chatInput.value = "";
    autoResizeInput();
    updateSendButton(root);
  };

  root.querySelector("#ai-chat-send")?.addEventListener("click", submitChat);
  chatInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitChat();
    }
  });
}

const AI_WIRE_VERSION = "4";

export async function mountAiView({ showToast, getOpenDocPath } = {}) {
  const root = document.getElementById("view-ai");
  if (!root) return;

  if (root.dataset.wired !== AI_WIRE_VERSION) {
    root.dataset.wired = AI_WIRE_VERSION;
    root.innerHTML = buildAiHtml();
    mountIcons(root);
    wireAiView(root, { showToast, getOpenDocPath });
  }

  updateDocBar(root);
  renderChatMessages(root);
  renderHistoryList(root);
  updateSendButton(root);

  const openPath = getOpenDocPath?.();
  if (openPath && !aiState.path) await loadPdfIntoAi(root, openPath, { showToast });
}
