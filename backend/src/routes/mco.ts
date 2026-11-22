import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { requireAuth } from "../middleware/auth.js";

export const mcoRoutes = new Hono<AppEnv>();

mcoRoutes.get("/mco/available", (c) => c.text("true", 200));

mcoRoutes.get("/mco/client/compatible", (c) => c.text("COMPATIBLE", 200));

mcoRoutes.get("/mco/client/outdated", (c) => c.text("false", 200));

mcoRoutes.get("/mco/stageAvailable", (c) => c.text("false", 200));

mcoRoutes.get("/mco/v1/news", (c) => c.json({ newsLink: null }));

mcoRoutes.get("/feature/v1", (c) => c.json([]));

mcoRoutes.get("/trial", (c) => c.text("false", 200));

mcoRoutes.get("/activities/liveplayerlist", requireAuth, (c) => c.json({ lists: [] }));

mcoRoutes.get("/regions/preferred", requireAuth, (c) => c.json({ regionDataList: [] }));

mcoRoutes.get("/regions/preferredRegions", requireAuth, (c) => c.json({ regionDataList: [] }));

mcoRoutes.post("/mco/tos/agreed", requireAuth, (c) => c.body(null, 204));

mcoRoutes.get("/notifications", requireAuth, (c) => c.json({ notifications: [] }));

mcoRoutes.post("/notifications/seen", requireAuth, (c) => c.body(null, 204));

mcoRoutes.post("/notifications/dismiss", requireAuth, (c) => c.body(null, 204));

mcoRoutes.post("/regions/ping/stat", requireAuth, (c) => c.body(null, 204));

mcoRoutes.get("/subscriptions/:id", requireAuth, (c) =>
  c.json({
    startDate: Date.now() - 86_400_000,
    daysLeft: 999,
    subscriptionType: "NORMAL",
  })
);

mcoRoutes.get("/worlds/templates/:type", requireAuth, (c) =>
  c.json({
    templates: [],
    page: 0,
    size: 0,
    total: 0,
  })
);
