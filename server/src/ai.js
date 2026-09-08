import { config } from "./config.js";

/**
 * Provider-agnostic chat call against an OpenAI-compatible endpoint (OpenRouter by default).
 * Returns the raw assistant message string.
 *
 * @param {object} opts
 * @param {{role: "system"|"user"|"assistant", content: string}[]} opts.messages
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @param {boolean} [opts.jsonMode]
 */
export async function chat({ messages, maxTokens = 2000, temperature = 0.3, jsonMode = config.ai.jsonMode }) {
  const { baseUrl, apiKey, model, models, appUrl, appTitle, timeoutMs } = config.ai;

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  // OpenRouter attribution headers (ignored by other providers).
  if (appUrl) headers["HTTP-Referer"] = appUrl;
  if (appTitle) headers["X-Title"] = appTitle;

  /** @param {boolean} withJson */
  const buildBody = (withJson) => {
    const body = {
      model: model || models[0],
      messages,
      temperature,
      max_tokens: maxTokens,
    };
    // OpenRouter: automatic fallback across a model list.
    if (models.length > 0) body.models = models;
    if (withJson) body.response_format = { type: "json_object" };
    return JSON.stringify(body);
  };

  const doFetch = async (withJson) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: buildBody(withJson),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }
  };

  let res = await doFetch(jsonMode);

  // Some free models reject `response_format` with a 400 — retry once without it.
  if (!res.ok && res.status === 400 && jsonMode) {
    res = await doFetch(false);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error(`AI_${res.status}:${detail.slice(0, 300)}`);
    // @ts-ignore
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("AI_502:empty completion");
  }
  return content;
}

/** Strip markdown fences / prose and parse the first JSON object or array. */
export function parseJson(raw) {
  let text = String(raw).trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }
  try {
    return JSON.parse(text);
  } catch {
    // fall through to bracket extraction
  }
  const start = text.search(/[[{]/);
  if (start >= 0) {
    const open = text[start];
    const close = open === "{" ? "}" : "]";
    const end = text.lastIndexOf(close);
    if (end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* ignore */
      }
    }
  }
  throw new Error("AI_502:could not parse JSON from completion");
}

/** chat() + parseJson() in one call. */
export async function chatJson(opts) {
  return parseJson(await chat(opts));
}
