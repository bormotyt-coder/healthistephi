// HealthiStephi — Vercel serverless function
// Proxies requests to Anthropic with 4-retry exponential backoff

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callAnthropicWithRetry(body, apiKey, maxRetries = 4) {
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        return { ok: true, data: await response.json(), attempts: attempt + 1 };
      }

      // 4xx errors (except 429) are non-retryable — bail immediately
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        const errText = await response.text();
        return {
          ok: false,
          status: response.status,
          error: `Anthropic API error (${response.status}): ${errText}`,
          attempts: attempt + 1,
        };
      }

      lastError = `HTTP ${response.status}: ${await response.text()}`;
    } catch (err) {
      lastError = err.message || "Network error";
    }

    // Exponential backoff: 500ms, 1s, 2s, 4s
    if (attempt < maxRetries - 1) {
      await sleep(500 * Math.pow(2, attempt));
    }
  }

  return {
    ok: false,
    status: 503,
    error: `Failed after ${maxRetries} attempts. Last error: ${lastError}`,
    attempts: maxRetries,
  };
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST requests allowed" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY environment variable not configured" });
  }

  const body = req.body;

  if (!body.messages || !Array.isArray(body.messages)) {
    return res.status(400).json({ error: "Missing 'messages' array" });
  }

  const anthropicBody = {
    model: body.model || "claude-sonnet-4-6",
    max_tokens: Math.min(body.max_tokens || 800, 2000),
    messages: body.messages,
    ...(body.system && { system: body.system }),
  };

  const result = await callAnthropicWithRetry(anthropicBody, process.env.ANTHROPIC_API_KEY);

  if (result.ok) {
    return res.status(200).json({ ...result.data, _attempts: result.attempts });
  } else {
    return res.status(result.status || 503).json({
      error: result.error,
      attempts: result.attempts,
    });
  }
}
