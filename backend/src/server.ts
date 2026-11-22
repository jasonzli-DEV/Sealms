import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = createApp();

console.log(`Sealms backend listening on http://localhost:${config.port}`);
serve({
  fetch: app.fetch,
  port: config.port,
});
