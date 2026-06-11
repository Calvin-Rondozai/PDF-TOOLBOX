export async function ensureApiKey(showToast) {
  const s = await window.aiApi.getSettings();
  if (!s?.hasApiKey) {
    showToast?.("Add your Groq API key in Settings → AI.", "error");
    return false;
  }
  return true;
}

function plainMessages(messages) {
  return (messages || []).map((m) => ({
    role: String(m.role || "user"),
    content: String(m.content ?? ""),
  }));
}

export function streamGroq(messages, { onChunk, temperature } = {}) {
  return new Promise((resolve, reject) => {
    const cleanups = [];
    let settled = false;

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      cleanups.forEach((c) => c());
      fn(val);
    };

    cleanups.push(window.aiApi.onStreamChunk((d) => onChunk?.(d.text)));
    cleanups.push(window.aiApi.onStreamEnd((d) => finish(resolve, d.full || "")));
    cleanups.push(window.aiApi.onStreamError((d) => finish(reject, new Error(d.message))));

    window.aiApi
      .stream({ messages: plainMessages(messages), temperature })
      .then((r) => {
        if (!r.ok) finish(reject, new Error(r.error || "AI request failed"));
        else if (r.full != null && !settled) finish(resolve, r.full);
      })
      .catch((e) => finish(reject, e));
  });
}

export function parseJsonArray(text) {
  const cleaned = String(text).trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("AI did not return a valid JSON array.");
  return JSON.parse(cleaned.slice(start, end + 1));
}

export function docSystemPrefix(documentText) {
  return `You are Chenny, a friendly and capable document assistant. Answer questions based only on the provided document text. Be clear, warm, and concise.\n\nDocument:\n\n${documentText}`;
}
