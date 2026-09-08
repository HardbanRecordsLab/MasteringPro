import { chatJson } from "../ai.js";
import { config } from "../config.js";
import { checkRateLimit, clientIp } from "../rateLimit.js";

// ============================================================================
// Platform LUFS / true-peak targets (broadcast / streaming standards)
// ============================================================================
const PLATFORM_TARGETS = {
  spotify: { lufs: -14, tp: -1.0, label: "Spotify / YouTube Music" },
  apple: { lufs: -16, tp: -1.0, label: "Apple Music (Sound Check)" },
  youtube: { lufs: -14, tp: -1.0, label: "YouTube" },
  tidal: { lufs: -14, tp: -1.0, label: "Tidal" },
  amazon: { lufs: -14, tp: -2.0, label: "Amazon Music" },
  club: { lufs: -8, tp: -0.3, label: "Club / DJ" },
  cd: { lufs: -9, tp: -0.1, label: "CD / Loud Master" },
  broadcast: { lufs: -23, tp: -1.0, label: "EBU R128 Broadcast" },
  podcast: { lufs: -16, tp: -1.0, label: "Podcast / Speech" },
};

const STYLE_BRIEF = {
  transparent:
    "Minimal coloration. Surgical EQ cuts before boosts. Gentle 1.5-2:1 compression. Preserve transients and dynamics. No saturation.",
  warm:
    "Analog-style warmth: gentle low-shelf lift, slight high-shelf roll-off, soft-knee compression, subtle tape/tube saturation drive 10-20%.",
  punchy:
    "Emphasize transients: slower attack (15-30ms), faster release, 3:1 ratio, parallel-style makeup gain, slight 80-120Hz bump, 4-6kHz presence.",
  loud:
    "Maximum competitive loudness: aggressive limiting, 4:1+ ratio, fast attack, 1-2 dB clipping headroom. Watch inter-sample peaks.",
  vintage:
    "Vinyl/tape vibe: soft high roll-off above 12kHz, 100Hz warmth, mild compression with long release, saturation 25-35%, narrower stereo.",
  vocal:
    "Voice-forward: 200-400Hz cut, 3-5kHz presence boost, 8-10kHz air, de-ess hint at 6-8kHz, gentle 2:1 comp, no aggressive limiting.",
};

const INTENSITY_HINT = {
  subtle: "Apply 50% strength: gains capped ±3dB, ratio ≤2.5:1, target -1 to -2 LUFS short of platform target.",
  standard: "Apply 100% strength: balanced changes, hit platform LUFS target exactly.",
  aggressive: "Apply 130% strength: bold EQ moves up to ±6dB, ratio up to 4:1, push loudness 0.5 LU over target.",
};

function buildSystemPrompt(stage) {
  const base = `You are a Grammy-nominated mastering engineer with 25 years of experience across all genres. You think like Bob Ludwig, Bernie Grundman and Emily Lazar. You ALWAYS return ONLY raw JSON, never markdown, never prose outside JSON.`;

  if (stage === "analyze") {
    return `${base}
Your job: deep diagnostic analysis of the source track. Identify problems in order of priority. Use psychoacoustic reasoning: Fletcher-Munson, masking, perceived loudness, tonal balance against genre-appropriate curve.`;
  }
  if (stage === "master") {
    return `${base}
Your job: design a complete mastering chain. Hard rules:
1. Limiter ceiling NEVER above platform true-peak target (default -1.0 dBFS).
2. EQ gains between -12 dB and +6 dB. Prefer cuts over boosts.
3. Respect requested style brief verbatim.
4. Hit the requested target LUFS within ±0.5 LU.
5. If source has issues, FIX them first (e.g. mud cut at 250Hz, de-harsh 3kHz, mono-compat HPF on sides below 120Hz).
6. Compressor attack/release must match transient density (high transients → slower attack).
7. Stereo width: never push correlation below 0.2; on low-end mono compat <0.5, apply mid/side narrowing of sides below 200Hz.
8. Include explicit makeup gain so post-comp RMS matches pre-comp within 1 dB.`;
  }
  if (stage === "validate") {
    return `${base}
Your job: act as the QA engineer. Given a proposed chain and source metrics, predict the OUTPUT metrics and flag any safety violations (clipping risk, over-compression, phase issues, masking). If violations exist, return corrective adjustments.`;
  }
  return `${base}
Your job: match source to reference. Compute deltas in frequency balance, dynamics and stereo, then build a chain that closes those gaps without exceeding safety limits.`;
}

function buildMetricsText(m, label = "TRACK") {
  return `${label} METRICS:
- LUFS-I: ${m.lufs} | True Peak: ${m.truePeak} dBFS | DR: ${m.dynamicRange} | LRA: ${m.lra} LU | Crest: ${m.crestFactor} dB
- Noise floor: ${m.noiseFloor} dB | Transients: ${m.transientDensity}/s | Punch: ${m.punchScore ?? "n/a"}/100
- Spectral centroid: ${m.spectralCentroid ?? "n/a"} Hz | Tilt: ${m.spectralTilt ?? "n/a"} dB/oct
- Bands %: Sub ${m.frequencyBalance.sub} | Bass ${m.frequencyBalance.bass} | Mid ${m.frequencyBalance.mid} | HiMid ${m.frequencyBalance.highMid} | Air ${m.frequencyBalance.air}
- Mud (200-500Hz): ${m.mudIndex ?? "n/a"}/100 | Harshness (2-5kHz): ${m.harshnessIndex ?? "n/a"}/100 | Sibilance: ${m.sibilanceLevel ?? "n/a"} dBFS
- Stereo: corr ${m.stereoCorrelation} | width ${m.stereoWidth}% | low-end mono ${m.lowEndMonoCompat ?? "n/a"} | mono: ${m.isMono}
- Tonal balance score: ${m.tonalBalanceScore ?? "n/a"}/100 | DC offset: ${m.dcOffset ?? 0}
- Issues: ${(m.issues || []).join(", ")} | Detected genre: ${m.estimatedGenre}`;
}

// ============================================================================
// Safety post-processing — clamp anything the AI got wrong
// ============================================================================
function enforceSafety(configObj, platform) {
  if (!configObj) return configObj;
  configObj.parametricEQ = (configObj.parametricEQ || []).slice(0, 8).map((b) => ({
    freq: Math.max(20, Math.min(20000, Number(b.freq) || 1000)),
    gain: Math.max(-12, Math.min(6, Number(b.gain) || 0)),
    q: Math.max(0.1, Math.min(10, Number(b.q) || 1)),
    type: ["lowShelf", "bell", "highShelf"].includes(b.type) ? b.type : "bell",
  }));
  if (configObj.compressor) {
    configObj.compressor.threshold = Math.max(-60, Math.min(0, Number(configObj.compressor.threshold) || -12));
    configObj.compressor.ratio = Math.max(1, Math.min(20, Number(configObj.compressor.ratio) || 2));
    configObj.compressor.attack = Math.max(0, Math.min(200, Number(configObj.compressor.attack) || 10));
    configObj.compressor.release = Math.max(10, Math.min(2000, Number(configObj.compressor.release) || 100));
    configObj.compressor.knee = Math.max(0, Math.min(40, Number(configObj.compressor.knee) || 6));
    configObj.compressor.makeupGain = Math.max(-12, Math.min(24, Number(configObj.compressor.makeupGain) || 0));
  }
  if (configObj.limiter) {
    configObj.limiter.ceiling = Math.max(-3, Math.min(platform.tp, Number(configObj.limiter.ceiling) ?? platform.tp));
    configObj.limiter.release = Math.max(10, Math.min(1000, Number(configObj.limiter.release) || 100));
  } else {
    configObj.limiter = { ceiling: platform.tp, release: 100 };
  }
  configObj.stereoWidth = Math.max(0, Math.min(200, Number(configObj.stereoWidth) || 100));
  configObj.inputGain = Math.max(-24, Math.min(24, Number(configObj.inputGain) || 0));
  configObj.targetLUFS = platform.lufs;
  return configObj;
}

/**
 * POST /api/ai-mastering
 * @param {import("hono").Context} c
 */
export async function aiMasteringHandler(c) {
  const json = (obj, status = 200) => c.json(obj, status);

  const ip = clientIp(c);
  const limit = checkRateLimit(ip, "ai-mastering", config.rateLimit.masteringMax);
  if (!limit.ok) {
    c.header("Retry-After", String(limit.retryAfter));
    return json(
      {
        error: `Limit ${config.rateLimit.masteringMax} zapytań AI na godzinę został osiągnięty. Spróbuj ponownie za ${Math.ceil(
          limit.retryAfter / 60,
        )} min.`,
      },
      429,
    );
  }

  let body;
  try {
    body = await c.req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const {
    metrics,
    referenceMetrics,
    mode = "auto",
    platform = "spotify",
    style = "transparent",
    intensity = "standard",
    validate = true,
  } = body || {};

  if (!metrics) return json({ error: "metrics is required" }, 400);

  const platformTarget = PLATFORM_TARGETS[platform] || PLATFORM_TARGETS.spotify;
  const styleBrief = STYLE_BRIEF[style] || STYLE_BRIEF.transparent;
  const intensityHint = INTENSITY_HINT[intensity] || INTENSITY_HINT.standard;
  const isReferenceMatch = mode === "reference-match" && referenceMetrics;

  try {
    // ── STAGE 1 — Mastering chain generation ──────────────────────────────
    const stage = isReferenceMatch ? "reference" : "master";
    let userMsg = buildMetricsText(metrics, "SOURCE");
    if (isReferenceMatch) userMsg += `\n\n${buildMetricsText(referenceMetrics, "REFERENCE")}`;
    userMsg += `\n\nTARGET PLATFORM: ${platformTarget.label} → ${platformTarget.lufs} LUFS-I, true-peak ceiling ${platformTarget.tp} dBFS.`;
    userMsg += `\nMASTERING STYLE: ${String(style).toUpperCase()} — ${styleBrief}`;
    userMsg += `\nINTENSITY: ${String(intensity).toUpperCase()} — ${intensityHint}`;
    userMsg += `\n\nReturn JSON exactly:
{
  "presetName": "string (creative, max 4 words)",
  "genre": "string",
  "confidence": number (0-100),
  "analysisNotes": "string (3-5 sentences: what's wrong, what you'll do, why)",
  "recommendations": ["string", "string", "..."] (3-6 actionable bullets),
  "inputGain": number (dB),
  "parametricEQ": [{"freq": number, "gain": number, "q": number, "type": "lowShelf|bell|highShelf"}] (4-7 bands),
  "compressor": {"threshold": number, "ratio": number, "attack": number (ms), "release": number (ms), "knee": number, "makeupGain": number},
  "stereoWidth": number (0-200, 100 = neutral),
  "limiter": {"ceiling": number (dBFS), "release": number (ms)},
  "targetLUFS": number,
  "saturation": number (0-100, optional),
  "deEsserHint": {"freq": number, "amount": number} (optional, if sibilance > -30 dBFS)
}`;

    let cfg = await chatJson({
      messages: [
        { role: "system", content: buildSystemPrompt(stage) },
        { role: "user", content: userMsg },
      ],
      temperature: 0.25,
      maxTokens: 2200,
    });
    cfg = enforceSafety(cfg, platformTarget);

    // ── STAGE 2 — Validation pass (optional) ──────────────────────────────
    let validationReport = null;
    if (validate) {
      try {
        const valUser = `${buildMetricsText(metrics, "SOURCE")}

PROPOSED CHAIN: ${JSON.stringify(cfg)}

Platform target: ${platformTarget.lufs} LUFS / ${platformTarget.tp} dBFS TP.
Predict OUTPUT metrics after applying this chain, then list any safety violations.

Return JSON:
{
  "predictedLUFS": number,
  "predictedTruePeak": number,
  "predictedDR": number,
  "violations": ["string"] (empty array if none),
  "qualityScore": number (0-100),
  "adjustments": { ...optional partial chain overrides if violations exist... }
}`;
        validationReport = await chatJson({
          messages: [
            { role: "system", content: buildSystemPrompt("validate") },
            { role: "user", content: valUser },
          ],
          temperature: 0.25,
          maxTokens: 900,
        });

        if (validationReport?.adjustments && Object.keys(validationReport.adjustments).length > 0) {
          cfg = enforceSafety({ ...cfg, ...validationReport.adjustments }, platformTarget);
        }
      } catch (e) {
        validationReport = {
          violations: [],
          note: "validation skipped: " + (e instanceof Error ? e.message : "unknown"),
        };
      }
    }

    return json({
      config: cfg,
      metrics,
      platform: { id: platform, ...platformTarget },
      style,
      intensity,
      validation: validationReport,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    let status = 500;
    if (message.startsWith("AI_429")) status = 429;
    else if (message.startsWith("AI_402")) status = 402;
    else if (message.startsWith("AI_")) status = 502;
    return json({ error: message }, status);
  }
}
