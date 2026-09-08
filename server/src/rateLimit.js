import { config } from "./config.js";

/**
 * In-memory sliding-window rate limiter, keyed by client IP + endpoint.
 * Single-process only — resets on restart. For multi-instance, put Redis in front.
 */

/** @type {Map<string, number[]>} bucket key -> sorted list of hit timestamps (ms) */
const buckets = new Map();

const WINDOW_MS = config.rateLimit.windowMin * 60_000;

// Periodic sweep so the map can't grow unbounded.
const sweep = setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, hits] of buckets) {
    const kept = hits.filter((t) => t > cutoff);
    if (kept.length === 0) buckets.delete(key);
    else buckets.set(key, kept);
  }
}, Math.min(WINDOW_MS, 5 * 60_000));
sweep.unref?.();

/**
 * @param {string} ip
 * @param {string} endpoint
 * @param {number} max
 * @returns {{ ok: true } | { ok: false, retryAfter: number }} retryAfter in seconds
 */
export function checkRateLimit(ip, endpoint, max) {
  const key = `${endpoint}:${ip}`;
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const hits = (buckets.get(key) || []).filter((t) => t > cutoff);

  if (hits.length >= max) {
    const retryAfter = Math.max(1, Math.ceil((hits[0] + WINDOW_MS - now) / 1000));
    buckets.set(key, hits);
    return { ok: false, retryAfter };
  }

  hits.push(now);
  buckets.set(key, hits);
  return { ok: true };
}

/**
 * Best-effort client IP.
 * @param {import("hono").Context} c
 */
export function clientIp(c) {
  if (config.rateLimit.trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
    const real = c.req.header("x-real-ip") || c.req.header("cf-connecting-ip");
    if (real) return real.trim();
  }
  // @hono/node-server exposes the socket here
  return (
    c.env?.incoming?.socket?.remoteAddress ||
    c.env?.incoming?.connection?.remoteAddress ||
    "unknown"
  );
}
