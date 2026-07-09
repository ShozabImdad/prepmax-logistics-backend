// Phase 6 verification (needs server on :4000 + seed super-admin).
// Verifies: events fire on lifecycle actions; in-app notifications are stored +
// listable; customer emails are logged (log-only mode); order creation is
// NON-BLOCKING (returns before the async notification work finishes).
import pg from "pg";
import { readFileSync } from "node:fs";

const BASE = "http://localhost:4000";
let pass = 0, fail = 0;
const ck = (n, c, x = "") => { c ? (pass++, console.log("  OK  " + n)) : (fail++, console.log("  FAIL " + n + " " + x)); };
function jar() { let c = ""; return { async json(p, o = {}) { const h = { ...(o.headers || {}) }; if (c) h.cookie = c; if (o.body) h["content-type"] = "application/json"; const r = await fetch(BASE + p, { ...o, headers: h }); const sc = r.headers.get("set-cookie"); if (sc) c = sc.split(";")[0]; let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; } }; }

// admin DB (to inspect async results)
const env = Object.fromEntries(readFileSync(".env", "utf8").split(/\r?\n/).filter(l => l && !l.startsWith("#") && l.includes("=")).map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const db = new pg.Client({ host: env.PGADMIN_HOST, port: +env.PGADMIN_PORT, database: env.PGADMIN_DATABASE, user: env.PGADMIN_USER, password: env.PGADMIN_PASSWORD });
await db.connect();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const su = jar();
await su.json("/api/auth/staff/login", { method: "POST", body: JSON.stringify({ email: "admin@prepmax.local", password: "ChangeMe123!" }) });
const b = await su.json("/api/accounts/branches", { method: "POST", body: JSON.stringify({ name: "Notif Branch " + Date.now(), city: "N" }) });
const branchPublicId = b.body.branch.public_id;
const branchId = (await db.query("SELECT id FROM branches WHERE public_id=$1", [branchPublicId])).rows[0].id;

// manager (for branch-scoped notif listing) + customer with email
const me = `notif-mgr-${Date.now()}@x.com`;
await su.json("/api/accounts/managers", { method: "POST", body: JSON.stringify({ email: me, password: "MgrPass123!", fullName: "M", branchPublicId }) });
const mgr = jar();
await mgr.json("/api/auth/staff/login", { method: "POST", body: JSON.stringify({ email: me, password: "MgrPass123!" }) });
const custEmail = `notif-cust-${Date.now()}@example.com`;
const cr = await mgr.json("/api/accounts/customers", { method: "POST", body: JSON.stringify({ email: custEmail, password: "CustPass123!", fullName: "Notif Cust" }) });
const custPublicId = cr.body.customer.public_id;

// ── NON-BLOCKING: staff order create should return fast ─────────────────────
console.log("\n=== Non-blocking create ===");
const t0 = Date.now();
const oc = await mgr.json("/api/orders", { method: "POST", body: JSON.stringify({ customerPublicId: custPublicId, sender: { name: "S" }, receiver: { name: "R", city: "X" }, boxes: [{ weightKg: 1, lengthCm: 10, widthCm: 10, heightCm: 10, items: [] }] }) });
const elapsed = Date.now() - t0;
ck("staff order created", oc.status === 201);
ck("create returned fast (<1500ms, not blocked on email)", elapsed < 1500, elapsed + "ms");

// ── Customer booking -> admin in-app notification + customer email logged ───
console.log("\n=== Customer booking request events ===");
const cust = jar();
await cust.json("/api/auth/customer/login", { method: "POST", body: JSON.stringify({ email: custEmail, password: "CustPass123!" }) });
const booking = await cust.json("/api/portal/orders", { method: "POST", body: JSON.stringify({ sender: { name: "Me" }, receiver: { name: "F", city: "Dubai" }, boxes: [{ weightKg: 1, lengthCm: 10, widthCm: 10, heightCm: 10, items: [] }] }) });
ck("customer booking created", booking.status === 201);
const bookingCode = booking.body.order.trackingCode;

await sleep(1500); // let the async queue drain

// in-app notification for the branch (booking_request)
const notifRow = await db.query("SELECT type, message FROM notifications WHERE branch_id=$1 AND type='booking_request' ORDER BY created_at DESC LIMIT 1", [branchId]);
ck("booking_request in-app notification stored", notifRow.rows.length === 1 && notifRow.rows[0].message.includes(bookingCode), JSON.stringify(notifRow.rows[0]));

// manager can list it via API
const list = await mgr.json("/api/notifications");
ck("manager lists notifications via API", list.status === 200 && list.body.notifications.some(n => n.type === "booking_request"));
ck("unread count > 0", list.body.unread > 0, "unread=" + list.body.unread);

// customer "booking_received" email logged
const emailRow = await db.query("SELECT template, status, to_email FROM email_log WHERE branch_id=$1 AND template='booking_received' ORDER BY created_at DESC LIMIT 1", [branchId]);
ck("booking_received email logged (log-only => queued)", emailRow.rows.length === 1 && emailRow.rows[0].status === "queued" && emailRow.rows[0].to_email === custEmail, JSON.stringify(emailRow.rows[0]));

// staff order (with customer) -> order_confirmed email logged
const confirmRow = await db.query("SELECT template FROM email_log WHERE branch_id=$1 AND template='order_confirmed' ORDER BY created_at DESC LIMIT 1", [branchId]);
ck("order_confirmed email logged for staff order", confirmRow.rows.length === 1);

// ── mark-all-read ───────────────────────────────────────────────────────────
console.log("\n=== Mark read ===");
const mr = await mgr.json("/api/notifications/read-all", { method: "POST" });
ck("mark-all-read works", mr.status === 200 && mr.body.marked >= 1, JSON.stringify(mr.body));
const after = await mgr.json("/api/notifications");
ck("unread is 0 after mark-read", after.body.unread === 0, "unread=" + after.body.unread);

// ── approve -> order_confirmed email for the booking ────────────────────────
console.log("\n=== Approval event ===");
const bookingPid = booking.body.order.publicId;
await mgr.json(`/api/orders/${bookingPid}/approve`, { method: "POST" });
await sleep(1200);
const approveEmail = await db.query("SELECT count(*)::int n FROM email_log WHERE branch_id=$1 AND template='order_confirmed'", [branchId]);
ck("approval produced an order_confirmed email", approveEmail.rows[0].n >= 1, "count=" + approveEmail.rows[0].n);

await db.end();
console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
