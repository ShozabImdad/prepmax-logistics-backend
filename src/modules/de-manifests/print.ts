// De-Manifest print — receiving/reconciliation PDF (header + shipment table
// with condition & reconciliation status), per the same house pattern as
// modules/manifest/print.ts. PDF only — no CSV/Excel export for de-manifests.

import type { DeManifestRow, DeManifestShipmentRow } from "./queries.js";
import { barcodeDataUri } from "../documents/barcode.js";
import { htmlToPdf } from "../documents/pdf.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as XLSX from "xlsx";

// ============================================================================
// LOGO PRE-LOADING — identical approach to documents/templates.js and
// manifest/print.js, kept as its own copy since these modules don't share a
// template layer.
// ============================================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  if (!chosen) return "";
  try {
    return `data:image/png;base64,${fs.readFileSync(chosen).toString("base64")}`;
  } catch (error) {
    console.error("Failed to load logo image:", error);
    return "";
  }
}

const logoDataUri = loadLogoDataUri();

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]!),
  );
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? esc(iso) : d.toISOString().slice(0, 10);
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? esc(iso) : d.toISOString().slice(0, 16).replace("T", " ");
}

const SHARED_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: "Segoe UI", Arial, sans-serif; color: #111; font-size: 11px; }
  .page { width: 210mm; min-height: 297mm; padding: 12mm; margin: 0 auto; }
  .muted { color: #888; }
  table { border-collapse: collapse; width: 100%; }
  .brand img { display: block; height: 42px; width: auto; object-fit: contain; }
  .brand-text { font-size: 20px; font-weight: 800; letter-spacing: -0.5px; color: #0f2f6b; }
  .brand-text small { display:block; font-size: 10px; font-weight: 600; letter-spacing: 2px; color:#7a8aa5; }
  .doc-title { font-size: 15px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; }
  .box { border: 1px solid #333; padding: 6px 8px; }
  .box .lbl { font-size: 8px; text-transform: uppercase; letter-spacing: 0.5px; color:#555; font-weight:700; margin-bottom:3px; }
  .kv { display:grid; grid-template-columns: max-content 1fr; gap: 2px 12px; }
  .kv .k { color:#555; }
  .cargo th, .cargo td { border: 1px solid #333; padding: 4px 6px; text-align: left; vertical-align: top; }
  .cargo th { background: #f0f3f8; font-size: 8px; text-transform: uppercase; letter-spacing: 0.4px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .totrow td { font-weight: 700; background:#f7f9fc; }
  .barcode img { height: 46px; }
  .status-pill { display:inline-block; border:1px solid #0f2f6b; color:#0f2f6b; border-radius:3px; padding:1px 8px; font-size:9px; text-transform:uppercase; font-weight:700; }
  .recon-pill { display:inline-block; border-radius:3px; padding:1px 6px; font-size:8px; text-transform:uppercase; font-weight:700; }
  .recon-received { background:#e6f6ec; color:#0a7a3d; }
  .recon-missing  { background:#fdecec; color:#b3261e; }
  .recon-extra    { background:#fff4e0; color:#8a5a00; }
  .recon-pending  { background:#eef0f3; color:#555; }
  .recon-hold     { background:#e8f0fe; color:#1a4fb0; }
  .stats { display:flex; gap:8px; margin-bottom:10px; }
  .stats .stat { flex:1; border:1px solid #333; padding:6px 8px; text-align:center; }
  .stats .stat .n { font-size:15px; font-weight:800; }
  .stats .stat .l { font-size:7px; text-transform:uppercase; letter-spacing:0.4px; color:#666; margin-top:2px; }
  .foot { margin-top: 14px; font-size: 8px; color:#888; border-top: 1px solid #ddd; padding-top: 6px; }
`;

function reconClass(v: string): string {
  return `recon-pill recon-${v}`;
}

/** Render the de-manifest header + shipment table to A4 HTML, ready for htmlToPdf. */
export function deManifestHtml(
  m: DeManifestRow & { shipments: DeManifestShipmentRow[] },
  barcode: string,
): string {
  const rows = m.shipments.length
    ? m.shipments
        .map(
          (s, i) => `<tr>
            <td class="num">${i + 1}</td>
            <td>${esc(s.scannedTracking)}</td>
            <td>${esc(s.senderName ?? "—")}</td>
            <td>${esc(s.receiverName ?? "—")}</td>
            <td>${esc(s.destination ?? "—")}</td>
            <td>${fmtDateTime(s.receivedAt)}</td>
            <td>${esc(s.condition?.replace("_", " ") ?? "—")}</td>
            <td><span class="${reconClass(s.reconciliation)}">${esc(s.reconciliation)}</span></td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="8" class="muted" style="text-align:center;">No shipments scanned</td></tr>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>${SHARED_CSS}</style></head><body>
  <div class="page">
    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px; border-bottom:2px solid #0f2f6b; padding-bottom:10px;">
      <div>
        <div class="brand">
          ${logoDataUri ? `<img src="${logoDataUri}" alt="Prep Max Logistics">` : `<div class="brand-text">PREP MAX<small>LOGISTICS</small></div>`}
        </div>
        <div class="muted" style="margin-top:4px;">Inbound De-Manifest (Receiving)</div>
      </div>
      <div style="text-align:right;">
        <div class="doc-title">${esc(m.deManifestNo)}</div>
        <div class="muted" style="margin-top:2px;"><span class="status-pill">${esc(m.status)}</span></div>
        <div class="barcode" style="margin-top:6px; display:flex; justify-content:flex-end;"><img src="${barcode}" alt="barcode"></div>
      </div>
    </div>

    <div class="box" style="margin-bottom:10px;">
      <div class="kv">
        <div class="k">De-manifest date</div><div>${fmtDate(m.deManifestDate)}</div>
        <div class="k">Vendor / Carrier</div><div>${esc(m.vendorName ?? m.courierName ?? "—")}</div>
        ${m.sourceManifestNo ? `<div class="k">Reconciling against</div><div>${esc(m.sourceManifestNo)}</div>` : ""}
        ${m.completedAt ? `<div class="k">Completed at</div><div>${fmtDateTime(m.completedAt)}</div>` : ""}
        ${m.remarks ? `<div class="k">Remarks</div><div>${esc(m.remarks)}</div>` : ""}
      </div>
    </div>

    <div class="stats">
      <div class="stat"><div class="n">${m.totalExpected}</div><div class="l">Expected</div></div>
      <div class="stat"><div class="n">${m.totalReceived}</div><div class="l">Received</div></div>
      <div class="stat"><div class="n">${m.totalMissing}</div><div class="l">Missing</div></div>
      <div class="stat"><div class="n">${m.totalExtra}</div><div class="l">Extra</div></div>
      <div class="stat"><div class="n">${m.totalDamaged}</div><div class="l">Damaged</div></div>
    </div>

    <table class="cargo">
      <thead><tr>
        <th style="width:4%">#</th>
        <th style="width:13%">Tracking</th>
        <th style="width:14%">Sender</th>
        <th style="width:14%">Receiver</th>
        <th style="width:16%">Destination</th>
        <th style="width:13%">Received at</th>
        <th style="width:11%">Condition</th>
        <th style="width:11%">Reconciliation</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="foot">
      Issued by Prep Max Logistics · Generated ${fmtDate(new Date().toISOString())} · De-Manifest ${esc(m.deManifestNo)} · ${m.shipments.length} row(s).
    </div>
  </div>
  </body></html>`;
}

/** Render the de-manifest to a PDF buffer (barcode of the de-manifest number). */
export async function deManifestPdf(
  m: DeManifestRow & { shipments: DeManifestShipmentRow[] },
): Promise<Buffer> {
  const barcode = await barcodeDataUri(m.deManifestNo);
  return htmlToPdf(deManifestHtml(m, barcode));
}

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Render the shipment list as CSV — same fallback pattern as manifestShipmentsCsv. */
export function deManifestShipmentsCsv(m: DeManifestRow & { shipments: DeManifestShipmentRow[] }): string {
  const header = [
    "Tracking Code", "Sender", "Receiver", "Destination",
    "Received At", "Condition", "Reconciliation", "Remarks",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const s of m.shipments) {
    lines.push(
      [
        s.scannedTracking, s.senderName ?? "", s.receiverName ?? "", s.destination ?? "",
        s.receivedAt ?? "", s.condition ?? "", s.reconciliation, s.remarks ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\r\n");
}

export function deManifestShipmentsExcel(m: DeManifestRow & { shipments: DeManifestShipmentRow[] }): Buffer {
  const header = [
    "Tracking Code", "Sender", "Receiver", "Destination",
    "Received At", "Condition", "Reconciliation", "Remarks",
  ];
  const rows = m.shipments.map((s) => [
    s.scannedTracking,
    s.senderName ?? "",
    s.receiverName ?? "",
    s.destination ?? "",
    s.receivedAt ?? "",
    s.condition ?? "",
    s.reconciliation,
    s.remarks ?? "",
  ]);

  const sheetData = [header, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(sheetData);

  // reasonable column widths, mirrors the CSV column order
  ws["!cols"] = [
    { wch: 16 }, { wch: 20 }, { wch: 20 }, { wch: 22 },
    { wch: 18 }, { wch: 12 }, { wch: 14 }, { wch: 24 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Shipments");

  // small summary sheet — mirrors the PDF header block + stat counts
  const summary = [
    ["De-Manifest No", m.deManifestNo],
    ["De-Manifest Date", m.deManifestDate],
    ["Vendor / Carrier", m.vendorName ?? m.courierName ?? "—"],
    ["Status", m.status],
    ["Reconciling Against", m.sourceManifestNo ?? "—"],
    ["Total Expected", m.totalExpected],
    ["Total Received", m.totalReceived],
    ["Total Missing", m.totalMissing],
    ["Total Extra", m.totalExtra],
    ["Total Damaged", m.totalDamaged],
    ["Completed At", m.completedAt ?? "—"],
  ];
  const summaryWs = XLSX.utils.aoa_to_sheet(summary);
  summaryWs["!cols"] = [{ wch: 20 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(wb, summaryWs, "Summary");

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}