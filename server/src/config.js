// Central config — every value is overridable via environment variables.
// See server/.env.example for the full list and recommended presets.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Load server/.env when present (local dev). In Docker, compose injects env
// directly via `env_file:` so this is a harmless no-op.
try {
  const envPath = fileURLToPath(new URL("../.env", import.meta.url));
  if (existsSync(envPath) && typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envPath);
  }
} catch {
  /* no .env / unsupported Node — rely on real env vars */
}

const bool = (v, fallback) => {
  if (v === undefined || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
};
const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const list = (v) =>
  String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  port: num(process.env.PORT, 8787),
  host: process.env.HOST || "0.0.0.0",

  // CORS: comma-separated list of allowed origins, or "*" for any.
  allowedOrigins: process.env.ALLOWED_ORIGINS?.trim() || "*",

  // Postgres connection string. Empty → account/project features are disabled
  // and the API runs as an AI proxy only. On the VPS this comes from Infisical.
  databaseUrl: process.env.DATABASE_URL?.trim() || "",

  // Session cookie lifetime (days) and whether Secure is required.
  sessionDays: num(process.env.SESSION_DAYS, 30),
  cookieSecure: bool(process.env.COOKIE_SECURE, process.env.NODE_ENV === "production"),

  ai: {
    // OpenAI-compatible chat-completions endpoint. OpenRouter by default.
    baseUrl: (process.env.AI_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
    apiKey: process.env.AI_API_KEY || "",
    // Primary model — a strong free model by default.
    model: process.env.AI_MODEL || "deepseek/deepseek-chat-v3-0324:free",
    // OpenRouter fallback chain: tried in order when the primary is down / rate
    // limited / out of credits. Default = free first, then the cheapest capable
    // paid model (fractions of a cent per master). Override with AI_MODELS.
    // OpenRouter caps this list at 3 entries — enforced with slice().
    models: (list(process.env.AI_MODELS).length
      ? list(process.env.AI_MODELS)
      : [
          "deepseek/deepseek-chat-v3-0324:free",
          "meta-llama/llama-3.3-70b-instruct:free",
          "google/gemini-2.5-flash-lite",
        ]
    ).slice(0, 3),
    // Ask the model for strict JSON. Disable if your model rejects response_format.
    jsonMode: bool(process.env.AI_JSON_MODE, true),
    // Sent to OpenRouter for dashboard attribution (optional).
    appUrl: process.env.AI_APP_URL || "",
    appTitle: process.env.AI_APP_TITLE || "MasteringPro",
    timeoutMs: num(process.env.AI_TIMEOUT_MS, 45000),
  },

  rateLimit: {
    // Per client IP, sliding window.
    masteringMax: num(process.env.RATE_LIMIT_MASTERING_MAX, 20),
    copilotMax: num(process.env.RATE_LIMIT_COPILOT_MAX, 60),
    windowMin: num(process.env.RATE_LIMIT_WINDOW_MIN, 60),
    // Trust X-Forwarded-For (set true when behind Caddy / nginx / a load balancer).
    trustProxy: bool(process.env.TRUST_PROXY, true),
  },

  maxBodyBytes: num(process.env.MAX_BODY_BYTES, 256 * 1024),
};

export function assertConfig() {
  const problems = [];
  if (!config.ai.apiKey) problems.push("AI_API_KEY is not set");
  if (!config.ai.baseUrl) problems.push("AI_BASE_URL is empty");
  if (!config.ai.model && config.ai.models.length === 0) problems.push("AI_MODEL is not set");
  return problems;
}
