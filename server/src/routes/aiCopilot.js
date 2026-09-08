import { chat, parseJson } from "../ai.js";
import { config } from "../config.js";
import { checkRateLimit, clientIp } from "../rateLimit.js";

const PARAM_SPEC = `Editable chain parameters (JSON keys, ranges):
inputGain (-24..24 dB)
eqEnabled (bool), eqBands: array of exactly 5 objects {freq,gain(-12..+6 dB),q,type} in order
  [0] lowshelf ~80Hz, [1] peaking ~250Hz, [2] peaking ~1kHz, [3] peaking ~4kHz, [4] highshelf ~12kHz
compEnabled (bool), compThreshold (-60..0), compRatio (1..8), compAttack (1..100 ms),
compRelease (20..1000 ms), compKnee (0..20), compMakeup (0..12 dB)
saturationEnabled (bool), saturation (0..60)
widthEnabled (bool), stereoWidth (50..150 %)
limiterEnabled (bool), limiterCeiling (-3..-0.1 dBFS), limiterRelease (20..500 ms)
gateEnabled (bool), gateThreshold (-80..0), gateRange (-60..0), gateAttack (0.1..50),
gateHold (0..200), gateRelease (10..1000)
msEnabled (bool), msMidLow/msMidMid/msMidHigh/msSideLow/msSideMid/msSideHigh (-9..+9 dB)`;

const SYSTEM = `Jesteś AI Copilot w aplikacji MasteringPro — doświadczonym inżynierem masteringu.
Rozmawiasz po polsku (chyba że użytkownik pisze w innym języku), krótko i konkretnie, jak kolega w studiu.
Użytkownik opisuje problem słuchowo ("za dużo basu", "wokal ginie", "zrób głośniej na Spotify").
Twoim zadaniem jest zmienić parametry łańcucha masteringowego.

${PARAM_SPEC}

ZASADY:
- Zmieniaj TYLKO to, co potrzebne. Zwracaj w "patch" wyłącznie zmieniane klucze.
- Preferuj cięcia nad podbicia. Nigdy nie przekraczaj zakresów.
- limiterCeiling nigdy powyżej -0.3 dBFS (Spotify/YT: -1.0).
- Jeśli zmieniasz eqBands, zwróć CAŁĄ 5-elementową tablicę (bazując na obecnych wartościach).
- Jeśli użytkownik tylko pyta (bez prośby o zmianę), zwróć pusty patch {}.

Odpowiadaj WYŁĄCZNIE surowym JSON, bez markdown:
{"reply":"krótka odpowiedź (max 3 zdania) po polsku","changes":["Cut 250 Hz -2.5 dB"],"patch":{...}}`;

/**
 * POST /api/ai-copilot
 * @param {import("hono").Context} c
 */
export async function aiCopilotHandler(c) {
  const json = (obj, status = 200) => c.json(obj, status);

  const ip = clientIp(c);
  const limit = checkRateLimit(ip, "ai-copilot", config.rateLimit.copilotMax);
  if (!limit.ok) {
    c.header("Retry-After", String(limit.retryAfter));
    return json(
      {
        error: `Limit zapytań Copilota osiągnięty. Spróbuj ponownie za ${Math.ceil(limit.retryAfter / 60)} min.`,
      },
      429,
    );
  }

  let parsedBody;
  try {
    parsedBody = await c.req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { messages = [], metrics = null, params = null, platform = "spotify" } = parsedBody || {};

  const context = `KONTEKST SESJI:
Platforma docelowa: ${platform}
${
    metrics
      ? `Metryki utworu: LUFS ${metrics.lufs}, TP ${metrics.truePeak} dBFS, DR ${metrics.dynamicRange}, LRA ${metrics.lra}, korelacja ${metrics.stereoCorrelation}, pasma % ${JSON.stringify(
          metrics.frequencyBalance,
        )}, problemy: ${(metrics.issues || []).join(", ") || "brak"}`
      : "Brak analizy utworu (użytkownik może jeszcze nie wgrał pliku)."
  }
Obecne ustawienia łańcucha: ${params ? JSON.stringify(params) : "domyślne"}`;

  const history = (Array.isArray(messages) ? messages : []).slice(-12).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content ?? "").slice(0, 4000),
  }));

  try {
    const text = await chat({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "system", content: context },
        ...history,
      ],
      temperature: 0.4,
      maxTokens: 700,
    });

    let parsed;
    try {
      parsed = parseJson(text);
    } catch {
      parsed = { reply: String(text).slice(0, 800), changes: [], patch: {} };
    }

    return json({
      reply: parsed.reply ?? "",
      changes: Array.isArray(parsed.changes) ? parsed.changes : [],
      patch: parsed.patch && typeof parsed.patch === "object" ? parsed.patch : {},
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    let status = 502;
    if (message.startsWith("AI_429")) status = 429;
    else if (message.startsWith("AI_402")) status = 402;
    return json({ error: message.slice(0, 500) }, status);
  }
}
