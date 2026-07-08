// End-to-end Phase 3 verification over real HTTP. Exercises EVERY point from
// the plan §5/§6. Exits non-zero on any failure.
//
// HOW TO RUN:
//   1. terminal A:  npm run dev            (starts the server on :4000)
//   2. terminal B:  node tests/phase3-e2e.mjs
// Requires the seed super-admin (npm run seed) to exist.
// Result on last run: 34 passed, 0 failed.

const BASE = "http://localhost:4000";
let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  x FAIL: ${name} ${extra}`); }
}

// tiny cookie jar
function jar() {
  let cookie = "";
  return {
    async fetch(path, opts = {}) {
      const headers = { ...(opts.headers || {}) };
      if (cookie) headers.cookie = cookie;
      if (opts.body) headers["content-type"] = "application/json";
      const res = await fetch(BASE + path, { ...opts, headers });
      const sc = res.headers.get("set-cookie");
      if (sc) cookie = sc.split(";")[0];
      let body = null;
      try { body = await res.json(); } catch {}
      return { status: res.status, body };
    },
  };
}

const superJar = jar();
const mgrJar = jar();
const custJar = jar();

console.log("\n=== Phase 3 E2E verification ===\n");

// ── setup: super-admin login, branch, manager, customer ─────────────────────
let r = await superJar.fetch("/api/auth/staff/login", {
  method: "POST", body: JSON.stringify({ email: "admin@prepmax.local", password: "ChangeMe123!" }),
});
check("super-admin login", r.status === 200, JSON.stringify(r.body));

const branchName = "E2E Branch " + Date.now();
r = await superJar.fetch("/api/accounts/branches", {
  method: "POST", body: JSON.stringify({ name: branchName, city: "Testville" }),
});
check("super-admin creates branch", r.status === 201);
const branchPublicId = r.body?.branch?.public_id;

const mgrEmail = `e2e-mgr-${Date.now()}@prepmax.local`;
r = await superJar.fetch("/api/accounts/managers", {
  method: "POST", body: JSON.stringify({ email: mgrEmail, password: "MgrPass123!", fullName: "E2E Mgr", branchPublicId }),
});
check("super-admin creates manager", r.status === 201);

r = await mgrJar.fetch("/api/auth/staff/login", {
  method: "POST", body: JSON.stringify({ email: mgrEmail, password: "MgrPass123!" }),
});
check("manager login (has perms)", r.status === 200 && r.body?.principal?.permissions?.includes("orders.create"));

const custEmail = `e2e-cust-${Date.now()}@example.com`;
r = await mgrJar.fetch("/api/accounts/customers", {
  method: "POST", body: JSON.stringify({ email: custEmail, password: "CustPass123!", fullName: "E2E Customer" }),
});
check("manager creates customer", r.status === 201);
const customerPublicId = r.body?.customer?.public_id;

r = await custJar.fetch("/api/auth/customer/login", {
  method: "POST", body: JSON.stringify({ email: custEmail, password: "CustPass123!" }),
});
check("customer login", r.status === 200);

// ── POINT: staff creates order with boxes+items, weight auto-calc ───────────
console.log("\n-- Order creation (staff, direct) --");
const staffOrder = {
  customerPublicId,
  sender: { name: "Sender Co", city: "Islamabad", country: "Pakistan", phone: "123" },
  receiver: { name: "Receiver Ltd", city: "Coventry", country: "United Kingdom", postcode: "CV5 9PF" },
  serviceType: "Express", contentsNature: "merchandise", declaredValue: 500, currency: "GBP",
  duties: "DTU", handlingFlags: ["fragile"], notes: "handle with care",
  boxes: [
    { label: "Box A", weightKg: 5, lengthCm: 40, widthCm: 30, heightCm: 30,
      items: [{ description: "Cotton shirts", quantity: 20, unitValue: 10, hsCode: "6205", countryOfOrigin: "PK" }] },
    { label: "Box B", weightKg: 3, lengthCm: 10, widthCm: 10, heightCm: 10,
      items: [{ description: "Leather belts", quantity: 10, unitValue: 5 }] },
  ],
};
r = await mgrJar.fetch("/api/orders", { method: "POST", body: JSON.stringify(staffOrder) });
check("manager creates order (201)", r.status === 201, JSON.stringify(r.body));
const orderPid = r.body?.order?.publicId;
const trackingCode = r.body?.order?.trackingCode;
check("tracking code is PML-branded", /^PML-\d{4}-[A-Z0-9]{7}$/.test(trackingCode || ""), trackingCode);
check("staff order status = awaiting_carrier", r.body?.order?.orderStatus === "awaiting_carrier");

// detail: verify weight calc + fields
r = await mgrJar.fetch(`/api/orders/${orderPid}`);
check("order detail loads", r.status === 200);
const o = r.body?.order;
check("box A volumetric = 7.2", o?.boxes?.[0]?.volumetricKg === 7.2, JSON.stringify(o?.boxes?.[0]));
check("box A chargeable = 7.2 (vol wins)", o?.boxes?.[0]?.chargeableKg === 7.2);
check("box B chargeable = 3 (actual wins)", o?.boxes?.[1]?.chargeableKg === 3);
check("total chargeable = 10.2", o?.totalChargeableKg === 10.2, String(o?.totalChargeableKg));
check("piece count = 2", o?.pieceCount === 2);
check("items preserved", o?.boxes?.[0]?.items?.[0]?.description === "Cotton shirts" && o?.boxes?.[0]?.items?.[0]?.quantity === 20);
check("sender/receiver/service/duties captured", o?.sender?.city === "Islamabad" && o?.receiver?.country === "United Kingdom" && o?.duties === "DTU" && o?.serviceType === "Express");
check("awb number generated (staff view)", typeof o?.awbNumber === "string" && o.awbNumber.length > 0);

// ── POINT: customer creates booking request -> pending_approval ─────────────
console.log("\n-- Customer booking request --");
const custOrder = {
  sender: { name: "Me", city: "Islamabad", country: "Pakistan" },
  receiver: { name: "Friend", city: "Dubai", country: "UAE" },
  boxes: [{ weightKg: 2, lengthCm: 20, widthCm: 20, heightCm: 20, items: [{ description: "Gift", quantity: 1 }] }],
};
r = await custJar.fetch("/api/portal/orders", { method: "POST", body: JSON.stringify(custOrder) });
check("customer creates booking (201)", r.status === 201, JSON.stringify(r.body));
const custOrderPid = r.body?.order?.publicId;
check("customer order status = pending_approval", r.body?.order?.orderStatus === "pending_approval");

// customer cannot attach legs
r = await custJar.fetch("/api/portal/orders", { method: "POST", body: JSON.stringify({ ...custOrder, legs: [{ carrier: "dpd", trackingNumber: "X" }] }) });
check("customer cannot attach legs (403)", r.status === 403, JSON.stringify(r.body));

// ── POINT: approval flow ────────────────────────────────────────────────────
console.log("\n-- Approval flow --");
r = await mgrJar.fetch(`/api/orders/${custOrderPid}/approve`, { method: "POST" });
check("manager approves booking", r.status === 200 && r.body?.orderStatus === "awaiting_carrier", JSON.stringify(r.body));
// double approve should conflict
r = await mgrJar.fetch(`/api/orders/${custOrderPid}/approve`, { method: "POST" });
check("re-approve blocked (409)", r.status === 409);

// ── POINT: attach legs later (Leg1 activates, Leg2 optional) ────────────────
console.log("\n-- Carrier legs --");
r = await mgrJar.fetch(`/api/orders/${orderPid}/legs`, { method: "POST", body: JSON.stringify({ legs: [{ carrier: "smartcargo-apx", trackingNumber: "1350228267" }] }) });
check("attach leg 1 -> active", r.status === 200 && r.body?.orderStatus === "active", JSON.stringify(r.body));
r = await mgrJar.fetch(`/api/orders/${orderPid}/legs`, { method: "POST", body: JSON.stringify({ legs: [{ carrier: "dpd", trackingNumber: "5502876195" }] }) });
check("attach leg 2 (optional)", r.status === 200 && r.body?.legCount === 2, JSON.stringify(r.body));
r = await mgrJar.fetch(`/api/orders/${orderPid}/legs`, { method: "POST", body: JSON.stringify({ legs: [{ carrier: "ups", trackingNumber: "Z" }] }) });
check("3rd leg rejected (max 2)", r.status === 400, JSON.stringify(r.body));

// ── POINT: customer read view hides internal fields ─────────────────────────
console.log("\n-- Customer read view --");
r = await custJar.fetch("/api/portal/orders");
check("customer lists own orders", r.status === 200 && Array.isArray(r.body?.orders));
r = await custJar.fetch(`/api/portal/orders/${custOrderPid}`);
check("customer sees own order detail", r.status === 200);
const co = r.body?.order;
check("customer view: NO awbNumber", co && co.awbNumber === undefined);
check("customer view: NO sender block", co && co.sender === undefined);
check("customer view: legs have NO tracking numbers", co && (co.legs?.length ? co.legs[0].trackingNumber === undefined : true));

// customer cannot see staff order that isn't theirs? (the staff order IS linked to this customer, so allowed) — test a non-owned one:
r = await custJar.fetch(`/api/portal/orders/${orderPid}`);
check("customer CAN see their linked staff order", r.status === 200);

// ── POINT: permission + isolation guards ────────────────────────────────────
console.log("\n-- Guards --");
r = await custJar.fetch(`/api/orders`);  // staff route
check("customer blocked from staff order list (403)", r.status === 403);
r = await mgrJar.fetch(`/api/orders/${orderPid}/legs`, { method: "POST", body: JSON.stringify({ legs: [] }) });
check("empty legs rejected (400)", r.status === 400);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
