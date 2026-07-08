// Server entry point.

import { createApp } from "./app.js";
import { config } from "./config/env.js";
import { closePool } from "./db/pool.js";
import { closePdfBrowser } from "./modules/documents/pdf.js";

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`\n  Prep Max backend listening on http://localhost:${config.port}\n`);
});

async function shutdown() {
  console.log("\nShutting down...");
  server.close();
  await closePdfBrowser().catch(() => {});
  await closePool().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
