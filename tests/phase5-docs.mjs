// Phase 5 verification: generate real AWB + receipt PDFs and validate them.
// Needs server on :4000 + seed super-admin.
import { writeFileSync } from "node:fs";

const BASE = "http://localhost:4000";
let pass = 0, fail = 0;
const ck = (n, c, x = "") => { c ? (pass++, console.log("  OK  " + n)) : (fail++, console.log("  FAIL " + n + " " + x)); };
function jar() { let c = ""; return { async fetch(p, o = {}) { const h = { ...(o.headers || {}) }; if (c) h.cookie = c; if (o.body) h["content-type"] = "application/json"; const r = await fetch(BASE + p, { ...o, headers: h }); const sc = r.headers.get("set-cookie"); if (sc) c = sc.split(";")[0]; return r; }, async json(p, o) { const r = await this.fetch(p, o); try { return { status: r.status, body: await r.json() }; } catch { return { status: r.status, body: null }; } } }; }

const su = jar();
await su.json("/api/auth/staff/login", { method: "POST", body: JSON.stringify({ email: "admin@prepmax.local", password: "ChangeMe123!" }) });
const b = await su.json("/api/accounts/branches", { method: "POST", body: JSON.stringify({ name: "Docs Branch " + Date.now(), city: "Islamabad" }) });
const branchPublicId = b.body.branch.public_id;

// rich order
const order = {
  branchPublicId,
  sender: { name: "MR ALI RAZA", company: "Raza Traders", phone: "+92 300 1234567", email: "ali@raza.pk",
            address: "House 12, Blue Area", city: "Islamabad", country: "Pakistan", postcode: "44000" },
  receiver: { name: "EZYCOMMERCE LTD", phone: "+44 24 7699 0000", email: "ops@ezy.co.uk",
              address: "Unit 5, Westwood Business Park", city: "Coventry", country: "United Kingdom", postcode: "CV5 9PF" },
  serviceType: "Express Air", contentsNature: "merchandise", declaredValue: 1250.50, currency: "GBP",
  duties: "DTU", handlingFlags: ["fragile", "keep dry"], notes: "Do not stack. Signature required.",
  boxes: [
    { label: "Carton 1", weightKg: 5, lengthCm: 40, widthCm: 30, heightCm: 30,
      items: [{ description: "Cotton shirts", quantity: 20, unitValue: 15, hsCode: "6205", countryOfOrigin: "PK" },
              { description: "Leather belts", quantity: 10, unitValue: 8, hsCode: "4203" }] },
    { label: "Carton 2", weightKg: 12, lengthCm: 50, widthCm: 40, heightCm: 35,
      items: [{ description: "Ceramic mugs", quantity: 24, unitValue: 3, hsCode: "6912", countryOfOrigin: "PK" }] },
  ],
};
const r = await su.json("/api/orders", { method: "POST", body: JSON.stringify(order) });
ck("order created", r.status === 201, JSON.stringify(r.body));
const pid = r.body.order.publicId;
const tracking = r.body.order.trackingCode;
console.log("  tracking code:", tracking);

// ── AWB PDF ─────────────────────────────────────────────────────────────────
let res = await su.fetch(`/api/orders/${pid}/awb.pdf`);
ck("AWB responds 200", res.status === 200, "status " + res.status);
ck("AWB content-type is application/pdf", res.headers.get("content-type") === "application/pdf");
const awbBuf = Buffer.from(await res.arrayBuffer());
ck("AWB is a real PDF (%PDF header)", awbBuf.subarray(0, 5).toString() === "%PDF-", awbBuf.subarray(0,8).toString());
ck("AWB has reasonable size (>10KB)", awbBuf.length > 10_000, awbBuf.length + " bytes");
writeFileSync("tests/out-awb.pdf", awbBuf);

// ── Receipt PDF ─────────────────────────────────────────────────────────────
res = await su.fetch(`/api/orders/${pid}/receipt.pdf`);
ck("Receipt responds 200", res.status === 200);
const rcBuf = Buffer.from(await res.arrayBuffer());
ck("Receipt is a real PDF", rcBuf.subarray(0, 5).toString() === "%PDF-");
ck("Receipt has reasonable size", rcBuf.length > 10_000, rcBuf.length + " bytes");
writeFileSync("tests/out-receipt.pdf", rcBuf);

// ── permission + isolation ──────────────────────────────────────────────────
// manager in a DIFFERENT branch cannot fetch this AWB
const b2 = await su.json("/api/accounts/branches", { method: "POST", body: JSON.stringify({ name: "Other " + Date.now(), city: "X" }) });
const me = `docs-mgr-${Date.now()}@x.com`;
await su.json("/api/accounts/managers", { method: "POST", body: JSON.stringify({ email: me, password: "MgrPass123!", fullName: "M", branchPublicId: b2.body.branch.public_id }) });
const mgr = jar();
await mgr.json("/api/auth/staff/login", { method: "POST", body: JSON.stringify({ email: me, password: "MgrPass123!" }) });
res = await mgr.fetch(`/api/orders/${pid}/awb.pdf`);
ck("other-branch manager cannot fetch AWB (404)", res.status === 404, "status " + res.status);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
console.log("PDFs written: tests/out-awb.pdf, tests/out-receipt.pdf");
process.exit(fail === 0 ? 0 : 1);
