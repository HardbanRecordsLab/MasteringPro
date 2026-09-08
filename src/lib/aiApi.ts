/**
 * Thin client for the self-hosted MasteringPro API (Node service on the VPS).
 * Replaces the former `supabase.functions.invoke(...)` calls — same
 * `{ data, error }` return shape so call sites stay simple.
 *
 * Configure the base URL with `VITE_API_URL`, e.g.
 *   VITE_API_URL=https://api.masteringpro.yourdomain.com
 *
 * In dev it falls back to the local backend (`cd server && npm run dev`).
 * In a production build `VITE_API_URL` MUST be set (Vercel project env var).
 */

const FALLBACK_BASE = import.meta.env.DEV ? "http://localhost:8787" : "";
const API_BASE = (import.meta.env.VITE_API_URL ?? FALLBACK_BASE).replace(/\/+$/, "");

export type AIFunction = "ai-mastering" | "ai-copilot";

export interface AIError extends Error {
  status?: number;
}

export interface AIResult<T = unknown> {
  data: T | null;
  error: AIError | null;
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any --
   API-boundary type: mirrors the old supabase.functions.invoke() ergonomics so
   call sites can read `data.config` etc. without threading a generic. */
type DefaultPayload = any;

const makeError = (message: string, status?: number): AIError => {
  const err = new Error(message) as AIError;
  if (status !== undefined) err.status = status;
  return err;
};

export async function invokeAI<T = DefaultPayload>(fn: AIFunction, body: unknown): Promise<AIResult<T>> {
  if (!API_BASE) {
    return {
      data: null,
      error: makeError("VITE_API_URL is not configured for this build (set it in the Vercel project settings)"),
    };
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { data: null, error: makeError(e instanceof Error ? e.message : "Network error") };
  }

  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON response */
  }

  const payloadError =
    payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error: unknown }).error)
      : null;

  if (!res.ok) {
    const detail = payloadError || res.statusText || "Request failed";
    // Keep the status code in the message — call sites match on "429" / "402".
    return { data: (payload ?? null) as T | null, error: makeError(`${res.status}: ${detail}`, res.status) };
  }

  return { data: (payload ?? {}) as T, error: null };
}
