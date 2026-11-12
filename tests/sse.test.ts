// Verifies the SSE hub never leaks one customer's events to another customer
// (or to staff of other branches).
import test from "node:test";
import assert from "node:assert/strict";
import type { Response } from "express";
import {
  addStaffSseClient, addCustomerSseClient, pushToBranch, pushToCustomer, sseClientCount,
} from "../src/modules/notifications/sse.js";

function fakeRes(): { res: Response; out: string[] } {
  const out: string[] = [];
  return { res: { write: (s: string) => { out.push(s); return true; } } as unknown as Response, out };
}
const events = (out: string[]) => out.filter((s) => s.startsWith("event:"));

test("customer events reach only the addressed customer", () => {
  const a = fakeRes(), a2 = fakeRes(), b = fakeRes();
  const rm = [
    addCustomerSseClient("branch1", "custA", a.res),
    addCustomerSseClient("branch1", "custA", a2.res), // same customer, second stream/tab
    addCustomerSseClient("branch1", "custB", b.res),  // other customer, same branch
  ];
  pushToCustomer("custA", "quote_message", { quotePublicId: "q1" });
  assert.equal(events(a.out).length, 1);
  assert.equal(events(a2.out).length, 1);
  assert.equal(events(b.out).length, 0);
  rm.forEach((r) => r());
});

test("pushToBranch reaches staff only, never customers", () => {
  const staff = fakeRes(), superAdmin = fakeRes(), otherBranch = fakeRes(), cust = fakeRes();
  const rm = [
    addStaffSseClient("branch1", "u1", staff.res),
    addStaffSseClient(null, "u2", superAdmin.res),
    addStaffSseClient("branch2", "u3", otherBranch.res),
    addCustomerSseClient("branch1", "custA", cust.res),
  ];
  pushToBranch("branch1", "notification", { message: "x" });
  assert.equal(events(staff.out).length, 1);
  assert.equal(events(superAdmin.out).length, 1);
  assert.equal(events(otherBranch.out).length, 0);
  assert.equal(events(cust.out).length, 0);
  rm.forEach((r) => r());
});

test("pushToCustomer ignores missing ids and clients are removed on close", () => {
  const before = sseClientCount();
  const c = fakeRes();
  const rm = addCustomerSseClient("branch1", "custA", c.res);
  pushToCustomer(null, "notification", {});
  pushToCustomer(undefined, "notification", {});
  assert.equal(events(c.out).length, 0);
  rm();
  assert.equal(sseClientCount(), before);
});
