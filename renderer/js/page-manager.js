import { mountIcons, svgIcon } from "./icons.js";
import { showModal } from "./modals.js";

function getOrder(listEl) {
  return [...listEl.querySelectorAll(".page-mgr-item:not([data-is-clone])")].map((el) =>
    parseInt(el.dataset.page, 10)
  );
}

function createPageItem(pageIndex, { isClone = false } = {}) {
  const item = document.createElement("div");
  item.className = `page-mgr-item${isClone ? " page-mgr-dup" : ""}`;
  item.dataset.page = pageIndex;
  if (isClone) item.dataset.isClone = "1";
  item.draggable = true;
  item.innerHTML = `
    <span class="page-mgr-grip">${svgIcon("gripVertical", 14)}</span>
    <input type="checkbox" class="page-mgr-check" data-pg="${pageIndex}" />
    <div class="page-mgr-thumb"><div class="merge-thumb-skeleton"></div></div>
    <span class="page-mgr-label">${isClone ? `Page ${pageIndex + 1} (copy)` : `Page ${pageIndex + 1}`}</span>
  `;
  return item;
}

export async function showPageManager(path, pageCount, { showToast } = {}) {
  const result = await showModal({
    title: "Manage Pages",
    modalClass: "modal-lg",
    confirmLabel: "Apply Changes",
    bodyHtml: `
      <p class="form-desc">Drag to rearrange. Select pages to rotate, duplicate, or delete.</p>
      <div class="page-mgr-actions">
        <button type="button" class="chip" id="pm-rotate" data-icon="rotateCw">Rotate 90°</button>
        <button type="button" class="chip" id="pm-dup">Duplicate</button>
        <button type="button" class="chip danger-chip" id="pm-del">Delete</button>
      </div>
      <div id="page-mgr-list" class="page-mgr-list"></div>
    `,
    onMount: async (body) => {
      mountIcons(body);
      const list = body.querySelector("#page-mgr-list");
      list.innerHTML = "";
      body._rotations = {};
      body._dupPages = [];

      const renderThumb = async (item, pageIndex) => {
        const rot = body._rotations[pageIndex] || 0;
        const r = await window.pdfApi.runOp({
          op: "render_page",
          path,
          page: pageIndex,
          dpi: 72,
          zoom: 0.45,
          rotation: rot,
        });
        const thumb = item.querySelector(".page-mgr-thumb");
        if (r.ok && r.image) {
          thumb.innerHTML = `<img src="data:image/png;base64,${r.image}" alt="" style="transform:rotate(${rot}deg)" />`;
        }
      };

      for (let i = 0; i < pageCount; i++) {
        const item = createPageItem(i);
        list.appendChild(item);
        renderThumb(item, i);
      }

      let dragEl = null;
      const wireDrag = (item) => {
        item.addEventListener("dragstart", () => {
          dragEl = item;
          item.classList.add("dragging");
        });
        item.addEventListener("dragend", () => {
          item.classList.remove("dragging");
          dragEl = null;
        });
        item.addEventListener("dragover", (e) => {
          e.preventDefault();
          if (!dragEl || dragEl === item) return;
          const siblings = [...list.querySelectorAll(".page-mgr-item:not(.dragging)")];
          const after = siblings.find((c) => {
            const box = c.getBoundingClientRect();
            return e.clientY < box.top + box.height / 2;
          });
          if (after) list.insertBefore(dragEl, after);
          else list.appendChild(dragEl);
        });
      };

      list.querySelectorAll(".page-mgr-item").forEach(wireDrag);

      const selected = () =>
        [...list.querySelectorAll(".page-mgr-check:checked")]
          .filter((c) => !c.closest("[data-is-clone]"))
          .map((c) => parseInt(c.dataset.pg, 10));

      body.querySelector("#pm-rotate").addEventListener("click", async () => {
        const checked = selected();
        if (!checked.length) {
          showToast?.("Select pages to rotate.", "error");
          return;
        }
        body._action = "rotate";
        for (const pg of checked) {
          body._rotations[pg] = ((body._rotations[pg] || 0) + 90) % 360;
          const items = list.querySelectorAll(`.page-mgr-item[data-page="${pg}"]:not([data-is-clone])`);
          for (const item of items) await renderThumb(item, pg);
        }
        showToast?.(`Rotated ${checked.length} page(s) in preview. Click Apply to save.`, "info");
      });

      body.querySelector("#pm-dup").addEventListener("click", async () => {
        const checked = selected();
        if (!checked.length) {
          showToast?.("Select pages to duplicate.", "error");
          return;
        }
        body._action = "duplicate";

        for (const pg of [...checked].sort((a, b) => b - a)) {
          if (body._dupPages.includes(pg)) continue;

          const srcEl = list.querySelector(
            `.page-mgr-item[data-page="${pg}"]:not([data-is-clone])`
          );
          if (!srcEl) continue;

          body._dupPages.push(pg);
          const clone = createPageItem(pg, { isClone: true });
          srcEl.after(clone);
          wireDrag(clone);
          await renderThumb(clone, pg);
          clone.classList.add("page-mgr-pop");
          setTimeout(() => clone.classList.remove("page-mgr-pop"), 600);
          clone.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }

        if (!body._dupPages.length) {
          showToast?.("Selected page(s) already duplicated in preview.", "info");
          return;
        }
        showToast?.(`Added ${checked.length} duplicate preview(s). Click Apply to save.`, "success");
      });

      body.querySelector("#pm-del").addEventListener("click", () => {
        const checked = selected();
        if (!checked.length) {
          showToast?.("Select pages to delete.", "error");
          return;
        }
        if (pageCount - checked.length < 1) {
          showToast?.("Cannot delete all pages.", "error");
          return;
        }
        body._delPages = checked;
        body._action = "delete";
        checked.forEach((pg) => {
          const el = list.querySelector(
            `.page-mgr-item[data-page="${pg}"]:not([data-is-clone])`
          );
          if (el) el.classList.add("marked-delete");
        });
        showToast?.(`${checked.length} page(s) will be deleted. Click Apply.`, "info");
      });
    },
    onConfirm: (body) => {
      const list = body.querySelector("#page-mgr-list");
      const order = getOrder(list);
      const orig = [...Array(pageCount).keys()];

      if (body._action === "delete") {
        const toDel = new Set(body._delPages || []);
        const newOrder = order.filter((p) => !toDel.has(p));
        if (!newOrder.length) {
          showToast?.("Cannot delete all pages.", "error");
          return false;
        }
        return { op: "reorder_pages", order: newOrder };
      }
      if (body._action === "duplicate") {
        const pages = body._dupPages || [];
        if (!pages.length) {
          showToast?.("No pages marked for duplication.", "error");
          return false;
        }
        return { op: "duplicate_pages", pages };
      }
      if (body._action === "rotate") {
        const rots = body._rotations || {};
        const pages = Object.keys(rots)
          .filter((k) => rots[k] % 360 !== 0)
          .map((k) => parseInt(k, 10));
        if (!pages.length) {
          showToast?.("No rotation to apply.", "info");
          return false;
        }
        return { op: "rotate_map", page_degrees: rots };
      }
      if (JSON.stringify(order) !== JSON.stringify(orig)) {
        return { op: "reorder_pages", order };
      }
      showToast?.("No changes to apply.", "info");
      return false;
    },
  });
  return result;
}
