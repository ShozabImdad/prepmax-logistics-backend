// Phase 4 live tracking verification (needs server on :4000 + seed super-admin).
// Creates an order, attaches a REAL carrier leg, syncs, and verifies events +
// cached status land in the DB via the API. Tests APX (plain-HTTP + handoff to
// DPD) and one browser carrier (DHL).
//
//   terminal A: npm run dev
//   terminal B: node tests/phase4-tracking.mjs

const BASE = "http://localhost:4000";
let pass = 0, fail = 0;
const ck = (n, c, x = "") => { c ? (pass++, console.log("  OK  " + n)) : (fail++, console.log("  FAIL " + n + " " + x)); };
function jar() { let c = ""; return { async fetch(p, o = {}) { const h = { ...(o.headers || {}) }; if (c) h.cookie = c; if (o.body) h["content-type"] = "application/json"; const r = await fetch(BASE + p, { ...o, headers: h }); const sc = r.headers.get("set-cookie"); if (sc) c = sc.split(";")[0]; let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; } }; }

const su = jar();
await su.fetch("/api/auth/staff/login", { method: "POST", body: JSON.stringify({ email: "admin@prepmax.local", password: "ChangeMe123!" }) });
const b = await su.fetch("/api/accounts/branches", { method: "POST", body: JSON.stringify({ name: "Track Branch " + Date.now(), city: "T" }) });
const branchPublicId = b.body.branch.public_id;

async function newOrder() {
  const r = await su.fetch("/api/orders", {
    method: "POST",
    body: JSON.stringify({ branchPublicId, sender: { name: "S" }, receiver: { name: "R", city: "X" },
      boxes: [{ weightKg: 1, lengthCm: 10, widthCm: 10, heightCm: 10, items: [] }] }),
  });
  return r.body.order.publicId;
}

// ── APX (plain-HTTP) + handoff to DPD ───────────────────────────────────────
console.log("\n=== APX tracking + handoff ===");
const apxOrder = await newOrder();
let r = await su.fetch(`/api/orders/${apxOrder}/legs`, { method: "POST", body: JSON.stringify({ legs: [{ carrier: "smartcargo-apx", trackingNumber: "1350228267" }] }) });
ck("attach APX leg", r.status === 200);

r = await su.fetch(`/api/orders/${apxOrder}/sync`, { method: "POST" });
ck("sync APX returns synced", r.body?.result?.status === "synced", JSON.stringify(r.body?.result));
ck("APX produced events", (r.body?.result?.newEvents ?? 0) > 0, "events=" + r.body?.result?.newEvents);
ck("APX handoff auto-created DPD leg", r.body?.result?.handoffCreated === "dpd", JSON.stringify(r.body?.result?.handoffCreated));

// detail should now show cached status + events + 2 legs
r = await su.fetch(`/api/orders/${apxOrder}`);
const o = r.body.order;
ck("cached current_status set", typeof o.currentStatus === "string" && o.currentStatus.length > 0, o.currentStatus);
ck("tracking events persisted", (o.trackingEvents?.length ?? 0) > 0, "count=" + o.trackingEvents?.length);
ck("2 legs after handoff", o.legs?.length === 2, JSON.stringify(o.legs?.map(l => l.carrier)));
ck("DPD leg is now active", o.legs?.find(l => l.carrier === "dpd")?.isActive === true);

// ── dedupe: sync again, should add 0 new events for the same leg data ───────
console.log("\n=== Idempotent re-sync (dedupe) ===");
const before = (await su.fetch(`/api/orders/${apxOrder}`)).body.order.trackingEvents.length;
// re-sync the ACTIVE (now DPD) leg
r = await su.fetch(`/api/orders/${apxOrder}/sync`, { method: "POST" });
const dpdSync = r.body?.result;
ck("re-sync now tracks DPD (active leg)", dpdSync?.carrier === "dpd", JSON.stringify(dpdSync?.carrier));
// sync APX order once more; DPD events shouldn't duplicate
r = await su.fetch(`/api/orders/${apxOrder}/sync`, { method: "POST" });
ck("second DPD sync adds 0 new events (dedupe)", r.body?.result?.newEvents === 0, "newEvents=" + r.body?.result?.newEvents);

// ── DHL (browser carrier) ───────────────────────────────────────────────────
console.log("\n=== DHL (browser carrier) ===");
const dhlOrder = await newOrder();
r = await su.fetch(`/api/orders/${dhlOrder}/legs`, { method: "POST", body: JSON.stringify({ legs: [{ carrier: "dhl", trackingNumber: "3282304281" }] }) });
ck("attach DHL leg", r.status === 200);
r = await su.fetch(`/api/orders/${dhlOrder}/sync`, { method: "POST" });
ck("DHL sync succeeds", r.body?.result?.status === "synced", JSON.stringify(r.body?.result));
ck("DHL produced events", (r.body?.result?.newEvents ?? 0) > 0, "events=" + r.body?.result?.newEvents);
r = await su.fetch(`/api/orders/${dhlOrder}`);
ck("DHL cached status = delivered", r.body.order.currentStatus === "delivered", r.body.order.currentStatus);
ck("DHL order_status flipped to delivered", r.body.order.orderStatus === "delivered", r.body.order.orderStatus);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
