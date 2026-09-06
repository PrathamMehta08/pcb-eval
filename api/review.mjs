/**
 * PCB Eval review proxy, Vercel serverless.
 *
 * The board editor runs entirely in the browser. Only the review needs a model,
 * and this is the one place that talks to one, so the API key never leaves the
 * server and no visitor needs an account of their own.
 *
 * WHERE THE REAL LIMIT LIVES
 *
 * Serverless functions have no persistent disk and no shared memory. Counters
 * kept here live in one warm instance, vanish on a cold start, and are not
 * shared with the instance running beside it. That makes them useful for
 * shaping ordinary use and useless as a spending guarantee.
 *
 * So the hard ceiling is the spending limit set in the Groq console. It is
 * enforced by the party doing the billing, survives every cold start, and no
 * amount of parallel instances routes around it. Set it, and treat everything
 * in this file as courtesy on top.
 */

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const API_BASE = process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";

// Calls, not reviews. One review is four model calls, eight if the review loop
// runs a second pass.
const IP_PER_HOUR = Number(process.env.IP_PER_HOUR || 40); // ~5 reviews
const IP_PER_DAY = Number(process.env.IP_PER_DAY || 160); // ~20 reviews

const MAX_PROMPT_CHARS = 40000; // the distilled board plus instructions
const MAX_OUTPUT_TOKENS = 2600; // reasoning models spend budget before answering
const TIMEOUT_MS = 45000;

/**
 * Per-instance counters. Module scope survives between invocations on a warm
 * instance and resets on a cold one, which is the whole guarantee.
 */
const buckets = new Map();

function windowKeys() {
  const d = new Date();
  const day = d.toISOString().slice(0, 10);
  return { day, hour: day + "T" + String(d.getUTCHours()).padStart(2, "0") };
}

/**
 * Vercel sets x-forwarded-for itself and overwrites anything the client sent,
 * so the first entry is the real caller. On generic hosting the same header is
 * client-supplied and trusting it would let anyone mint a fresh identity per
 * request; here the platform is the one writing it.
 */
function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.length) return real;
  return "unknown";
}

function overLimit(ip) {
  const { day, hour } = windowKeys();
  let b = buckets.get(ip);
  if (!b || b.day !== day) b = { day, hour, h: 0, d: 0 };
  if (b.hour !== hour) {
    b.hour = hour;
    b.h = 0;
  }
  if (b.h >= IP_PER_HOUR) {
    return "Too many reviews from this connection this hour. Try again later.";
  }
  if (b.d >= IP_PER_DAY) {
    return "Too many reviews from this connection today. Try again tomorrow.";
  }
  // Counted before the call, so a request abandoned mid-flight still costs
  // quota rather than leaving a hole to drive through by disconnecting early.
  b.h++;
  b.d++;
  buckets.set(ip, b);
  if (buckets.size > 5000) buckets.clear(); // bound the map on a long-lived instance
  return null;
}

function send(res, status, body) {
  res.status(status).setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.json(body);
}

function fail(res, status, code, message) {
  send(res, status, { error: true, code, message });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return fail(res, 405, "method", "POST only.");
  }
  if (!process.env.GROQ_API_KEY) {
    return fail(res, 503, "unconfigured", "The review service is not configured.");
  }

  // Not a security control, since Origin is trivially forged outside a browser,
  // but it stops the endpoint being embedded on someone else's page and
  // spending this key for them.
  const origin = req.headers.origin;
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = "";
    }
    if (originHost && originHost !== req.headers.host) {
      return fail(res, 403, "origin", "Cross-origin requests are not accepted.");
    }
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
  const prompt = body && body.prompt;
  if (typeof prompt !== "string" || !prompt) {
    return fail(res, 400, "bad_request", "Expected a JSON body with a prompt string.");
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return fail(res, 413, "too_large", "Prompt too large.");
  }

  const limited = overLimit(clientIp(req));
  if (limited) return fail(res, 429, "rate_limited", limited);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(API_BASE + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + process.env.GROQ_API_KEY,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        // Reasoning models spend this budget thinking before they answer. Too
        // small and content comes back empty with finish_reason "length".
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const timedOut = e && e.name === "AbortError";
    return fail(
      res,
      502,
      "upstream_error",
      timedOut ? "The model took too long to answer." : "The model could not be reached."
    );
  }
  clearTimeout(timer);

  if (upstream.status === 429) {
    return fail(res, 429, "rate_limited", "The model is rate limiting requests. Try again shortly.");
  }

  // Read once as text, so a failure can be explained rather than guessed at.
  // The first version reported every upstream failure as "The model returned an
  // error", which is true and useless: it covers a spending limit, a context
  // overflow and a malformed request equally, and gives no way to tell them
  // apart from the outside. Provider errors carry a real message; pass it on.
  const rawText = await upstream.text();
  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = null;
  }

  if (!upstream.ok) {
    const detail =
      parsed?.error?.message ||
      parsed?.message ||
      rawText.slice(0, 300) ||
      `HTTP ${upstream.status}`;
    return fail(res, 502, "upstream_error", `The model refused the request: ${detail}`);
  }
  if (!parsed) {
    return fail(res, 502, "upstream_error", "The model's response was not JSON.");
  }

  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    return fail(
      res,
      502,
      "upstream_error",
      "The model returned nothing. Raise max_completion_tokens."
    );
  }

  const result = safeParse(content);
  if (!result || typeof result !== "object") {
    return fail(res, 502, "bad_json", "The model did not return usable JSON.");
  }

  return send(res, 200, {
    result,
    usage: { total_tokens: parsed?.usage?.total_tokens ?? 0 },
  });
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
