// HTML templates for the air waybill and receipt, rendered to A4 PDF.
import type { DocData, DocContact } from "./data.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ============================================================================
// LOGO PRE-LOADING (Converts image to safe Base64 string for Chromium)
// ============================================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Candidate locations for the logo, checked in order. process.cwd()-based
// paths cover "started from project root" (most deploys, e.g. `node
// dist/index.js` run from the repo root). __dirname-based paths cover cases
// where cwd isn't the project root (e.g. some PM2/serverless setups) by
// walking up from wherever this compiled file actually sits.
function resolveAssetPath(filename: string): string | null {
  const candidates = [
    path.join(process.cwd(), "src", "public", filename),
    path.join(process.cwd(), "public", filename),
    path.join(__dirname, "..", "public", filename),
    path.join(__dirname, "..", "..", "src", "public", filename),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function loadLogoDataUri(): string {
  const primary = resolveAssetPath("logo.png");
  const fallback = resolveAssetPath("logo-alt.png");
  const chosen = primary ?? fallback;

  if (!chosen) {
    console.warn("Logo file not found (checked logo.png and logo-alt.png), falling back to text typography.");
    return "";
  }

  try {
    const fileBuffer = fs.readFileSync(chosen);
    return `data:image/png;base64,${fileBuffer.toString("base64")}`;
  } catch (error) {
    console.error("Failed to load logo image:", error);
    return "";
  }
}

const logoDataUri = loadLogoDataUri();

// ============================================================================
// HELPERS
// ============================================================================
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

function addressLines(c: DocContact): string {
  const rows: string[] = [];
  if (c.address) rows.push(`<div><b>ADD:</b> ${esc(c.address)}</div>`);
  if (c.address2) rows.push(`<div><b>ADD 2:</b> ${esc(c.address2)}</div>`);
  const meta = [
    c.city ? `<b>CITY:</b> ${esc(c.city)}` : "",
    c.state ? `<b>STATE:</b> ${esc(c.state)}` : "",
    c.country ? `<b>COUNTRY:</b> ${esc(c.country)}` : "",
    c.postcode ? `<b>ZIP:</b> ${esc(c.postcode)}` : "",
  ].filter(Boolean);
  if (meta.length) rows.push(`<div class="addr-meta">${meta.join(" &nbsp; ")}</div>`);
  if (c.phone) rows.push(`<div><b>TEL:</b> ${esc(c.phone)}</div>`);
  if (c.cnic) rows.push(`<div><b>CNIC:</b> ${esc(c.cnic)}</div>`);
  if (c.ntn) rows.push(`<div><b>NTN:</b> ${esc(c.ntn)}</div>`);
  return rows.join("");
}

// ============================================================================
// CORE CSS STYLE STACK
// ============================================================================
const SHARED_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: "Segoe UI", Arial, sans-serif; color: #111; font-size: 11px; }
  .page { width: 210mm; min-height: 297mm; padding: 12mm 12mm 14mm; margin: 0 auto; }
  .muted { color: #888; }
  h1, h2, h3 { margin: 0; }
  table { border-collapse: collapse; width: 100%; }
  .brand img { display: block; height: 42px; width: auto; object-fit: contain; }
  .brand-text { font-size: 20px; font-weight: 800; letter-spacing: -0.5px; color: #0f2f6b; }
  .brand-text small { display:block; font-size: 10px; font-weight: 600; letter-spacing: 2px; color:#7a8aa5; }
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

// ============================================================================
// TEMPLATE 1: AIR WAYBILL (AWB)
// ============================================================================
export function awbHtml(d: DocData, barcode: string): string {
  const itemRows = d.boxes
    .flatMap((b) => b.items.map((it) => ({ description: it.description, quantity: it.quantity, value: (it.unitValue ?? 0) * (it.quantity ?? 1) })))
    .filter((r) => r.description);
  const goodsRows = (itemRows.length ? itemRows : [{ description: "—", quantity: 0, value: 0 }])
    .map((r) => `<tr>
      <td>${esc(r.description)}</td>
      <td class="num">${r.quantity}</td>
      <td class="num">$ ${r.value.toFixed(2)}</td>
    </tr>`).join("");
  const totalValue = itemRows.reduce((s, r) => s + r.value, 0);
  const shipDate = fmtDate(d.createdAt);
  const cnic = d.sender.cnic || "—";
  const origin = d.sender.country || "Pakistan";

  return `<!doctype html><html><head><meta charset="utf-8"><style>${SHARED_CSS}
    .inv { border: 1.5px solid #000; }
    .inv .title { text-align:center; font-weight:800; letter-spacing:0.6px; font-size:13px; padding:7px 4px; border-bottom:1.5px solid #000; }
    .inv .r { display:flex; }
    .inv .r > div { padding:4px 6px; }
    .inv .bb { border-bottom:1px solid #000; }
    .inv .br { border-right:1px solid #000; }
    .inv .lbl2 { font-weight:800; text-transform:uppercase; font-size:9px; margin-bottom:2px; }
    .inv .kv b { font-weight:800; }
    .addr-meta { margin-top:1px; }
    .gtable th, .gtable td { border:1px solid #000; padding:3px 6px; }
    .gtable th { background:#f0f0f0; text-align:center; text-transform:uppercase; font-size:9px; }
    .undertaking { font-size:9.5px; line-height:1.35; padding:6px; }
    .sig2 { display:flex; gap:24px; padding:10px 8px; }
    .sig2 > div { flex:1; }
    .sig2 .ln { border-bottom:1px solid #000; height:20px; }
    .sig2 .cap { text-align:center; font-weight:700; font-size:9px; margin-top:3px; }
  </style></head><body>
  <div class="page">
    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px;">
      <div>
        <div class="brand">
          ${logoDataUri ? `<img src="${logoDataUri}" alt="Prep Max Logistics">` : `<div class="brand-text">PREP MAX<small>LOGISTICS</small></div>`}
        </div>
        <div class="muted" style="margin-top:4px;">${esc(d.branchName)} · ${esc(d.branchCity)}</div>
      </div>
      <div style="text-align:right;">
        <div>Tracking: <strong>${esc(d.trackingCode)}</strong></div>
        <div class="barcode" style="margin-top:4px;"><img src="${barcode}" alt="barcode"></div>
      </div>
    </div>

    <div class="inv">
      <div class="title">PROFORMA INVOICE &amp; UNDERTAKING</div>
      <div class="r bb">
        <div class="br" style="flex:8;">
          <div class="lbl2">Shipper</div>
          <div class="kv"><b>Name:</b> <strong>${esc(d.sender.name ?? "—")}</strong></div>
          ${addressLines(d.sender)}
        </div>
        <div style="flex:4;">
          <div class="kv"><b>Ship Date:</b> ${shipDate}</div>
          <div class="kv"><b>AWB #:</b> ${esc(d.awbNumber ?? "—")}</div>
          <div class="kv"><b>Tracking:</b> ${esc(d.trackingCode)}</div>
        </div>
      </div>

      <div class="r bb">
        <div class="br" style="flex:8;">
          <div class="lbl2">Consignee</div>
          <div class="kv"><b>To:</b> <strong>${esc(d.receiver.company || d.receiver.name || "—")}</strong></div>
          ${addressLines(d.receiver)}
        </div>
        <div style="flex:4;">
          ${cnic !== "—" ? `<div class="kv"><b>CNIC:</b> ${esc(cnic)}</div>` : ""}
          <div class="kv"><b>Origin:</b> ${esc(origin)}</div>
          <div class="kv"><b>Service:</b> ${esc(d.serviceType ?? "—")}</div>
          <div class="kv"><b>Act Weight:</b> ${d.totalGrossKg.toFixed(2)} Kg</div>
          <div class="kv"><b>Chargeable:</b> ${d.totalChargeableKg.toFixed(2)} Kg</div>
          <div class="kv"><b>Pcs:</b> ${String(d.pieceCount).padStart(2, "0")}</div>
        </div>
      </div>

      <table class="gtable" style="border:0;">
        <thead><tr>
          <th style="width:64%">Goods Description</th>
          <th style="width:16%">Quantity</th>
          <th style="width:20%">Value ($)</th>
        </tr></thead>
        <tbody>
          ${goodsRows}
          <tr>
            <td style="text-align:center; font-weight:800; text-transform:uppercase;">Total Value</td>
            <td class="num"></td>
            <td class="num" style="font-weight:800;">$ ${totalValue.toFixed(2)}</td>
          </tr>
        </tbody>
      </table>

      <div class="bb" style="border-top:1px solid #000;">
        <div style="text-align:center; font-weight:800; text-decoration:underline; padding:5px;">TO WHOM IT MAY CONCERN</div>
      </div>
      <div class="undertaking">
        I, <b>${esc(d.sender.name ?? "the shipper")}</b>, hereby certify that this shipment
        having CNIC: <b>${esc(cnic)}</b>, Tracking No: <b>${esc(d.trackingCode)}</b>, dated:
        <b>${shipDate}</b> is for personal use only. Contents are dry goods. No drugs, narcotics,
         contraband items or any IATA restricted items are included. If any restricted items are
        discovered from this shipment, I shall be held responsible. I/We have read and agree that
        the Terms and Conditions of Carriage as stated on the Shipment Airway Bill apply to this
        shipment.
      </div>
      <div class="sig2">
        <div><div class="ln"></div><div class="cap">Shipper Signature</div></div>
        <div><div class="ln"></div><div class="cap">Thumb Impression</div></div>
      </div>
    </div>

    <div class="foot">
      Issued by Prep Max Logistics · ${esc(d.branchName)}, ${esc(d.branchCity)} · Place of Execution: ${esc(d.branchCity)} · Generated ${fmtDate(new Date().toISOString())}.
    </div>
  </div>
  </body></html>`;
}

// ============================================================================
// TEMPLATE 2: SHIPPING RECEIPT
// ============================================================================
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
        <div class="brand">
          ${logoDataUri ? `<img src="${logoDataUri}" alt="Prep Max Logistics">` : `<div class="brand-text">PREP MAX<small>LOGISTICS</small></div>`}
        </div>
        <div class="muted" style="margin-top:4px;">${esc(d.branchName)} · ${esc(d.branchCity)}</div>
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