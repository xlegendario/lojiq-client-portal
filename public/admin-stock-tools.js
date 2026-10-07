// public/admin-stock-tools.js
//
// The filter bar and the Export dialog, shared by the three stock screens
// of the admin portal: Inventory, Partner Stock and Consignment Stock.
//
// The server does the sorting and filtering (admin/stockRefine.js); this
// only draws the controls, keeps them in the address bar so a reload or a
// shared link shows the same list, and hands the page its query.
//
// It holds no data and no secrets, so it is served as a plain file; every
// call it makes goes through the signed-in /api/admin routes.

(function () {
  const esc = (value) => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const SOURCES = {
    inventory: {
      title: "Our stock",
      facets: { brand: "Brand", size: "Size", vat: "VAT type", kind: "Type", location: "Location" },
      price: "Purchase price",
      date: "Purchase date"
    },
    partner: {
      title: "Partner stock",
      facets: { brand: "Brand", size: "Size", vat: "VAT type", mode: "How", partner: "Partner" },
      price: "Partner price",
      date: "Received"
    },
    consignment: {
      title: "Consignment stock",
      facets: { brand: "Brand", size: "Size", consignor: "Consignor" },
      price: "Costs us",
      date: "Added"
    }
  };

  const STYLE = `
    .stock-tools { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; width: 100%; }
    .stock-tools .select { max-width: 170px; }
    .stock-tools .price { width: 92px; }
    .stock-tools .dir { width: 36px; padding: 0; }
    .stock-tools .sep { width: 1px; align-self: stretch; background: var(--border); margin: 0 2px; }
    .stock-tools .count { margin-left: auto; }
    .stock-export .kinds { display: flex; flex-direction: column; gap: 8px; }
    .stock-export .kind { display: flex; flex-direction: column; gap: 2px; padding: 9px 11px; border: 1px solid var(--border); border-radius: 9px; background: var(--panel-2); }
    .stock-export .kind label { display: flex; gap: 8px; align-items: center; font-weight: 700; cursor: pointer; }
    .stock-export .kind .hint { color: var(--muted); font-size: 12px; padding-left: 23px; }
    .stock-export .kind .only { display: flex; gap: 8px; align-items: center; color: var(--muted); font-size: 12px; padding-left: 23px; cursor: pointer; font-weight: 400; }
    .stock-export .formats { display: flex; gap: 14px; }
    .stock-export .formats label { display: flex; gap: 6px; align-items: center; cursor: pointer; }
    .stock-export input[type=checkbox], .stock-export input[type=radio] { accent-color: var(--primary); width: 15px; height: 15px; }
  `;

  /*
   * options:
   *   source    "inventory" | "partner" | "consignment" - the screen this is on
   *   mount     the element the bar goes into (its count element is kept)
   *   screen    () => ({ view, q, check }) - what the screen shows besides the bar
   *   onChange  () => void - reload the list
   *   toast     (message) => void
   */
  window.StockTools = function StockTools({ source, mount, screen, onChange, toast }) {
    const config = SOURCES[source];
    const url = new URL(location.href);

    const refine = { sort: "", dir: "asc", min: "", max: "" };
    for (const name of Object.keys(config.facets)) refine[name] = "";
    for (const name of Object.keys(refine)) refine[name] = url.searchParams.get(name) || refine[name];
    if (refine.dir !== "desc") refine.dir = "asc";

    let facets = {};

    if (!document.getElementById("stock-tools-style")) {
      const style = document.createElement("style");
      style.id = "stock-tools-style";
      style.textContent = STYLE;
      document.head.append(style);
    }

    // The page's own count stays, at the end of the bar.
    const count = mount.querySelector(".count");
    const bar = document.createElement("div");
    bar.className = "stock-tools";
    mount.prepend(bar);
    if (count) bar.append(count);

    function remember() {
      const next = new URL(location.href);

      for (const [name, value] of Object.entries(refine)) {
        if (value && !(name === "dir" && value === "asc")) next.searchParams.set(name, value);
        else next.searchParams.delete(name);
      }

      history.replaceState(null, "", next);
    }

    const active = () => Object.entries(refine).some(([name, value]) => name !== "dir" && value);

    function draw() {
      // A redraw while someone types a price must not take the field away.
      const typing = document.activeElement?.closest?.(".stock-tools [data-price]")?.dataset.price;

      const selects = Object.entries(config.facets).map(([name, label]) => {
        const values = facets[name] || [];
        // A value from the address bar that this view does not hold stays
        // selectable, so it can be seen and cleared.
        if (refine[name] && !values.includes(refine[name])) values.unshift(refine[name]);

        return `<select class="select" data-facet="${name}" aria-label="${esc(label)}">
          <option value="">${esc(label)}: all</option>
          ${values.map((value) => `<option value="${esc(value)}"${value === refine[name] ? " selected" : ""}>${esc(value)}</option>`).join("")}
        </select>`;
      }).join("");

      const sorts = [
        ["", "Default order"], ["size", "Size"], ["price", config.price], ["name", "Product name"],
        ["sku", "SKU"], ["brand", "Brand"], ["date", config.date]
      ];

      bar.innerHTML = `
        ${selects}
        <input class="input price" type="number" min="0" step="1" data-price="min" placeholder="€ from" value="${esc(refine.min)}" aria-label="${esc(config.price)} from">
        <input class="input price" type="number" min="0" step="1" data-price="max" placeholder="€ to" value="${esc(refine.max)}" aria-label="${esc(config.price)} to">
        <span class="sep"></span>
        <select class="select" data-sort aria-label="Sort by">
          ${sorts.map(([value, label]) => `<option value="${value}"${value === refine.sort ? " selected" : ""}>${value ? "Sort: " : ""}${esc(label)}</option>`).join("")}
        </select>
        <button class="btn dir" type="button" data-dir title="${refine.dir === "desc" ? "High to low — click for low to high" : "Low to high — click for high to low"}"${refine.sort ? "" : " disabled"}>${refine.dir === "desc" ? "↓" : "↑"}</button>
        ${active() ? '<button class="btn ghost" type="button" data-clear>Clear</button>' : ""}
        <button class="btn" type="button" data-export>Export</button>
      `;

      if (count) bar.append(count);
      if (typing) bar.querySelector(`[data-price="${typing}"]`)?.focus();
    }

    let priceTimer = null;

    function changed() {
      remember();
      draw();
      onChange();
    }

    bar.addEventListener("change", (event) => {
      const facet = event.target.closest("[data-facet]");
      const sort = event.target.closest("[data-sort]");

      if (facet) { refine[facet.dataset.facet] = facet.value; changed(); }

      if (sort) {
        refine.sort = sort.value;
        // Price and date read best newest / dearest first.
        refine.dir = ["price", "date"].includes(sort.value) ? "desc" : "asc";
        changed();
      }
    });

    bar.addEventListener("input", (event) => {
      const price = event.target.closest("[data-price]");
      if (!price) return;

      refine[price.dataset.price] = price.value.trim();
      clearTimeout(priceTimer);
      priceTimer = setTimeout(() => {
        remember();
        onChange();
      }, 450);
    });

    bar.addEventListener("click", (event) => {
      if (event.target.closest("[data-dir]")) {
        refine.dir = refine.dir === "desc" ? "asc" : "desc";
        changed();
      }

      if (event.target.closest("[data-clear]")) {
        for (const name of Object.keys(refine)) refine[name] = name === "dir" ? "asc" : "";
        changed();
      }

      if (event.target.closest("[data-export]")) openExport();
    });

    /* ---------------- export ---------------- */

    const dialog = document.createElement("dialog");
    dialog.className = "stock-export";
    document.body.append(dialog);

    function openExport() {
      const kinds = Object.entries(SOURCES).map(([name, kind]) => {
        const here = name === source;

        return `<div class="kind">
          <label><input type="checkbox" data-source="${name}"${here ? " checked" : ""}> ${esc(kind.title)}${here ? " <span class=\"sub\">(this screen)</span>" : ""}</label>
          ${here
            ? `<label class="only"><input type="checkbox" data-only checked> Only what this screen shows now: tab, search, filters and order</label>`
            : `<span class="hint">${name === "consignment" ? "Every pair on offer" : "Everything on the shelf"}, by SKU and size.</span>`}
        </div>`;
      }).join("");

      dialog.innerHTML = `
        <form method="dialog" class="dialog-body">
          <h2>Export stock</h2>
          <div class="kinds">${kinds}</div>
          <div class="field">
            <label>File</label>
            <div class="formats">
              <label><input type="radio" name="format" value="xlsx" checked> Excel (.xlsx)</label>
              <label><input type="radio" name="format" value="csv"> CSV</label>
            </div>
            <span class="hint">Excel gets one sheet per kind of stock. CSV gets one file per kind, zipped when there is more than one.</span>
          </div>
          <div class="dialog-foot">
            <button class="btn ghost" type="button" data-cancel>Cancel</button>
            <button class="btn primary" type="submit" data-go>Download</button>
          </div>
        </form>`;

      dialog.showModal();
    }

    dialog.addEventListener("click", (event) => {
      if (event.target.closest("[data-cancel]") || event.target === dialog) dialog.close();
    });

    dialog.addEventListener("submit", async (event) => {
      event.preventDefault();

      const chosen = [...dialog.querySelectorAll("[data-source]:checked")].map((box) => box.dataset.source);

      if (!chosen.length) {
        toast("Tick at least one kind of stock.");
        return;
      }

      const query = new URLSearchParams({
        sources: chosen.join(","),
        format: dialog.querySelector("input[name=format]:checked").value
      });

      if (chosen.includes(source) && dialog.querySelector("[data-only]")?.checked) {
        // The screen's own order too, also when that is its default.
        query.set(source, JSON.stringify({ ...screen(), ...refine }));
      }

      const go = dialog.querySelector("[data-go]");
      go.disabled = true;
      go.textContent = "Preparing…";

      try {
        const response = await fetch(`/api/admin/stock-export?${query}`, { credentials: "same-origin" });

        if (response.status === 401) {
          location.href = "/admin";
          return;
        }

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || `The server answered ${response.status}.`);
        }

        const blob = await response.blob();
        const name = (response.headers.get("Content-Disposition") || "").match(/filename="?([^";]+)"?/)?.[1] || "lojiq-stock";
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = name;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 10_000);

        const rows = (response.headers.get("X-Export-Rows") || "")
          .split(",").filter(Boolean)
          .map((part) => {
            const [kind, n] = part.split("=");
            return `${SOURCES[kind]?.title || kind}: ${Number(n).toLocaleString("nl-NL")}`;
          });

        dialog.close();
        toast(`Downloaded ${name}${rows.length ? ` — ${rows.join(", ")} rows` : ""}.`);
      } catch (err) {
        toast(err.message);
      } finally {
        go.disabled = false;
        go.textContent = "Download";
      }
    });

    draw();

    return {
      // What to add to the page's own query.
      params() {
        const out = {};
        for (const [name, value] of Object.entries(refine)) {
          if (value && !(name === "dir" && value === "asc")) out[name] = value;
        }
        return out;
      },

      // The dropdowns' values, from the answer the page just got.
      update(next) {
        facets = next || {};
        draw();
      }
    };
  };
})();
