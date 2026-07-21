// Manifest print/export — manifest PDF (header + shipment table + barcode)
// and a CSV shipment list, per ACCOUNTS_MANIFEST_DESIGN.md §2.2 "Print
// options: manifest PDF, shipment list, barcode/QR, export Excel".
//
// Excel export is deferred (open question Q4 in the design doc — CSV is
// the stated fallback "enough initially"); CSV opens directly in Excel and
// needs no new dependency. Barcode/PDF reuse the existing documents module
// helpers verbatim — no new libraries, matching the house pattern.

import type { ManifestRow, ManifestShipmentRow } from "./queries.js";
import { barcodeDataUri } from "../documents/barcode.js";
import { htmlToPdf } from "../documents/pdf.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as XLSX from "xlsx";
// ============================================================================
// LOGO PRE-LOADING — identical approach to documents/templates.js, kept as
// its own copy here since the two modules don't share a template layer.
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
  .foot { margin-top: 14px; font-size: 8px; color:#888; border-top: 1px solid #ddd; padding-top: 6px; }
`;

/** Render the manifest header + shipment table to A4 HTML, ready for htmlToPdf. */
export function manifestHtml(
  m: ManifestRow & { shipments: ManifestShipmentRow[] },
  barcode: string,
): string {
  const rows = m.shipments.length
    ? m.shipments
        .map(
          (s, i) => `<tr>
            <td class="num">${i + 1}</td>
            <td>${esc(s.trackingCode)}</td>
            <td>${esc(s.senderName ?? "—")}</td>
            <td>${esc(s.receiverName ?? "—")}</td>
            <td>${esc(s.destination ?? "—")}</td>
            <td class="num">${s.weightKg.toFixed(2)}</td>
            <td class="num">${s.charges.toFixed(2)} ${esc(s.currency)}</td>
            <td>${esc(s.orderStatus)}</td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="8" class="muted" style="text-align:center;">No shipments added</td></tr>`;

  const totalCharges = m.shipments.reduce((sum, s) => sum + s.charges, 0);

  return `<!doctype html><html><head><meta charset="utf-8"><style>${SHARED_CSS}</style></head><body>
  <div class="page">
    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px; border-bottom:2px solid #0f2f6b; padding-bottom:10px;">
      <div>
        <div class="brand">
          ${logoDataUri ? `<img src="${logoDataUri}" alt="Prep Max Logistics">` : `<div class="brand-text">PREP MAX<small>LOGISTICS</small></div>`}
        </div>
        <div class="muted" style="margin-top:4px;">Outbound Manifest</div>
      </div>
      <div style="text-align:right;">
        <div class="doc-title">${esc(m.manifestNo)}</div>
        <div class="muted" style="margin-top:2px;"><span class="status-pill">${esc(m.status)}</span></div>
        <div class="barcode" style="margin-top:6px; display:flex; justify-content:flex-end;"><img src="${barcode}" alt="barcode"></div>
      </div>
    </div>

    <div class="box" style="margin-bottom:10px;">
      <div class="kv">
        <div class="k">Manifest date</div><div>${fmtDate(m.manifestDate)}</div>
        <div class="k">Vendor / Carrier</div><div>${esc(m.vendorName ?? "—")}</div>
        <div class="k">Total shipments</div><div><strong>${m.totalShipments}</strong></div>
        <div class="k">Total weight</div><div><strong>${m.totalWeightKg.toFixed(2)} kg</strong></div>
        ${m.dispatchedAt ? `<div class="k">Dispatched at</div><div>${fmtDate(m.dispatchedAt)}</div>` : ""}
        ${m.notes ? `<div class="k">Notes</div><div>${esc(m.notes)}</div>` : ""}
      </div>
    </div>

    <table class="cargo">
      <thead><tr>
        <th style="width:4%">#</th>
        <th style="width:14%">Tracking</th>
        <th style="width:15%">Sender</th>
        <th style="width:15%">Receiver</th>
        <th style="width:17%">Destination</th>
        <th style="width:9%" class="num">Wt (kg)</th>
        <th style="width:12%" class="num">Charges</th>
        <th style="width:9%">Status</th>
      </tr></thead>
      <tbody>${rows}
        <tr class="totrow">
          <td colspan="5" class="num">Total</td>
          <td class="num">${m.totalWeightKg.toFixed(2)}</td>
          <td class="num">${totalCharges.toFixed(2)}</td>
          <td></td>
        </tr>
      </tbody>
    </table>

    <div class="foot">
      Issued by Prep Max Logistics · Generated ${fmtDate(new Date().toISOString())} · Manifest ${esc(m.manifestNo)} · ${m.totalShipments} shipment(s).
    </div>
  </div>
  </body></html>`;
}

/** Render the manifest to a PDF buffer (barcode of the manifest number). */
export async function manifestPdf(
  m: ManifestRow & { shipments: ManifestShipmentRow[] },
): Promise<Buffer> {
  const barcode = await barcodeDataUri(m.manifestNo);
  return htmlToPdf(manifestHtml(m, barcode));
}

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Render the shipment list as CSV — the "export Excel" fallback (Q4: CSV opens in Excel, no new dependency). */
export function manifestShipmentsCsv(m: ManifestRow & { shipments: ManifestShipmentRow[] }): string {
  const header = [
    "Tracking Code", "Sender", "Receiver", "Destination",
    "Weight (kg)", "Charges", "Currency", "Order Status",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const s of m.shipments) {
    lines.push(
      [
        s.trackingCode, s.senderName ?? "", s.receiverName ?? "", s.destination ?? "",
        s.weightKg.toFixed(2), s.charges.toFixed(2), s.currency, s.orderStatus,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\r\n");
}

export function manifestShipmentsExcel(m: ManifestRow & { shipments: ManifestShipmentRow[] }): Buffer {
  const header = [
    "Tracking Code", "Sender", "Receiver", "Destination",
    "Weight (kg)", "Charges", "Currency", "Order Status",
  ];
  const rows = m.shipments.map((s) => [
    s.trackingCode,
    s.senderName ?? "",
    s.receiverName ?? "",
    s.destination ?? "",
    Number(s.weightKg.toFixed(2)),
    Number(s.charges.toFixed(2)),
    s.currency,
    s.orderStatus,
  ]);

  const sheetData = [header, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(sheetData);

  // reasonable column widths, mirrors the CSV column order
  ws["!cols"] = [
    { wch: 16 }, { wch: 20 }, { wch: 20 }, { wch: 22 },
    { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 14 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Shipments");

  // small summary sheet — mirrors the PDF header block
  const summary = [
    ["Manifest No", m.manifestNo],
    ["Manifest Date", m.manifestDate],
    ["Vendor / Carrier", m.vendorName ?? "—"],
    ["Status", m.status],
    ["Total Shipments", m.totalShipments],
    ["Total Weight (kg)", m.totalWeightKg],
    ["Dispatched At", m.dispatchedAt ?? "—"],
  ];
  const summaryWs = XLSX.utils.aoa_to_sheet(summary);
  summaryWs["!cols"] = [{ wch: 18 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(wb, summaryWs, "Summary");

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}