import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { config, assertConfig } from "./config.js";
import { aiMasteringHandler } from "./routes/aiMastering.js";
import { aiCopilotHandler } from "./routes/aiCopilot.js";
import { dbEnabled } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { loadUser, sweepSessions } from "./auth.js";
import { authRoutes } from "./routes/auth.js";
import { projectRoutes } from "./routes/projects.js";
import { presetRoutes } from "./routes/presets.js";
import { renderRoutes } from "./routes/renders.js";
import { referenceRoutes } from "./routes/references.js";
import { albumRoutes } from "./routes/albums.js";

const app = new Hono();

// ── CORS ────────────────────────────────────────────────────────────────────
const originList =
  config.allowedOrigins === "*"
    ? "*"
    : config.allowedOrigins.split(",").map((s) => s.trim()).filter(Boolean);

app.use(
  "*",
  cors({
    origin: originList,
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    // Session cookies need this; browsers reject credentials with origin "*",
    // so a real ALLOWED_ORIGINS list is required for account features.
    credentials: originList !== "*",
    maxAge: 86400,
  }),
);

// ── Body-size guard (larger cap for JSON project/version payloads) ───────────
app.use("/api/*", async (c, next) => {
  const len = Number(c.req.header("content-length") || 0);
  const cap = c.req.path.startsWith("/api/ai-") ? config.maxBodyBytes : 2 * 1024 * 1024;
  if (len && len > cap) return c.json({ error: "Payload too large" }, 413);
  await next();
});

// ── Public routes ───────────────────────────────────────────────────────────
app.get("/", (c) => c.json({ name: "masteringpro-api", status: "ok" }));

app.get("/health", (c) => {
  const problems = assertConfig();
  return c.json(
    {
      ok: problems.length === 0,
      model: config.ai.model,
      fallbacks: config.ai.models,
      db: dbEnabled(),
      problems,
      uptime: Math.round(process.uptime()),
    },
    problems.length === 0 ? 200 : 503,
  );
});

app.post("/api/ai-mastering", aiMasteringHandler);
app.post("/api/ai-copilot", aiCopilotHandler);

// ── Account / project routes (only when a database is configured) ────────────
if (dbEnabled()) {
  app.use("/api/*", loadUser);
  app.route("/api/auth", authRoutes);
  app.route("/api/projects", projectRoutes);
  app.route("/api/presets", presetRoutes);
  app.route("/api/renders", renderRoutes);
  app.route("/api/references", referenceRoutes);
  app.route("/api/albums", albumRoutes);
} else {
  const disabled = (c) => c.json({ error: "Accounts are not enabled on this server" }, 501);
  for (const p of ["/api/auth/*", "/api/projects/*", "/api/presets/*", "/api/renders/*", "/api/references/*", "/api/albums/*"]) {
    app.all(p, disabled);
  }
}

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  console.error("[unhandled]", err);
  return c.json({ error: "Internal error" }, 500);
});

// ── Start ───────────────────────────────────────────────────────────────────
const problems = assertConfig();
if (problems.length) {
  console.warn("⚠  Config warnings:");
  for (const p of problems) console.warn("   - " + p);
  console.warn("   The server will start but AI calls will fail until these are fixed.\n");
}

try {
  await runMigrations();
} catch (e) {
  console.error("✗  Database migration failed:", e.message);
  console.error("   Account/project features will error until the DB is reachable.\n");
}

if (dbEnabled()) {
  const sweep = setInterval(sweepSessions, 6 * 3600_000);
  sweep.unref?.();
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`▶  MasteringPro API on http://${config.host}:${info.port}`);
  console.log(`   AI endpoint : ${config.ai.baseUrl}`);
  console.log(`   AI model    : ${config.ai.model}${config.ai.models.length ? ` (+${config.ai.models.length} fallback)` : ""}`);
  console.log(`   CORS origin : ${config.allowedOrigins}`);
});
