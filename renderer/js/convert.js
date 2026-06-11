import { showModal } from "./modals.js";

const OPTIONS = [
  { id: "word-to-pdf", label: "Word → PDF", type: "word", direction: "to-pdf", icon: "fileText", desc: "Convert .docx or .doc to PDF" },
  { id: "pdf-to-word", label: "PDF → Word", type: "word", direction: "from-pdf", icon: "fileText", desc: "Export PDF as .docx" },
  { id: "excel-to-pdf", label: "Excel → PDF", type: "excel", direction: "to-pdf", icon: "fileText", desc: "Convert .xlsx or .xls to PDF" },
  { id: "pdf-to-excel", label: "PDF → Excel", type: "excel", direction: "from-pdf", icon: "fileText", desc: "Export PDF as .xlsx" },
  { id: "ppt-to-pdf", label: "PowerPoint → PDF", type: "powerpoint", direction: "to-pdf", icon: "fileText", desc: "Convert .pptx or .ppt to PDF" },
  { id: "pdf-to-ppt", label: "PDF → PowerPoint", type: "powerpoint", direction: "from-pdf", icon: "fileText", desc: "Export PDF as .pptx" },
  { id: "images-to-pdf", label: "Images → PDF", type: "images", direction: "to-pdf", icon: "image", desc: "Combine images into one PDF" },
  { id: "pdf-to-images", label: "PDF → Images", type: "images", direction: "from-pdf", icon: "image", desc: "Export each page as PNG" },
];

const FORMATS = {
  word: { label: "Word", kind: "word", ext: "docx", exts: ["docx", "doc", "odt"] },
  excel: { label: "Excel", kind: "excel", ext: "xlsx", exts: ["xlsx", "xls", "ods", "csv"] },
  powerpoint: { label: "PowerPoint", kind: "powerpoint", ext: "pptx", exts: ["pptx", "ppt", "odp"] },
  images: { label: "Images", ext: "png", exts: ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "gif"] },
};

export async function showConvertModal({ runOp, showToast, openPdf }) {
  const result = await showModal({
    title: "Convert Files",
    modalClass: "modal-lg",
    confirmLabel: "Start Conversion",
    bodyHtml: `
      <p class="form-desc">Choose one conversion type below, then click Start Conversion.</p>
      <div class="convert-options">
        ${OPTIONS.map(
          (o, i) => `
          <label class="convert-option${i === 0 ? " selected" : ""}">
            <input type="radio" name="convert-opt" value="${o.id}" ${i === 0 ? "checked" : ""} />
            <span class="convert-option-body">
              <strong>${o.label}</strong>
              <span>${o.desc}</span>
            </span>
          </label>`
        ).join("")}
      </div>
      <div class="convert-summary" id="convert-summary"></div>
    `,
    onMount: (body) => {
      const summary = body.querySelector("#convert-summary");
      const updateSummary = () => {
        const id = body.querySelector('[name="convert-opt"]:checked')?.value;
        const opt = OPTIONS.find((o) => o.id === id);
        if (!opt) return;
        summary.innerHTML = `
          <strong>Selected:</strong> ${opt.label}<br/>
          <span class="form-desc">${opt.desc}</span>
        `;
        body.querySelectorAll(".convert-option").forEach((el) => {
          el.classList.toggle("selected", el.querySelector("input")?.value === id);
        });
      };
      body.querySelectorAll('[name="convert-opt"]').forEach((r) => {
        r.addEventListener("change", updateSummary);
      });
      updateSummary();
    },
    onConfirm: (body) => {
      const id = body.querySelector('[name="convert-opt"]:checked')?.value;
      const opt = OPTIONS.find((o) => o.id === id);
      return opt || false;
    },
  });

  if (!result) return;

  const fmt = FORMATS[result.type];
  const { type, direction } = result;

  if (direction === "to-pdf") {
    if (type === "images") {
      const paths = await window.pdfApi.openImages();
      if (!paths.length) return;
      const out = await window.pdfApi.savePdf("images.pdf");
      if (!out) return;
      const r = await runOp(
        { op: "convert_images_to_pdf", paths, out },
        "Converting images to PDF"
      );
      showToast(r?.detail || "Conversion failed.", r?.ok ? "success" : "error");
      if (r?.ok) await openPdf(out);
      return;
    }
    const inp = await window.pdfApi.openOffice(fmt.kind);
    if (!inp) return;
    const base = (await window.pdfApi.basename(inp)).replace(/\.[^.]+$/, "");
    const out = await window.pdfApi.savePdf(`${base}.pdf`);
    if (!out) return;
    const r = await runOp(
      { op: "convert_office_to_pdf", inp, out },
      `Converting ${fmt.label} to PDF`
    );
    showToast(r?.detail || "Conversion failed.", r?.ok ? "success" : "error");
    if (r?.ok) await openPdf(out);
    return;
  }

  const inp = await window.pdfApi.openPdf();
  if (!inp) return;
  const base = (await window.pdfApi.basename(inp)).replace(/\.pdf$/i, "");

  if (type === "images") {
    const outDir = await window.pdfApi.pickFolder();
    if (!outDir) return;
    const r = await runOp(
      { op: "convert_pdf_to_images", inp, out_dir: outDir, format: "png" },
      "Exporting PDF pages as images"
    );
    showToast(r?.detail || "Export failed.", r?.ok ? "success" : "error");
    if (r?.ok) window.pdfApi.showInFolder(r.paths?.[0] || outDir);
    return;
  }

  let out = await window.pdfApi.saveFile(`${base}.${fmt.ext}`, fmt.exts);
  if (!out) return;
  if (!out.toLowerCase().endsWith(`.${fmt.ext}`)) out += `.${fmt.ext}`;
  const r = await runOp(
    { op: "convert_pdf_to_office", inp, out, format: fmt.ext },
    `Exporting PDF to ${fmt.label}`
  );
  showToast(r?.detail || "Export failed.", r?.ok ? "success" : "error");
  if (r?.ok) window.pdfApi.showInFolder(out);
}
