const fs = require("fs");
const Groq = require("groq-sdk");
const Store = require("electron-store");
const { runPythonOp } = require("./python-bridge");

const store = new Store();
const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const MAX_DOC_CHARS = 120000;

const MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "mixtral-8x7b-32768",
];

function getAiSettings() {
  return {
    groqApiKey: store.get("settings.groqApiKey", "") || "",
    groqModel: store.get("settings.groqModel", DEFAULT_MODEL) || DEFAULT_MODEL,
    hasApiKey: Boolean(store.get("settings.groqApiKey", "")),
  };
}

function saveAiSettings({ groqApiKey, groqModel }) {
  if (groqApiKey !== undefined) store.set("settings.groqApiKey", String(groqApiKey).trim());
  if (groqModel !== undefined) store.set("settings.groqModel", groqModel);
  return getAiSettings();
}

function trimDocumentText(text) {
  if (!text || text.length <= MAX_DOC_CHARS) return text || "";
  return `${text.slice(0, MAX_DOC_CHARS)}\n\n[Document truncated for length…]`;
}

/** Electron IPC only accepts plain JSON-serializable values */
function toPlainString(val) {
  if (val == null) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (val instanceof Date) return val.toISOString();
  if (typeof val === "object" && val.toISOString) return val.toISOString();
  if (typeof val.toString === "function") return String(val.toString());
  return "";
}

function sanitizeMessages(messages) {
  return (messages || []).map((m) => ({
    role: String(m?.role || "user"),
    content: String(m?.content ?? ""),
  }));
}

function getGroqClient() {
  const { groqApiKey } = getAiSettings();
  if (!groqApiKey) {
    throw new Error("Groq API key not configured. Add your key in Settings → AI.");
  }
  return new Groq({ apiKey: groqApiKey });
}

async function extractPdf(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error("PDF file not found.");
  }

  const result = await runPythonOp({ op: "extract_pdf_for_ai", path: filePath });
  if (!result.ok) {
    throw new Error(result.detail || "PDF text extraction failed.");
  }

  const info = result.info || {};
  return {
    text: String(result.text || ""),
    numpages: Number(result.numpages) || 0,
    info: {
      Title: toPlainString(info.Title),
      Author: toPlainString(info.Author),
      Creator: toPlainString(info.Creator),
      Producer: toPlainString(info.Producer),
      CreationDate: toPlainString(info.CreationDate),
      ModDate: toPlainString(info.ModDate),
    },
  };
}

async function streamCompletion(sender, { messages, temperature = 0.4 }) {
  const groq = getGroqClient();
  const { groqModel } = getAiSettings();
  const model = MODELS.includes(groqModel) ? groqModel : DEFAULT_MODEL;
  const safeMessages = sanitizeMessages(messages);

  const stream = await groq.chat.completions.create({
    model,
    messages: safeMessages,
    stream: true,
    temperature,
  });

  let full = "";
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content || "";
    if (!delta) continue;
    full += delta;
    if (sender && !sender.isDestroyed?.()) {
      sender.send("ai:stream-chunk", { text: String(delta) });
    }
  }

  if (sender && !sender.isDestroyed?.()) {
    sender.send("ai:stream-end", { full: String(full) });
  }
  return full;
}

async function completeOnce(sender, options) {
  return streamCompletion(sender, options);
}

module.exports = {
  MODELS,
  DEFAULT_MODEL,
  getAiSettings,
  saveAiSettings,
  extractPdf,
  trimDocumentText,
  sanitizeMessages,
  streamCompletion,
  completeOnce,
};
