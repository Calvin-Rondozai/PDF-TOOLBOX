import { svgIcon } from "./icons.js";

const TOOLS = [
  { action: "open", icon: "fileText", label: "Open PDF", desc: "Browse and view a document", always: true },
  { action: "merge", icon: "files", label: "Merge PDFs", desc: "Combine files with preview", always: true },
  { action: "convert", icon: "refreshCw", label: "Convert Files", desc: "Word, Excel, PowerPoint, Images ↔ PDF", always: true },
  { action: "ai", icon: "sparkles", label: "Ask Chenny", desc: "AI assistant — chat about your PDFs", always: true },
  { action: "pages", icon: "layers", label: "Manage Pages", desc: "Rearrange, rotate, delete, duplicate", needsDoc: true },
  { action: "sign", icon: "penLine", label: "E-Sign PDF", desc: "Draw, type, or upload your signature", needsDoc: true },
  { action: "tools", icon: "shrink", label: "Compress", desc: "Reduce size or resize pages", needsDoc: true },
  { action: "fileops", icon: "scissors", label: "File Ops", desc: "Split, rotate, watermark", needsDoc: true },
  { action: "ocr", icon: "scan", label: "OCR Scan", desc: "Make scanned PDFs searchable", always: true, comingSoon: true },
  { action: "edit", icon: "edit", label: "Edit PDF", desc: "Add text, highlights, shapes", always: true, comingSoon: true },
  { action: "read", icon: "volume2", label: "Read Aloud", desc: "Text-to-speech reader", needsDoc: true },
  { action: "save-audio", icon: "download", label: "Save Audio", desc: "Export speech as MP3", needsDoc: true },
];

export function buildHomeGrid(container, { getHasDoc, onAction, onNeedDoc }) {
  container.innerHTML = "";
  TOOLS.forEach((tool, i) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "home-tile";
    card.style.animationDelay = `${i * 40}ms`;
    card.dataset.action = tool.action;
    card.innerHTML = `
      <span class="home-tile-icon">${svgIcon(tool.icon, 26)}</span>
      <span class="home-tile-label">${tool.label}</span>
      <span class="home-tile-desc">${tool.desc}</span>
    `;
    if (tool.comingSoon) card.classList.add("coming-soon-tile");
    card.addEventListener("click", () => {
      if (tool.comingSoon) {
        onAction(tool.action);
        return;
      }
      if (tool.needsDoc && !getHasDoc()) {
        onNeedDoc(tool.action);
        return;
      }
      onAction(tool.action);
    });
    container.appendChild(card);
  });
}

export function refreshHomeGrid() {}

export const NEEDS_DOC_ACTIONS = new Set(
  TOOLS.filter((t) => t.needsDoc).map((t) => t.action)
);
