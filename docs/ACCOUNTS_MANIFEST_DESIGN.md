# Accounts, Manifest & De‑Manifest — Design Document

**Status:** Draft for review · **Date:** 2026‑07‑16
**Scope:** Three new modules requested by the client — **Accounts (Finance)**, **Manifest**, and **De‑Manifest** — designed to fit the existing Prep Max Logistics platform (Node/Express + PostgreSQL, branch‑isolated via RLS, RBAC permissions).

> This document does **not** implement anything yet. It captures *what the client asked for*, *how it maps to our current database*, the *proposed schema and module design*, and a list of *open questions* that need the client's answer before build. Nothing here is assumed silently — every interpretation is called out.

---

## 1. How this fits what we already have

Before designing anything new, here is the relevant part of the **current system** these modules must integrate with (verified from the live migrations `0001`–`0013`):

| Existing table | Relevance to the new modules |
|---|---|
| `branches` | Every new table is **branch‑scoped** (multi‑tenant). Same pattern applies. |
| `users` | Staff who create manifests, record payments, etc. (`created_by`, `handled_by`). |
| `customers` | The "Customers" side of Accounts (ledger, invoices, payments). |
| `orders` | The shipments. Already carry **`price`, `price_currency`, `payment_status` (`unpaid`/`paid`/`partial`), `amount_paid`, `declared_total`**. Also `tracking_code`, `awb_number`, `receiver_*`, boxes/weight. Manifests reference orders; invoices bill for orders. |
| `boxes` | Piece count + `chargeable_kg` per order → used for manifest weight/piece totals. |
| `shipment_legs.carrier` | The **carrier/vendor** each order is handed to (`smartcargo-apx`, `snwwe`, `dpd`, `dhl`, `ups`, `fedex`). This is the seed of the "Vendors/Partners" list. |
| `permissions` / `roles` / `role_permissions` / `user_roles` | New modules plug into the **same RBAC** — we add new permission keys. |
| RLS helpers (`app_can_see_branch`, etc.) | Every new table gets `branch_id` + the standard `app_can_see_branch` policy, exactly like `complaints` (migration `0013`). |
| `htmlToPdf`, `barcodeDataUri` | Reused for **manifest PDF / barcode / QR** and **invoice PDF** — no new libraries needed. |
| `analytics` module | Already computes `sum(price)` revenue and unpaid amounts. The Accounts **Dashboard** formalises/extends this. |

### ⚠️ Naming clash to resolve first
The permission catalog **already has a module called "Accounts"** — but it means **staff‑account management** (`accounts.view`, `accounts.manage` = managing *user logins*), **not** financial accounting. To avoid confusion, this document names the new financial module **"Finance"** (permission keys `finance.*`). The client‑facing UI can still be *labelled* "Accounts" in the sidebar — only the internal module/permission name differs. **→ Open question Q1.**

---

## 2. What the client wants — requirements analysis

The client sent three feature lists. Below is each one restated in plain terms, with the interpretation made explicit.

### 2.1 "Accounts" → **Finance module**
A lightweight **accounting/bookkeeping** layer over the courier business. Not a full general‑ledger ERP — a practical AR/AP (accounts‑receivable / accounts‑payable) system:

- **Dashboard** — Total Income, Total Expenses, Pending Payments, Profit/Loss, Cash in Hand, Bank Balance.
- **Customers (AR side)** — customer list (already exists), **Customer Ledger** (running statement of what each customer owes/paid), **Customer Invoices**, **Customer Payment History**. CRUD.
- **Vendors / Partners (AP side)** — a **new** entity: the carriers/partners we pay (APX, SkyNet, Local, Aramex, …). Vendor list, **Vendor Bills** (what they charge us), **Vendor Payments** (what we pay them), **Vendor Ledger**. CRUD.
- **Invoices** — create/edit/delete invoices, invoice list, paid/unpaid filter, **Credit Notes** (a negative invoice that reduces what a customer owes).
- **Payments** — receive payment (from customers), make payment (to vendors), payment history, pending dues. CRUD.
- **Expenses** — office rent, salaries, fuel, utility bills, marketing, miscellaneous. Categorised. CRUD.
- **Reports** — daily / monthly / yearly.

> **Interpretation:** This is a **subsidiary‑ledger** model (industry standard), *not* full double‑entry journals with a chart of accounts. Each customer and each vendor has a ledger = a chronological list of debits/credits with a running balance. Invoices/bills raise a debit or credit; payments settle it; credit notes reverse it. This matches how courier billing software (cTrunk, CargoWise, Linbis) structures it, and is what "Customer Ledger" / "Vendor Ledger" conventionally means: *Date · Reference · Description · Debit · Credit · Running Balance*. **→ confirm scope, Q2.**

### 2.2 "Manifest Module" → **outbound consolidation**
A **manifest** is the formal handover document when we hand a batch of shipments to a carrier/partner. Standard courier concept (proof of transfer). The client wants:

- **Create Manifest** — auto manifest no., date, totals (shipments/weight), created‑by, status (**Open → Closed → Dispatched**).
- **Add Shipments** — search by tracking number, scan barcode, bulk‑select, auto total weight + piece count, **prevent duplicate tracking** across manifests.
- **Manifest List** — number, date, count, weight, status; print, download PDF, edit (only while Open), close.
- **Manifest Details** — per shipment: tracking, sender, receiver, destination, weight, charges, status.
- **Print options** — manifest PDF, shipment list, barcode/QR, export Excel.

> **Interpretation:** A manifest is a **batch of orders** handed to one carrier. `manifests` (header) + `manifest_shipments` (join to `orders`). Weight/piece totals are **derived from the orders' boxes** we already store. "Charges" per shipment = the order's `price`. Duplicate prevention = an order can be on **at most one open/active manifest**. **→ Q3 (one carrier per manifest?), Q4 (Excel export scope).**

### 2.3 "De‑Manifest Module" → **inbound receiving & reconciliation**
The client's Urdu note — *"Ye incoming ya received shipments ke liye hoga"* — means **"this is for incoming / received shipments."** So de‑manifest = the **receiving** process at an arrival hub: you receive a batch from a courier and reconcile what physically arrived against what was expected.

- **Create De‑Manifest** — de‑manifest no., date, **courier name**, arrival hub, received‑by, total shipments, status.
- **Add Shipments** — barcode scan / tracking search, receive date & time, **shipment condition** (Good / Damaged / Missing / Open Package).
- **Short / Excess reconciliation** — missing, extra, damaged, hold.
- **Remarks.**
- **De‑Manifest Report** — received / missing / extra / damaged / pending counts.

> **Interpretation:** `de_manifests` (header) + `de_manifest_shipments` (rows, each with a **condition** and link to an `order` **when matched**). An "extra/unexpected" shipment is a row whose tracking number **doesn't match a known order** (so `order_id` is nullable + we keep the raw scanned tracking). This mirrors real hub receiving. **→ Q5 (do inbound tracking numbers correspond to our own orders, external AWBs, or both?).**

---

## 3. Proposed database schema

> **⚠️ HISTORICAL — this section is the ORIGINAL PLAN, not what was built.**
> The migration numbers below (`0014_finance`, `0015_manifest`, `0016_de_manifest`)
> are **wrong vs. reality** — they were placeholder names before implementation.
> **For the ACTUAL as-built schema, migration numbers, and working logic, read
> Part 4 (§I onward).** This §3 is kept only to show the original design intent.
> The as-built tables largely match this shape, but the numbering and a few
> details differ — always trust Part 4 over this section.

All new tables follow the **exact house pattern** proven by `complaints` (migration `0013`): `uuid` PK, `public_id`, denormalised `branch_id` with `ENABLE + FORCE ROW LEVEL SECURITY` and the `app_can_see_branch` policy, `set_updated_at` trigger, money as `numeric(12,2)`. New migrations would be `0014`, `0015`, `0016`.

### 3.1 Finance — migration `0014_finance.sql`

```
vendors                         -- carriers/partners we pay (APX, SkyNet, Local, Aramex…)
  id, public_id, branch_id
  name, code                    -- code maps to a carrier adapter key when applicable (e.g. 'smartcargo-apx'); NULL for non-integrated (Local, Aramex)
  vendor_type                   -- 'carrier' | 'local' | 'other'
  contact_name, phone, email, address
  opening_balance  numeric(12,2) default 0   -- what we owed them on day 1
  is_active bool, created_at, updated_at

invoices                        -- customer-facing bills (AR). A credit note is an invoice with is_credit_note=true (negative effect)
  id, public_id, branch_id
  invoice_no        text unique-per-branch   -- auto: PML-INV-2026-000123
  customer_id       -> customers
  order_id          -> orders (nullable — an invoice may cover one order or be ad-hoc/consolidated)
  is_credit_note    bool default false
  issue_date, due_date
  currency          text default 'PKR'
  subtotal, tax, total   numeric(12,2)
  amount_paid       numeric(12,2) default 0
  status            text  -- 'draft' | 'unpaid' | 'partial' | 'paid' | 'void'
  notes
  created_by -> users, created_at, updated_at

invoice_items                   -- line items on an invoice (freight, fuel surcharge, packing…)
  id, invoice_id -> invoices, branch_id
  description, quantity, unit_price, line_total  numeric(12,2)

vendor_bills                    -- what a vendor charges us (AP)
  id, public_id, branch_id
  bill_no           text        -- vendor's own bill number (free text)
  vendor_id -> vendors
  bill_date, due_date
  currency, subtotal, tax, total, amount_paid  numeric(12,2)
  status            text  -- 'unpaid' | 'partial' | 'paid' | 'void'
  notes, created_by -> users, created_at, updated_at

vendor_bill_items               -- optional line items (can reference orders we shipped via this vendor)
  id, vendor_bill_id -> vendor_bills, branch_id
  order_id -> orders (nullable), description, amount  numeric(12,2)

payments                        -- money movements, both directions
  id, public_id, branch_id
  direction         text  -- 'in' (from customer)  | 'out' (to vendor / expense)
  method            text  -- 'cash' | 'bank' | 'cheque' | 'online' | 'other'
  account           text  -- 'cash_in_hand' | 'bank'   (drives Cash-in-Hand vs Bank Balance)
  amount            numeric(12,2)
  paid_on           date
  customer_id  -> customers (nullable)   -- set when direction='in'
  vendor_id    -> vendors   (nullable)   -- set when direction='out' to a vendor
  invoice_id   -> invoices  (nullable)   -- allocation: which invoice this receipt settles
  vendor_bill_id -> vendor_bills (nullable) -- which bill this payment settles
  reference, notes, created_by -> users, created_at, updated_at

expenses                        -- operating expenses (rent, salaries, fuel, utilities, marketing, misc)
  id, public_id, branch_id
  category  text  -- 'office_rent' | 'salaries' | 'fuel' | 'utilities' | 'marketing' | 'miscellaneous'
  amount    numeric(12,2)
  account   text  -- 'cash_in_hand' | 'bank'
  spent_on  date
  payee, description, reference
  created_by -> users, created_at, updated_at
```

**Ledgers are derived, not stored.** A *Customer Ledger* is a query over `invoices` (debits) + inbound `payments` (credits) for that customer, ordered by date, with a running balance — exactly the AR‑subledger model from the research. A *Vendor Ledger* is `vendor_bills` (credits, i.e. we owe) + outbound `payments` (debits). This avoids a second source of truth and keeps balances always correct. *(Alternative: a physical `ledger_entries` table — heavier, only needed if we want manual journal adjustments. **→ Q2.)*

**Dashboard figures map to:**
- **Total Income** = Σ inbound `payments` (or Σ invoice totals — Q6 defines "income" as cash‑basis vs accrual‑basis).
- **Total Expenses** = Σ `expenses` + Σ outbound `payments` to vendors.
- **Pending Payments** = Σ unpaid/partial invoice balances (customers owe us) — and optionally Σ unpaid vendor bills (we owe).
- **Profit / Loss** = Income − Expenses − vendor costs.
- **Cash in Hand** = Σ(cash in) − Σ(cash out) where `account='cash_in_hand'`.
- **Bank Balance** = same for `account='bank'` (+ an opening balance setting — **Q7**).

### 3.2 Manifest — migration `0015_manifest.sql`

```
manifests
  id, public_id, branch_id
  manifest_no   text  -- auto: PML-MF-2026-000045 (unique per branch)
  vendor_id -> vendors (nullable)  -- the carrier/partner we hand this batch to  (Q3)
  manifest_date date default today
  status        text  -- 'open' | 'closed' | 'dispatched'
  total_shipments int  default 0    -- cached, recomputed on add/remove
  total_weight_kg numeric(10,3) default 0
  notes
  created_by -> users, closed_by -> users, dispatched_at timestamptz
  created_at, updated_at

manifest_shipments              -- orders on a manifest
  id, manifest_id -> manifests, branch_id
  order_id -> orders
  UNIQUE (order_id)  WHERE the manifest is not 'dispatched'  -- duplicate-prevention (an order can't be on two live manifests)
  added_at
```

- **Weight / piece / charge totals** are read from the order's `boxes` (`chargeable_kg`, count) and `orders.price` — no new weight fields.
- **Statuses:** `open` (editable) → `closed` (locked) → `dispatched` (handed over; timestamp recorded). Edit only allowed while `open`.
- **Print/PDF/QR** reuse `htmlToPdf` + `barcodeDataUri`. **Excel export** needs a new lightweight library (e.g. `exceljs`) — **Q4.**

### 3.3 De‑Manifest — migration `0016_de_manifest.sql`

```
de_manifests
  id, public_id, branch_id
  de_manifest_no text  -- auto: PML-DMF-2026-000012
  courier_name   text            -- free text OR vendor_id (Q5)
  vendor_id -> vendors (nullable)
  arrival_hub    text            -- which branch/hub received it (default = current branch)
  de_manifest_date date
  received_by -> users
  status         text  -- 'open' | 'completed'
  total_expected int, total_received int, total_missing int, total_extra int, total_damaged int  -- cached counts
  remarks
  created_at, updated_at

de_manifest_shipments
  id, de_manifest_id -> de_manifests, branch_id
  order_id -> orders (nullable)          -- matched to a known order; NULL when 'extra'/unrecognised
  scanned_tracking text                  -- the raw scanned/typed tracking number (always kept)
  received_at   timestamptz
  condition     text  -- 'good' | 'damaged' | 'missing' | 'open_package'
  reconciliation text -- 'received' | 'missing' | 'extra' | 'hold'
  remarks
```

- **Report** = counts grouped by `reconciliation` / `condition`.
- **"Extra" shipment** = `order_id IS NULL` (scanned something not in our system). **"Missing"** = an expected order that was never scanned (Q5 defines how "expected" is known — from a source manifest, or manual entry).

---

## 4. RBAC — new permission keys

Added to the seed catalog (migration inserts, `ON CONFLICT DO NOTHING`), toggleable per role like every other permission:

| Key | Module (label) | Meaning |
|---|---|---|
| `finance.view` | Finance | View dashboard, ledgers, invoices, payments, expenses |
| `finance.manage` | Finance | Create/edit/delete invoices, payments, expenses, vendors |
| `vendors.view` / `vendors.manage` | Finance | (optional split) manage the vendor list |
| `manifest.view` | Manifest | View manifests |
| `manifest.manage` | Manifest | Create/edit/close/dispatch manifests |
| `demanifest.view` | De‑Manifest | View de‑manifests |
| `demanifest.manage` | De‑Manifest | Create/receive/reconcile de‑manifests |

Super‑admin implicitly has all. Existing Branch Manager role would need these toggled on (seed only affects fresh installs — same caveat as complaints).

---

## 5. Branch‑scoping & security (unchanged house rules)

- Every table has `branch_id` + `ENABLE/FORCE ROW LEVEL SECURITY` + `app_can_see_branch` policy → a branch manager only ever sees their branch's finance/manifests; super‑admin sees all (with the all‑branches view).
- All money as `numeric(12,2)`; each finance record stores its `currency` (default `PKR`) — **multi‑currency math is not auto‑converted** unless the client needs it (**Q8**).
- All writes go through `req.db!` (RLS transaction) with a `requirePermission(...)` gate, exactly like orders/complaints.
- Deletes: follow the established "soft (is_active) + hard cascade" decision already used for customers/branches — confirm per entity (**Q9**).

---

## 6. Module/route layout (mirrors existing modules)

```
backend/src/modules/finance/       routes.ts  queries.ts  schema.ts
backend/src/modules/manifests/     routes.ts  queries.ts  schema.ts   pdf/excel helpers
backend/src/modules/de-manifests/  routes.ts  queries.ts  schema.ts
frontend .../app/portal/admin/finance/{dashboard,customers,vendors,invoices,payments,expenses,reports}
frontend .../app/portal/admin/manifests/{list,[id]}
frontend .../app/portal/admin/de-manifests/{list,[id]}
```

Sidebar gains three groups: **Accounts** (Finance), **Manifests**, **De‑Manifests** — visibility gated by the permissions above.

---

## 7. Suggested build order (phased)

1. **Vendors** (foundation for both Finance‑AP and Manifests) + permissions.
2. **Finance core** — invoices, payments, expenses → customer/vendor ledgers → dashboard → reports.
3. **Manifest** — create/add/close/dispatch → print PDF/QR → Excel.
4. **De‑Manifest** — receive/reconcile → report.

Each phase is independently shippable and testable.

---

## 8. Open questions (need client answers before build)

| # | Question | Why it matters |
|---|---|---|
| **Q1** | The word "Accounts" already means *staff‑account management* in our system. OK to name the finance module **"Finance"** internally while the sidebar still says "Accounts"? | Avoids a permission/name collision. |
| **Q2** | Do you need **derived ledgers** (simpler, always‑correct — our recommendation) or an explicit **`ledger_entries` journal** table with manual adjustments? | Determines schema weight. |
| **Q3** | Is a manifest handed to **exactly one carrier/vendor**, or can it mix carriers? | Header vs per‑row vendor. |
| **Q4** | **Excel export** — required at launch? (adds a library) or is **PDF/CSV** enough initially? | Scope of print options. |
| **Q5** | For **De‑Manifest**, are the incoming tracking numbers **our own PML orders**, **external carrier AWBs**, or **both**? And how is the "expected" list known — from a linked manifest, an uploaded file, or manual scanning only? | Defines matching + "missing/extra" logic. |
| **Q6** | Is **"Total Income"** cash‑basis (money actually received) or accrual (invoiced)? Same for expenses. | Dashboard math. |
| **Q7** | Do you want **opening balances** for Cash‑in‑Hand and Bank (starting figures), and are there **multiple bank accounts** or just one "Bank"? | Cash/Bank tracking accuracy. |
| **Q8** | Multiple currencies in finance (PKR + USD)? If yes, do you want auto‑conversion or just per‑record currency display? | Reporting correctness. |
| **Q9** | Delete behaviour per entity — soft‑deactivate, hard‑delete, or "void" (recommended for financial records, which should never truly delete)? | Audit/compliance. |
| **Q10** | Should **customers/vendors** in Finance be **branch‑scoped** (each branch its own) or **shared across branches**? (Customers are already branch‑scoped.) | Multi‑branch consistency. |
| **Q11** | Do manifests/finance need to be **customer‑visible** in the portal, or **staff‑only**? | Portal surface area. |

---

## 9. What is intentionally *not* in scope (unless asked)

- Full double‑entry general ledger with a chart of accounts / trial balance.
- Tax filing / FBR e‑invoicing integration.
- Payroll processing (salaries are recorded as an expense category only).
- Bank reconciliation against real bank statements.
- Automatic currency conversion.

These can be added later; the schema above leaves room for them.

---

*Prepared from: the live database (`0001`–`0013` migrations), the existing modules (orders, customers, analytics, complaints), and industry references on courier accounting and manifest/de‑manifest workflows. Every design choice is traceable to an existing pattern in the codebase or a cited industry norm — nothing was assumed silently; open decisions are listed in §8.*

---

# Part 2 — Implementation Verification (2026-07-21)

The client answered all 11 open questions, and the Finance, Vendors, Manifest,
De-Manifest, and customer-portal-finance modules were implemented and deployed
(backend `main` @ `4e1a919`, live on `api.prepmaxlogistics.com`, migrations
`0014`-`0024` applied). This section records the **client's confirmed answers**
and the result of a **line-by-line verification of the implemented code**
against those answers. Every finding cites `file:line`. Nothing here is assumed.

## A. Client's confirmed answers (maps to Part 1 §8 questions)

| Q | Client's answer |
|---|---|
| Q1 | Name it **"Accounts / Finance"** |
| Q2 | **Simple ledger** — invoices, payments, running balance per customer/vendor |
| Q3 | **One manifest per carrier** (APX manifest, SkyNet manifest, …) |
| Q4 | Export as **PDF + CSV + Excel** |
| Q5 | De-Manifest: **both** Prepmax & carrier tracking; compare scanned vs the expected manifest → auto-show **missing / extra / received** |
| Q6 | Total Income = **money actually received** (cash/bank), *not* unpaid invoices |
| Q7 | **Opening balances** allowed; **multiple bank accounts** (Meezan, HBL, UBL…) + Cash in Hand |
| Q8 | **PKR** primary currency |
| Q9 | **Void / Cancel only** (no hard delete of financial records) |
| Q10 | Customers **branch-specific**; reports per-branch or combined at head office |
| Q11 | Customers see (portal): **invoices, payment history, outstanding balance, shipment charges** |

## B. Verified CORRECT

Each item was read in the actual deployed source and traced end-to-end.

1. **Simple derived ledger (Q2).** `getCustomerLedger` (`finance/queries.ts:1137`)
   and `getVendorLedger` (`:1185`) build a running balance at read time from
   invoices/vendor_bills + payments. No stored journal — matches "simple ledger".
   AR convention `balance += debit − credit` is correct (positive = customer owes).

2. **Total Income = cash received, not invoiced (Q6).** Dashboard
   (`finance/queries.ts:1265`) computes `totalIncome = SUM(payments WHERE
   direction='in')` — actual receipts only. Exactly as confirmed.

3. **Credit notes reduce the balance correctly.** `computeInvoiceTotals`
   (`:313`) inverts the sign for credit notes so the stored `total` is
   **negative**; in the ledger a credit note posts a negative debit that reduces
   what the customer owes (`:1154`). A credit note can't exceed the referenced
   invoice's remaining balance (`:385`).

4. **Invoice numbering is race-safe.** `nextInvoiceNo` (`:322`) uses
   `SELECT … FOR UPDATE` + `MAX(seq)+1`, backed by `UNIQUE(branch_id,
   invoice_no)`. Format `PML-INV-2026-000001`. Concurrent creates can't collide.

5. **Payment → status re-derivation is correct & idempotent.** `createPayment`
   (`:875`) blocks overpayment on invoices (`:905`) and vendor bills (`:917`),
   then recomputes `amount_paid = SUM(payments)` and `status`
   (`paid`/`partial`/`unpaid`) by re-summing — not incrementing — in the same
   transaction (`:938`).

6. **Void, not delete (Q9).** Ledgers exclude `status='void'` (`:1157`, `:1199`);
   dashboard/pending exclude void. Financial records keep a `'void'` status.

7. **One manifest per carrier (Q3).** `manifests.vendor_id` is a **header-level**
   carrier (`0018_manifests.sql:28`) — the schema even cites this design doc.

8. **Manifest duplicate prevention.** `addShipments` (`manifest/queries.ts:276`)
   rejects an order already on any non-dispatched manifest, **row-locked**
   (`FOR UPDATE OF ms`, `:302`) to avoid races; same-manifest dup blocked by
   `UNIQUE(manifest_id, order_id)` + `ON CONFLICT DO NOTHING`.

9. **Manifest weight totals are derived.** `recomputeTotals`
   (`manifest/queries.ts:135`) sums `boxes.chargeable_kg` per order — reuses the
   existing weight data, recomputed on every add/remove.

10. **De-Manifest reconciliation (Q5).** `scanShipment`
    (`de-manifests/queries.ts:345`) matches a scan to a PML order by
    `tracking_code`; a matched pending row becomes `'received'` (`:374`), an
    unmatched code becomes `'extra'` with manual sender/receiver fallback
    (`:414`). `completeDeManifest` flips any still-`pending` rows to `'missing'`
    (`:507`). So **received / missing / extra** are produced exactly as the client
    asked. Double-scan is blocked on both matched (`:391`) and unmatched (`:412`)
    paths. Counts (`recomputeCounts`, `:169`) are derived, in-transaction.

11. **Both tracking types (Q5).** `de_manifest_shipments` keeps `order_id`
    (matched PML order) **and** `scanned_tracking` (raw carrier AWB, always
    stored) — `0019_de_manifests.sql:73-74`. `source_manifest_id` (`:31`) links
    the "expected" list to an outbound manifest.

12. **Customer portal finance (Q11).** `portalFinanceRouter`
    (`finance/portal-routes.ts`, mounted `app.ts:56`) exposes read-only
    `/summary` (outstanding balance = ledger closing balance), `/invoices`,
    `/invoices/:id` (ownership-checked, 404 on someone else's — `:80`), and
    `/payments`. Secure: no write routes, ownership enforced beyond branch RLS.

13. **PKR primary (Q8).** `currency` defaults to `'PKR'` on invoices, bills, and
    payments (`0015_finance.sql:72,132`).

14. **Branch isolation & permissions.** Every finance/manifest/de-manifest table
    is `branch_id` + `FORCE ROW LEVEL SECURITY` + `app_can_see_branch` (house
    pattern). The permission model was later **collapsed** — `<module>.view` /
    `<module>.manage` merged into a single `<module>.manage` for finance /
    manifest / demanifest / quotes / complaints
    (`0022_collapse_view_manage_permissions.sql`), granting `.manage` to anyone
    who had `.view` so no one loses access.

## C. Gaps / deviations from the confirmed answers

These are places where the current implementation does **not yet** fully match
what the client confirmed. None are bugs in what is built — they are *missing
scope* against Q7, plus one calculation-semantics issue.

1. **Multiple bank accounts NOT implemented (Q7).** The client confirmed
   "multiple bank accounts (Meezan, HBL, UBL) + Cash in Hand." The schema only
   has `account ∈ {'cash_in_hand','bank'}` — a single generic "bank"
   (`0015_finance.sql:189,230`). There is **no `bank_accounts` table** and no way
   to name/separate Meezan vs HBL vs UBL. *Needs a follow-up migration:* a
   `bank_accounts` table (branch-scoped) + `payments.bank_account_id` /
   `expenses.bank_account_id`, and per-account balances on the dashboard.

2. **Opening balances for Cash/Bank NOT implemented (Q7).** The client confirmed
   "Allow entering opening balances." Only **vendors** have `opening_balance`.
   There is no opening balance for Cash-in-Hand or any bank account, so the
   dashboard's Cash/Bank figures start from zero, not the real starting balance.
   *Needs:* an opening-balance field per cash/bank account (naturally lands on the
   `bank_accounts` table from gap #1, plus a cash opening).

3. **Cash-in-Hand / Bank Balance are period-scoped, not true running balances.**
   In `getFinanceDashboard` (`finance/queries.ts:1270-1275`) the cash/bank figures
   are filtered by the dashboard date window (`paid_on BETWEEN from AND to`).
   "Cash in Hand" should be the **running total of all cash up to now**,
   independent of the report period. As built, filtering the dashboard to a single
   month makes Cash-in-Hand show only that month's net movement — misleading.
   *Fix:* compute cash/bank balances with **no date filter** (all-time to date),
   separate from the period-scoped income/expense KPIs. (Ties in with opening
   balances from gap #2.)

4. **Manifest does not validate order carrier == manifest vendor (Q3, soft).**
   A manifest is *labelled* with one carrier (`vendor_id`), but `addShipments`
   does not check that each added order is actually assigned to that carrier. If
   the workflow assigns the carrier at manifest time this is fine; if orders
   already have a carrier leg, the system currently trusts the operator. *Confirm
   with client whether it should enforce carrier == manifest vendor.*

5. **Export formats (Q4) — verify at UI level.** Q4 asked for **PDF + CSV +
   Excel**. `manifest/print.ts` exists (PDF). CSV/Excel generation should be
   confirmed on the frontend/print path — not verified in this backend pass.
   **→ UPDATE (see Part 3 §F): now verified. PDF works (200); CSV and Excel are
   a REAL BUG — the frontend has both buttons but the backend routes are missing
   (both 404 live). Details + fix in Part 3 §F.**

## D. Recommended next steps

1. **Add `bank_accounts` + opening balances** — closes gaps #1, #2 and #3
   together. This is the single most important gap vs. the client's answers.
2. **Fix Cash/Bank dashboard math** to be all-time running balances.
3. **Confirm** carrier-match enforcement on manifests (gap #4) and CSV/Excel
   export (gap #5) with the client / frontend.

*Verification performed by reading the deployed source on backend `main`
@ `4e1a919`; every claim above cites the exact file and line. The build
typechecks and all endpoints return 200 live. The three gaps in §C are scope not
yet built against Q7 — they do not affect the correctness of what is built.*

---

# Part 3 — Frontend verification + new requirement + gap resolutions (2026-07-21)

This part (a) extends the verification to the **frontend** (Part 2 covered the
backend only), (b) records the client's decisions on the two open gaps (#4, #5),
(c) documents the **new customer-portal manifest** requirement as a spec for the
developer. As before, every finding cites `file:line`; nothing is assumed.
Frontend verified on `prepmax-logistics-frontend` `main` @ `9372e11`.

## E. Frontend verification

### Verified CORRECT

1. **Admin Finance page is complete.** `app/portal/admin/finance/page.tsx` has all
   seven tabs — Dashboard, Vendors, Customers, Invoices, Payments, Expenses,
   Reports (`:31-38`). The API client (`lib/api/finance.ts`) calls exactly the
   backend routes: `/finance/dashboard`, `/finance/vendors(+/ledger,/hard)`,
   `/finance/customers/:id/ledger`, `/finance/invoices`, `/finance/vendor-bills`,
   `/finance/payments`, `/finance/expenses`, `/finance/reports`. Matches backend.

2. **Customer portal Finance is complete (Q11).** `app/(portal)/portal/finance/
   page.tsx` shows Invoices + Payments tabs, a summary with **outstanding
   balance**, overdue detection (`:33-36`), and charts. It's in the customer
   sidebar (`app/(portal)/portal/layout.tsx:18`). Calls `/portal/finance/summary`,
   `/invoices`, `/invoices/:id`, `/payments` — matches the read-only,
   ownership-checked backend `portalFinanceRouter`.

3. **Admin Manifest + De-Manifest pages exist and wire correctly.**
   `app/portal/admin/manifests/{page,[id]}` and `.../de-manifests/{page,[id]}`
   call `/manifests/*` and `/de-manifests/*`. Manifest create has a **Vendor /
   Carrier** dropdown populated from the branch's vendor list, optional
   (`manifests/page.tsx:104-112`), matching the header-level `vendor_id` design.

4. **PDF export works** (admin manifest detail → `manifest.pdf`, live `200`).

### Frontend gaps found

5. **CSV & Excel export buttons are broken (ties to Gap #5, see §F).** The
   manifest detail page renders **Export CSV** and **Export Excel** buttons
   (`manifests/[id]/page.tsx:429-433`) pointing at `manifest​CsvUrl` →
   `/manifests/:id/shipments.csv` and `manifestExcelUrl` →
   `/manifests/:id/shipments.xlsx` (`lib/api/manifests.ts:82-87`). **Both return
   404 live** — the backend has no such routes (only `manifest.pdf` exists). So
   these two buttons currently do nothing but download an error. See §F.

## F. Resolution of the two open gaps from Part 2 §C

### Gap #4 — Manifest carrier validation → **DECISION: do NOT enforce (confirmed)**

The client confirmed the manifest's carrier should **not** be strictly validated
against each order's assigned carrier. Rationale: in the real workflow the
carrier is often decided **at manifest / dispatch time**, so requiring
`order.carrier == manifest.vendor` before an order can be manifested would block
normal operations. **This is intentional and correct as built** — the manifest
is *labelled* with a carrier (`manifests.vendor_id`) and staff may add any
eligible order (`manifest/queries.ts:276`). No change needed. *(If data-integrity
ever becomes a concern, a non-blocking "carrier mismatch" warning on add is the
recommended middle ground — but not now.)*

### Gap #5 — CSV / Excel export → **REAL BUG, needs the dev to fix**

Q4 asked for **PDF + CSV + Excel**. Current state, verified live:

| Format | Frontend button | Backend route | Live result |
|---|---|---|---|
| PDF | yes | `GET /manifests/:id/manifest.pdf` (`routes.ts:120`) | **200 OK** |
| CSV | yes (`manifests/[id]/page.tsx:429`) | **missing** | **404** |
| Excel | yes (`:432`) | **missing** | **404** |

Notes for the dev:
- The **CSV generator already exists** — `manifestShipmentsCsv()` in
  `manifest/print.ts:177` — it's just **not wired to a route**. Fix = add
  `GET /:publicId/shipments.csv` that calls it and returns
  `content-type: text/csv` + a `Content-Disposition` filename.
- **Excel is not implemented at all**: no `.xlsx` route and **no Excel library**
  in `package.json`. Fix = add a library (`exceljs` is the usual choice) and a
  `GET /:publicId/shipments.xlsx` route, or — simpler — have the "Excel" button
  download the CSV (Excel opens CSV natively) and drop the true-xlsx requirement.
  Confirm which with the client.
- Until fixed, **the two buttons should either be hidden** or the routes added,
  so customers/staff don't hit a 404.

## G. NEW REQUIREMENT — Customer-portal Manifest (client-requested 2026-07-21)

**Requirement (confirmed with client):** Add a **manifest section in the customer
portal** where a **customer can create a manifest** — a batch of *their own*
shipments they hand over to Prepmax. The vendor/carrier **defaults to "Prepmax
Logistics"** (because the customer hands the batch to *us*, not to a carrier).
Later, **an admin can change the vendor/carrier** on that manifest to the real
downstream carrier (APX, SkyNet, DHL, …).

### How it maps to the current model
The existing `manifests` table already has a header-level `vendor_id`. The only
new concepts are: (1) a manifest can be **created by a customer** (currently
staff-only), and (2) a **default "Prepmax Logistics" vendor**. So this is mostly
new **routes + a portal page + a seeded vendor**, not a schema rewrite.

### Proposed design (for the dev — NOT yet built)

1. **A house "Prepmax Logistics" vendor per branch.** Seed one `vendors` row per
   branch with `name = 'Prepmax Logistics'`, `vendor_type = 'other'` (or a new
   `'self'` type), so a customer-created manifest can default its `vendor_id` to
   it. *Open: one shared self-vendor, or one per branch (recommended: per branch,
   consistent with branch-scoping / Q10).*

2. **`manifests` gains a `created_by_customer_id` (nullable).** Mirrors how
   `orders.created_via` distinguishes customer vs staff. Lets staff see which
   manifests came from customers (like the "Order Requests" queue). RLS unchanged
   (still branch-scoped). *Alternative: reuse the existing `created_via` pattern.*

3. **New customer portal routes** (mounted `/api/portal/manifests`, gated by
   `requireCustomer`, scoped to the customer's own orders — same pattern as
   `portalOrderRouter` / `portalFinanceRouter`):
   - `POST /api/portal/manifests` — create; `vendor_id` auto-set to the branch's
     "Prepmax Logistics" vendor; the customer may only add **their own** orders
     (ownership check, like the complaint/booking flows).
   - `GET /api/portal/manifests` — list the customer's own manifests.
   - `GET /api/portal/manifests/:publicId` — detail (own only).
   - `POST /api/portal/manifests/:publicId/shipments` — add own orders (open only).
   - Customer should **not** be able to change the vendor, close, or dispatch —
     those stay admin-only.

4. **Admin can re-assign the vendor** — already supported: `PATCH
   /api/manifests/:publicId` with `vendorPublicId` updates the carrier
   (`manifest/routes.ts:135`, frontend `updateManifest`). So the admin side needs
   no new endpoint; just make sure the admin manifest list surfaces
   customer-created manifests (e.g. a "source: customer" badge).

5. **New portal page** `app/(portal)/portal/manifests/{page,[id]}` — "My
   Manifests" list + create form (pick from the customer's own shipments), vendor
   shown read-only as "Prepmax Logistics". Add "Manifests" to the portal sidebar
   (`app/(portal)/portal/layout.tsx`).

6. **Carrier redaction (important, consistency with tracking).** On the customer
   side the manifest's vendor must display as **"Prepmax Logistics"** and must
   **never reveal the real downstream carrier** even after an admin re-assigns it
   — same rule already enforced for tracking/status text (`redactCarrier`). The
   portal manifest read model should hard-code/observe "Prepmax Logistics" for
   the customer regardless of the stored `vendor_id`.

### Open questions for this new feature
- **G-Q1:** Should a customer-created manifest **auto-notify** staff (like order
  requests / complaints do), so someone assigns the real carrier?
- **G-Q2:** Can a customer add an order that is **already on another manifest**?
  (Current admin rule blocks cross-manifest duplicates — should apply to customers
  too, recommended.)
- **G-Q3:** One shared "Prepmax Logistics" self-vendor, or one per branch?
  (Recommended: per branch.)
- **G-Q4:** After a customer creates a manifest, is it **editable by the customer**
  while `open`, or **locked** pending staff review? (Recommended: editable while
  open, locked once staff touches it.)

## H. Consolidated to-do for the developer

| # | Item | Type | Priority |
|---|---|---|---|
| 1 | `bank_accounts` table + opening balances (Cash + each bank) | Finance gap (Q7) | High |
| 2 | Dashboard Cash/Bank = all-time running balance (remove date filter) | Finance calc (Q7) | High |
| 3 | Wire `GET /manifests/:id/shipments.csv` (generator already exists) | Export bug (Q4) | High |
| 4 | Excel export: add `exceljs` + `.xlsx` route, OR repoint the button to CSV | Export bug (Q4) | Medium |
| 5 | Customer-portal Manifest module (§G) — routes, portal page, self-vendor, carrier redaction | New feature | Medium |
| 6 | Manifest carrier validation | Confirmed: **do nothing** (intentional) | — |

*Backend verified on `main` @ `4e1a919`; frontend on `main` @ `9372e11`. Live
tests: PDF export 200; CSV + Excel export 404 (§F). All other finance / manifest
/ de-manifest / portal endpoints return 200 and match between frontend and
backend.*

---

# Part 4 — As-Built Technical Reference (2026-07-21)

**This is the authoritative section for a developer.** Parts 1–3 are the design
history and verification; this part documents **what actually exists in the
code**, how the **logic really works** step by step, and the **exact endpoints**.
Backend `main` @ `4e1a919`, frontend `main` @ `9372e11`, deployed to
`api.prepmaxlogistics.com`.

## I. Actual migrations that shipped (correct numbers)

The design placeholders in §3 were renumbered during implementation, and several
extra modules were added that §3 never mentioned. The real list, `0014`+:

| Migration | What it creates / changes |
|---|---|
| `0014_quotes.sql` | **Quotes** module — customer rate-quote requests (not in original scope). |
| `0015_conversations.sql` | **Threaded messages** — `quote_messages` + `complaint_messages` (the "chat" feature). One table per parent; sender = customer or staff. |
| `0015_finance.sql` | **Finance** core — `vendors`, `invoices`, `invoice_items`, `vendor_bills`, `vendor_bill_items`, `payments`, `expenses` + `finance.view/manage` perms. *(Two `0015_` files coexist; the runner tracks by full filename, applies `conversations` before `finance` alphabetically — safe.)* |
| `0016_vendors_created_by.sql` | Adds `vendors.created_by` (idempotent `IF NOT EXISTS`). |
| `0017_vendor_hard_delete_cascade.sql` | Makes `vendor_bills`/`payments` cascade-delete when a vendor is hard-deleted. |
| `0018_manifests.sql` | **Manifest** — `manifests` + `manifest_shipments` + `manifest.view/manage` perms. |
| `0019_de_manifests.sql` | **De-Manifest** — `de_manifests` + `de_manifest_shipments` + `demanifest.view/manage` perms. |
| `0020_de_manifest_manual_fields.sql` | Adds `manual_sender_name/receiver_name/destination` to de-manifest rows (for "extra"/unmatched scans). |
| `0021_credit_note_invoice_link.sql` | Adds `invoices.referenced_invoice_id` (links a credit note to the invoice it offsets). |
| `0022_collapse_view_manage_permissions.sql` | Collapses `<mod>.view`+`<mod>.manage` → single `<mod>.manage` for finance/manifest/demanifest/quotes/complaints. Grants `.manage` to anyone who had `.view`. |
| `0023_estimated_delivery.sql` | Adds `orders.estimated_delivery_min/max` (delivery ETA window, computed on activation — see §M). |
| `0024_saved_contacts.sql` | **Contacts** — saved sender/receiver address book (`contacts` table). Not in original scope. |

**Extra modules NOT in the original design** (built + deployed, documented here
for completeness): **Quotes**, **Conversations/chat**, **Contacts**, **estimated
delivery window**. They follow the same house pattern (branch_id + RLS).

## J. Finance — how the LOGIC actually works

All finance routes are **staff-only, branch-scoped via `req.db` (RLS)**
(`finance/routes.ts:1`). A branch manager sees only their branch; a super-admin
must pass `branchPublicId` for writes (`:75-90`), and the dashboard/reports run
in whatever branch context `req.db` sets.

### J.1 The core idea — DERIVED ledgers (no journal table)
There is **no `ledger_entries` table**. A customer's or vendor's ledger is
**computed at read time** from the source documents. This is why the balance is
always consistent — there's a single source of truth (invoices + payments).

### J.2 Customer Ledger (`finance/queries.ts:1137` `getCustomerLedger`)
Builds a running statement for one customer:
1. **Debits** = that customer's invoices where `status <> 'void'`, taken as
   `i.total AS debit`. (Because a credit note is stored with a **negative
   `total`** — see J.4 — a credit note here is a *negative debit* that reduces
   the balance.)
2. **Credits** = that customer's inbound payments (`direction='in'`), as
   `p.amount AS credit`.
3. The two are `UNION ALL`ed, `ORDER BY dt ASC, ref ASC`.
4. Walk the rows in JS: `balance = balance + debit − credit` per row; each row
   stores its running `balance`.
5. Return `{ entries[], closingBalance }`. **Positive closingBalance = the
   customer owes us that much** (standard AR).

### J.3 Vendor Ledger (`:1185` `getVendorLedger`)
The AP mirror image:
1. Starts from the vendor's `opening_balance` (positive = we owed them on day 1),
   emitted as an "OPENING" row if non-zero.
2. **Credits** = vendor bills (`status <> 'void'`) as `vb.total` — we owe more.
3. **Debits** = outbound payments (`direction='out'`) as `p.amount` — we owe less.
4. Walk: `balance = balance + credit − debit` (note: **opposite** sign to AR).
5. **Positive closingBalance = we owe the vendor.**

### J.4 Credit notes (`:313` `computeInvoiceTotals`)
A credit note is just an invoice row with `is_credit_note = true`. On create, its
`subtotal/tax/total` are **multiplied by −1** so they're stored **negative**.
Effect: in the customer ledger it subtracts from what's owed; in SUM-based
dashboards it reduces revenue/pending correctly — **without any special-casing at
read time**. Guardrail: a credit note that references a specific invoice can't
exceed that invoice's remaining balance (`:385`). Optional link via
`referenced_invoice_id` (`0021`).

### J.5 Invoice numbering (`:322` `nextInvoiceNo`)
`PML-INV-<year>-<6-digit seq>`, per branch. Computed as `MAX(existing seq)+1`
inside a `SELECT … FOR UPDATE` lock, backed by `UNIQUE(branch_id, invoice_no)`.
Concurrent creates are serialized — **no duplicate numbers**.

### J.6 Payments update parent status (`:875` `createPayment`)
On recording a payment against an invoice or vendor bill:
1. Reject if `amount > remaining` (`total − amount_paid`) — no overpayment
   (`:905` invoices, `:917` bills).
2. Insert the payment row.
3. **Re-derive** the parent's `amount_paid = SUM(all its payments)` and
   `status`: `paid` if paid ≥ total, `partial` if > 0, else `unpaid` (`:938-960`).
   It **re-sums every time** (not increment), so it's idempotent and self-heals.
All in one transaction.

### J.7 Dashboard (`:1258` `getFinanceDashboard`) — the numbers
Given an optional `{from, to}` date window:
- **Total Income** = `SUM(payments WHERE direction='in' AND paid_on BETWEEN from,to)`
  → **cash actually received** (Q6). NOT invoiced amounts.
- **Total Expenses** = `SUM(outbound payments) + SUM(expenses)` in the window.
- **Pending Payments (AR)** = `SUM(total − amount_paid)` over `unpaid`+`partial`
  invoices (what customers still owe). **Not date-filtered** (it's a live balance).
- **Pending Vendor Bills (AP)** = same for vendor bills.
- **Profit/Loss** = Total Income − Total Expenses.
- **Cash in Hand** = `SUM(in, cash) − SUM(out, cash) − SUM(expenses, cash)` in the
  window (`account='cash_in_hand'`).
- **Bank Balance** = same for `account='bank'`.
- Plus invoice/vendor-bill counts.
> **⚠️ KNOWN ISSUE (see Part 2 §C-3 + §H):** Cash-in-Hand & Bank Balance are
> **date-window-filtered**, so they show *movement in the period*, not the true
> running balance, and they **ignore opening balances** (which don't exist yet,
> Q7). To fix: compute them all-time (no date filter) and add opening balances.

### J.8 Reports (`:1312` `getFinanceReport`)
`period ∈ {daily, monthly, yearly}`. Uses `date_trunc(period, paid_on/spent_on)`
to bucket, then `FULL JOIN`s income / expense-payments / operating-expenses per
bucket. Each row: `{bucket, income, expensePayments, expenses, net}` where
`net = income − expensePayments − expenses`. Cash-basis, consistent with the
dashboard.

### J.9 Finance staff endpoints (all under `/api/finance`)
```
GET    /dashboard?from&to
GET    /reports?period&from&to
GET    /vendors          POST /vendors
GET    /vendors/:id/ledger
PATCH  /vendors/:id      DELETE /vendors/:id (soft)   DELETE /vendors/:id/hard (cascade)
GET    /customers/:id/ledger
GET    /invoices         POST /invoices
GET/PATCH/DELETE /invoices/:id            (DELETE = void)
GET    /vendor-bills     POST /vendor-bills
GET/PATCH/DELETE /vendor-bills/:id
GET    /payments         POST /payments
GET/DELETE /payments/:id      (delete re-derives parent status)
GET    /expenses         POST /expenses
GET/DELETE /expenses/:id
```
Customer portal (read-only, `/api/portal/finance`): `GET /summary`, `/invoices`,
`/invoices/:id` (ownership-checked), `/payments`.

## K. Manifest — as-built flow

Lifecycle: **open → closed → dispatched** (`manifests.status`). Only **open**
manifests are editable.

1. **Create** (`POST /api/manifests`, `manifest/queries.ts:212`) — auto
   `manifest_no` (`PML-MF-<year>-<seq>`), optional header `vendor_id` (the
   carrier — **one carrier per manifest**, Q3). Starts `open`, totals 0.
2. **Search eligible orders** (`GET /orders/search?q&branchPublicId`) — returns
   orders NOT already on a live manifest, with each order's weight
   (`SUM(boxes.chargeable_kg)`).
3. **Add shipments** (`POST /:id/shipments`, `:276`) — bulk. For each order:
   rejects if it's already on any non-dispatched manifest (**row-locked**
   cross-manifest dup check, `:302`); same-manifest dup ignored via
   `ON CONFLICT`. Then **recomputes cached totals** (`total_shipments`,
   `total_weight_kg` = Σ chargeable_kg) via `recomputeTotals` (`:135`).
4. **Remove shipment** (`DELETE /:id/shipments/:orderId`) — open only, recomputes.
5. **Close** (`POST /:id/close`) — locks editing, records `closed_by`.
6. **Dispatch** (`POST /:id/dispatch`) — sets `dispatched_at`; frees the orders
   from the "live manifest" dup rule (a dispatched manifest no longer blocks).
7. **Print/export**: `GET /:id/manifest.pdf` **works**. `shipments.csv` and
   `shipments.xlsx` are **called by the frontend but 404** — see Part 3 §F.

## L. De-Manifest — as-built reconciliation flow

Purpose: receive an inbound batch and reconcile physical arrivals vs. expected.
Status: **open → completed**.

1. **Create** (`POST /api/de-manifests`) — auto `de_manifest_no`; optional
   `source_manifest_id` (the "expected" list), `vendor_id` or free-text
   `courier_name`, `arrival_hub` (= branch).
2. **Expected rows**: if a `source_manifest_id` is given, its shipments are
   pre-loaded as `reconciliation='pending'` rows (order_id set, not yet received).
   Without a source manifest, there's no fixed expected list — rows appear only
   as scanned.
3. **Scan** (`POST /:id/shipments`, `de-manifests/queries.ts:345`
   `scanShipment`):
   - Match the scanned `tracking_code` to a PML order.
   - **Matched + was pending** → flip that row to `reconciliation='received'`,
     set `received_at`, `condition` (`:374`).
   - **Matched but not on the expected list** → insert a fresh `received` row.
   - **Not matched** (external AWB or unknown) → insert `reconciliation='extra'`
     with the raw `scanned_tracking` + optional manual sender/receiver/dest
     (`:414`). **Both Prepmax & carrier tracking supported** (Q5).
   - **Double-scan blocked** on both paths (`:391`, `:412`).
4. **Manual update** (`PATCH /:id/shipments/:shipmentId`) — staff can set
   condition (`good/damaged/missing/open_package`), reconciliation, remarks.
5. **Complete** (`POST /:id/complete`, `:492`) — locks editing and flips any rows
   still `pending` → `missing` (expected but never scanned).
6. **Counts** (`recomputeCounts`, `:169`), recomputed after every change:
   `total_expected` (all rows except `extra`), `received`, `missing`, `extra`,
   `damaged`. These drive the De-Manifest Report.

## M. Extra modules (built, outside original scope — brief)

- **Quotes** (`0014`, `modules/quotes`) — customer rate-quote requests. Staff
  routes `/api/quotes`, portal `/api/portal/quotes`. Has threaded messages
  (`/:id/messages`) and an SSE `/stream` for live updates.
- **Conversations / chat** (`0015_conversations`) — `quote_messages` +
  `complaint_messages`. A customer files a quote/complaint; staff and customer
  exchange messages on it. Served via the parent's `/:id/messages` routes on the
  quotes and complaints routers (not a standalone module).
- **Contacts** (`0024`, `modules/contacts`) — a saved sender/receiver address
  book so staff/customers don't retype addresses. `/api/contacts`.
- **Estimated delivery** (`0023`) — `orders.estimated_delivery_min/max`, computed
  when an order is activated (first carrier leg attached), from the chosen service
  type + working days (`orders/delivery-times.ts`, `lib/working-days.ts`). The
  public tracking page shows the `max` end of the window (`tracking/public.ts`).

## N. Where to make the outstanding changes (file map for §H to-do)

| To-do (§H) | Files to touch |
|---|---|
| `bank_accounts` + opening balances | new migration `0025_bank_accounts.sql`; `finance/schema.ts`, `queries.ts` (payments/expenses reference a bank_account_id; dashboard sums per account); `finance/routes.ts`; frontend finance page + `lib/api/finance.ts`. |
| Dashboard Cash/Bank = running balance | `finance/queries.ts:getFinanceDashboard` (remove the `BETWEEN from,to` on the cash/bank sub-selects; add opening balances). |
| CSV route | `manifest/routes.ts` — add `GET /:publicId/shipments.csv` calling the existing `manifestShipmentsCsv()` in `manifest/print.ts:177`. |
| Excel route | add `exceljs` to `package.json`; new generator in `manifest/print.ts`; `GET /:publicId/shipments.xlsx` route. (Or repoint the frontend "Excel" button to the CSV url.) |
| Customer-portal Manifest (§G) | new `finance`-style `portalManifestRouter` (`modules/manifest/portal-routes.ts`), mount `/api/portal/manifests` in `app.ts`; seed a "Prepmax Logistics" vendor per branch; new portal page `app/(portal)/portal/manifests/*`; carrier redaction on the portal read model. |

*This as-built reference was written by reading the deployed source; every route
and line reference was confirmed against `main` @ `4e1a919` (backend) and
`9372e11` (frontend). Trust Part 4 over Part 1 §3 wherever they differ.*
