import { Hono } from "hono";
import { loadConfig } from "./config.js";
import type { AppDeps, AppEnv } from "./context.js";
import { getCollections, getDb } from "./db/client.js";
import { createMojangClient } from "./lib/mojang.js";
import { createPteroClient, PteroApiError, PteroAuthError } from "./lib/ptero.js";
import { createRateLimiter } from "./lib/ratelimit.js";
import { pingMinecraftServer } from "./lib/slp.js";
import { SsrfError } from "./lib/ssrf.js";
import { authRoutes } from "./routes/auth.js";
import { invitesRoutes } from "./routes/invites.js";
import { mcoRoutes } from "./routes/mco.js";
import { opsRoutes } from "./routes/ops.js";
import { sealmsRoutes } from "./routes/sealms.js";
import { webRoutes } from "./routes/web.js";
import { worldsRoutes } from "./routes/worlds.js";

export function createDefaultDeps(): AppDeps {
  const config = loadConfig();
  return {
    config,
    getCollections: async () => {
      const db = await getDb(config.mongodbUri, config.mongodbDbName);
      return getCollections(db);
    },
    mojang: createMojangClient(),
    ptero: createPteroClient({ allowInsecureLocal: config.allowInsecureLocalPanelUrls }),
    rateLimiter: createRateLimiter(config.upstashRedisRestUrl, config.upstashRedisRestToken),
    pingServer: pingMinecraftServer,
  };
}

export function createApp(customDeps?: AppDeps): Hono<AppEnv> {
  const deps = customDeps ?? createDefaultDeps();
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof SsrfError) {
      return c.json({ error: err.message }, 400);
    }
    if (err instanceof PteroAuthError) {
      return c.json({ error: err.message }, 502);
    }
    if (err instanceof PteroApiError) {
      return c.json({ error: err.message }, 502);
    }
    console.error("[Sealms Backend Error]", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  app.route("/", webRoutes);
  app.route("/", authRoutes);
  app.route("/", mcoRoutes);
  app.route("/", worldsRoutes);
  app.route("/", invitesRoutes);
  app.route("/", opsRoutes);
  app.route("/", sealmsRoutes);

  return app;
}
