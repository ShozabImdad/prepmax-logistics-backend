import { chromium } from "patchright";
const b = await chromium.launch({ headless: true });
const p = await (await b.newContext()).newPage();
const errors = [];
p.on("pageerror", e => errors.push("pageerror: " + e.message));
p.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
const R = (n, ok) => { console.log(`  ${ok?"OK ":"FAIL"} ${n}`); return ok; };

await p.goto("http://localhost:3000/login", { waitUntil: "networkidle" });
await p.click("text=Customer");
await p.fill("#email", "portaltest@example.com");
await p.fill("#password", "CustPass123!");
await p.click('button[type="submit"]');
await p.waitForURL("**/portal", { timeout: 15000 }).catch(()=>{});
await p.waitForTimeout(1500);
R("login → /portal", p.url().endsWith("/portal"));
// marketing header should be gone now
const marketingNav = await p.locator("header nav a:has-text('Get a Quote'), a:has-text('Get a Quote')").count();
R("no marketing 'Get a Quote' header in portal", marketingNav === 0);

// booking flow
await p.goto("http://localhost:3000/portal/book", { waitUntil: "networkidle" });
await p.waitForTimeout(1000);
await p.fill('input[name="receiver.name"]', "Test Receiver");
await p.fill('input[name="receiver.city"]', "Dubai");
await p.fill('input[name="receiver.country"]', "UAE");
await p.fill('input[name="boxes.0.weightKg"]', "2");
await p.fill('input[name="boxes.0.lengthCm"]', "20");
await p.fill('input[name="boxes.0.widthCm"]', "20");
await p.fill('input[name="boxes.0.heightCm"]', "20");
await p.fill('input[name="boxes.0.items.0.description"]', "Sample gift");
await p.click('button:has-text("Submit Booking Request")');
await p.waitForTimeout(2500);
const bookingOk = await p.getByText("Booking request submitted").isVisible().catch(()=>false);
R("booking submits → confirmation", bookingOk);
await p.screenshot({ path: "_portal_booked.png", fullPage: true });

console.log("JS errors:", errors.length ? errors.slice(0,5) : "none");
await b.close();
process.exit(0);
