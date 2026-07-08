// HTML templates for the air waybill and receipt, rendered to A4 PDF.
//
// The AWB follows the STANDARD air-waybill box layout (researched, not
// invented): header + AWB number (top-right per convention), Shipper box,
// Consignee box, origin/destination, a cargo table (pieces / gross weight /
// chargeable weight / nature & quantity of goods), declared value, handling
// information, and a signature / date / place-of-execution section. Fields we
// don't capture (IATA airport codes, flight routing, freight rates) are
// omitted rather than faked — we use the city/country and weights we do have.

import type { DocData, DocContact } from "./data.js";

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]!),
  );
}

function contactBlock(c: DocContact): string {
  const lines = [
    c.name ? `<strong>${esc(c.name)}</strong>` : "",
    c.company ? esc(c.company) : "",
    c.address ? esc(c.address) : "",
    [c.city, c.postcode].filter(Boolean).map(esc).join(", "),
    c.country ? esc(c.country) : "",
    c.phone ? `Tel: ${esc(c.phone)}` : "",
    c.email ? `Email: ${esc(c.email)}` : "",
  ].filter(Boolean);
  return lines.join("<br>") || "<span class='muted'>—</span>";
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? esc(iso) : d.toISOString().slice(0, 10);
}

const SHARED_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: "Segoe UI", Arial, sans-serif; color: #111; font-size: 11px; }
  .page { width: 210mm; min-height: 297mm; padding: 12mm 12mm 14mm; margin: 0 auto; }
  .muted { color: #888; }
  h1, h2, h3 { margin: 0; }
  table { border-collapse: collapse; width: 100%; }
  .brand { font-size: 20px; font-weight: 800; letter-spacing: -0.5px; color: #0f2f6b; }
  .brand small { display:block; font-size: 10px; font-weight: 600; letter-spacing: 2px; color:#7a8aa5; }
  .doc-title { font-size: 15px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; }
  .box { border: 1px solid #333; padding: 6px 8px; }
  .box .lbl { font-size: 8px; text-transform: uppercase; letter-spacing: 0.5px; color:#555; font-weight:700; margin-bottom:3px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
  .grid2 > .box { border-right: 0; }
  .grid2 > .box:last-child { border-right: 1px solid #333; }
  .cargo th, .cargo td { border: 1px solid #333; padding: 4px 6px; text-align: left; vertical-align: top; }
  .cargo th { background: #f0f3f8; font-size: 8px; text-transform: uppercase; letter-spacing: 0.4px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .totrow td { font-weight: 700; background:#f7f9fc; }
  .barcode img { height: 46px; }
  .flags span { display:inline-block; border:1px solid #b45309; color:#b45309; border-radius:3px; padding:1px 6px; font-size:9px; margin-right:4px; text-transform:uppercase; }
  .sign { display:grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 18px; }
  .sign .line { border-top: 1px solid #333; padding-top: 3px; font-size: 9px; color:#555; margin-top:34px; }
  .foot { margin-top: 14px; font-size: 8px; color:#888; border-top: 1px solid #ddd; padding-top: 6px; }
`;

export function awbHtml(d: DocData, barcode: string): string {
  const rows = d.boxes.map((b, i) => {
    const goods = b.items.length
      ? b.items.map((it) => `${esc(it.description)} ×${it.quantity}${it.hsCode ? ` (HS ${esc(it.hsCode)})` : ""}`).join("<br>")
      : "<span class='muted'>—</span>";
    const dims = `${b.lengthCm}×${b.widthCm}×${b.heightCm} cm`;
    return `<tr>
      <td class="num">${i + 1}${b.label ? `<br><span class="muted">${esc(b.label)}</span>` : ""}</td>
      <td>${goods}<div class="muted">${dims}</div></td>
      <td class="num">${b.weightKg.toFixed(2)}</td>
      <td class="num">${b.volumetricKg.toFixed(2)}</td>
      <td class="num">${b.chargeableKg.toFixed(2)}</td>
    </tr>`;
  }).join("");

  const declared = d.declaredValue != null ? `${d.declaredValue.toFixed(2)} ${esc(d.currency ?? "")}` : "NVD";

  return `<!doctype html><html><head><meta charset="utf-8"><style>${SHARED_CSS}</style></head><body>
  <div class="page">
    <!-- header: brand left, AWB number + barcode right (standard placement) -->
    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px;">
      <div>
        <div class="brand">PREP MAX<small>LOGISTICS</small></div>
        <div class="muted" style="margin-top:2px;">${esc(d.branchName)} · ${esc(d.branchCity)}</div>
      </div>
      <div style="text-align:right;">
        <div class="doc-title">Air Waybill</div>
        <div style="margin-top:2px;">AWB No: <strong>${esc(d.awbNumber ?? "—")}</strong></div>
        <div>Tracking: <strong>${esc(d.trackingCode)}</strong></div>
        <div class="barcode" style="margin-top:4px;"><img src="${barcode}" alt="barcode"></div>
      </div>
    </div>

    <!-- shipper / consignee -->
    <div class="grid2" style="margin-bottom:8px;">
      <div class="box"><div class="lbl">Shipper (Sender)</div>${contactBlock(d.sender)}</div>
      <div class="box"><div class="lbl">Consignee (Receiver)</div>${contactBlock(d.receiver)}</div>
    </div>

    <!-- routing / service -->
    <div class="grid2" style="margin-bottom:8px;">
      <div class="box"><div class="lbl">Origin</div>${esc([d.sender.city, d.sender.country].filter(Boolean).join(", ") || "—")}</div>
      <div class="box"><div class="lbl">Destination</div>${esc([d.receiver.city, d.receiver.country].filter(Boolean).join(", ") || "—")}</div>
    </div>
    <div class="grid2" style="margin-bottom:8px;">
      <div class="box"><div class="lbl">Service Type</div>${esc(d.serviceType ?? "—")}</div>
      <div class="box"><div class="lbl">Nature of Contents</div>${esc(d.contentsNature ?? "—")}</div>
    </div>

    <!-- cargo table -->
    <div class="lbl" style="margin:6px 0 3px; font-size:8px; text-transform:uppercase; color:#555; font-weight:700;">Nature &amp; Quantity of Goods</div>
    <table class="cargo">
      <thead><tr>
        <th style="width:12%">Piece</th>
        <th>Description of goods (dimensions)</th>
        <th style="width:14%" class="num">Gross wt (kg)</th>
        <th style="width:14%" class="num">Volumetric (kg)</th>
        <th style="width:14%" class="num">Chargeable (kg)</th>
      </tr></thead>
      <tbody>
        ${rows}
        <tr class="totrow">
          <td class="num">${d.pieceCount}</td>
          <td>Total</td>
          <td class="num">${d.totalGrossKg.toFixed(2)}</td>
          <td class="num"></td>
          <td class="num">${d.totalChargeableKg.toFixed(2)}</td>
        </tr>
      </tbody>
    </table>

    <!-- declared value / duties / handling -->
    <div class="grid2" style="margin-top:8px;">
      <div class="box"><div class="lbl">Declared Value for Customs</div>${esc(declared)}</div>
      <div class="box"><div class="lbl">Duties &amp; Taxes</div>${esc(d.duties ?? "—")}</div>
    </div>
    <div class="box" style="border-top:0; margin-bottom:8px;">
      <div class="lbl">Handling Information</div>
      ${d.handlingFlags.length ? `<div class="flags">${d.handlingFlags.map((f) => `<span>${esc(f)}</span>`).join("")}</div>` : "<span class='muted'>None</span>"}
      ${d.notes ? `<div style="margin-top:4px;">${esc(d.notes)}</div>` : ""}
    </div>

    <!-- signatures / execution -->
    <div class="sign">
      <div><div class="line">Signature of Shipper or Agent</div></div>
      <div><div class="line">Signature of Issuing Carrier / Date · Place of Execution: ${esc(d.branchCity)} · ${fmtDate(d.createdAt)}</div></div>
    </div>

    <div class="foot">
      This air waybill is issued by Prep Max Logistics as a contract of carriage. Tracking: ${esc(d.trackingCode)}.
      Generated ${fmtDate(new Date().toISOString())}.
    </div>
  </div>
  </body></html>`;
}

export function receiptHtml(d: DocData, barcode: string): string {
  const pkgRows = d.boxes.map((b, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td>${b.items.length ? b.items.map((it) => `${esc(it.description)} ×${it.quantity}`).join(", ") : "<span class='muted'>—</span>"}</td>
      <td class="num">${b.weightKg.toFixed(2)}</td>
      <td class="num">${b.lengthCm}×${b.widthCm}×${b.heightCm}</td>
      <td class="num">${b.chargeableKg.toFixed(2)}</td>
    </tr>`).join("");

  const declared = d.declaredValue != null ? `${d.declaredValue.toFixed(2)} ${esc(d.currency ?? "")}` : "—";

  return `<!doctype html><html><head><meta charset="utf-8"><style>${SHARED_CSS}
    .kv { display:grid; grid-template-columns: max-content 1fr; gap: 2px 12px; }
    .kv .k { color:#555; }
  </style></head><body>
  <div class="page">
    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px; border-bottom:2px solid #0f2f6b; padding-bottom:10px;">
      <div>
        <div class="brand">PREP MAX<small>LOGISTICS</small></div>
        <div class="muted" style="margin-top:2px;">${esc(d.branchName)} · ${esc(d.branchCity)}</div>
      </div>
      <div style="text-align:right;">
        <div class="doc-title">Shipping Receipt</div>
        <div class="muted" style="margin-top:2px;">Date: ${fmtDate(d.createdAt)}</div>
        <div class="barcode" style="margin-top:6px;"><img src="${barcode}" alt="barcode"></div>
      </div>
    </div>

    <div class="grid2" style="margin-bottom:10px;">
      <div class="box" style="border-right:1px solid #333;"><div class="lbl">From (Sender)</div>${contactBlock(d.sender)}</div>
      <div class="box"><div class="lbl">To (Receiver)</div>${contactBlock(d.receiver)}</div>
    </div>

    <div class="box" style="margin-bottom:10px;">
      <div class="kv">
        <div class="k">Tracking number</div><div><strong>${esc(d.trackingCode)}</strong></div>
        <div class="k">Service type</div><div>${esc(d.serviceType ?? "—")}</div>
        <div class="k">Contents</div><div>${esc(d.contentsNature ?? "—")}</div>
        <div class="k">Declared value</div><div>${esc(declared)}</div>
        <div class="k">Pieces</div><div>${d.pieceCount}</div>
        <div class="k">Total chargeable weight</div><div><strong>${d.totalChargeableKg.toFixed(2)} kg</strong></div>
      </div>
    </div>

    <div class="lbl" style="margin:6px 0 3px; font-size:8px; text-transform:uppercase; color:#555; font-weight:700;">Package details</div>
    <table class="cargo">
      <thead><tr>
        <th style="width:10%">#</th><th>Contents</th>
        <th style="width:14%" class="num">Weight (kg)</th>
        <th style="width:20%" class="num">Dimensions (cm)</th>
        <th style="width:16%" class="num">Chargeable (kg)</th>
      </tr></thead>
      <tbody>${pkgRows}
        <tr class="totrow"><td class="num">${d.pieceCount}</td><td>Total</td>
          <td class="num">${d.totalGrossKg.toFixed(2)}</td><td></td>
          <td class="num">${d.totalChargeableKg.toFixed(2)}</td></tr>
      </tbody>
    </table>

    <div style="margin-top:12px; padding:8px 10px; background:#f0f3f8; border-radius:4px;">
      Track your shipment anytime at Prep Max Logistics using tracking number <strong>${esc(d.trackingCode)}</strong>.
    </div>

    <div class="foot">
      Thank you for shipping with Prep Max Logistics. This receipt confirms your booking${d.notes ? ` · Note: ${esc(d.notes)}` : ""}.
    </div>
  </div>
  </body></html>`;
}
