// Flora — Cloudflare Worker (bundled, no external assets)
//
// The frontend (public/index.html) is base64-encoded and prepended to this file
// by scripts/build.sh, defining a global `INDEX_HTML_B64` constant.
//
// Env bindings required (set via scripts/deploy.sh or wrangler):
//   ANTHROPIC_API_KEY — secret used for the Claude Vision call

// eslint-disable-next-line no-undef
const INDEX_HTML = typeof INDEX_HTML_B64 !== 'undefined'
  ? atob(INDEX_HTML_B64)
  : '<h1>Not bundled — run scripts/build.sh</h1>';

const IDENTIFY_SYSTEM_PROMPT = `You are a botanist identifying plants from photographs. For each image, return up to 3 plausible matches, ordered by confidence (highest first). Respond with JSON ONLY — no prose, no markdown fences.

Schema:
{
  "matches": [
    {
      "common_name": "string",
      "scientific_name": "string",
      "family": "string",
      "confidence": 0.0-1.0,
      "tagline": "one short sentence for the reader",
      "description": "2-3 sentences of useful field context",
      "native_range": "string",
      "habitat": "string",
      "edibility": "string — 'Not edible', 'Edible parts: X', etc",
      "bloom": { "months": [1-12 integers], "label": "human readable like 'May – September'" },
      "toxicity": {
        "level": "safe" | "toxic" | "severe",
        "note": "one-sentence safety note for humans and pets"
      },
      "care": {
        "light": "string",
        "water": "string",
        "humidity": "string",
        "temperature": "string (e.g. '18–27°C')"
      },
      "tags": ["short", "tags", "like", "Houseplant", "Flowering", "Drought-tolerant"]
    }
  ]
}

If you cannot identify the plant, return {"matches": []}.
If the image does not contain a plant, return {"matches": []}.
Be conservative with confidence: 0.9+ only for textbook-clear identifications.`;

async function identify(request, env) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const image = body?.image;
  if (typeof image !== 'string' || !image.startsWith('data:image/')) {
    return json({ error: 'Expected { image: "data:image/...;base64,..." }' }, 400);
  }

  const m = image.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!m) return json({ error: 'Malformed image data URL' }, 400);
  const mediaType = m[1];
  const base64 = m[2];

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'Server not configured: missing ANTHROPIC_API_KEY' }, 500);
  }

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: IDENTIFY_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: 'Identify this plant. Return JSON only per the schema in the system prompt.' },
          ],
        },
      ],
    }),
  });

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text().catch(() => '');
    console.error('Anthropic error', anthropicRes.status, errText);
    return json({ error: `Claude API error (${anthropicRes.status})`, detail: errText.slice(0, 500) }, 502);
  }

  const payload = await anthropicRes.json();
  const text = payload?.content?.find(c => c.type === 'text')?.text || '';
  const cleaned = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.error('Could not parse model output as JSON:', text.slice(0, 500));
    return json({ error: 'Model returned non-JSON response', raw: text.slice(0, 500) }, 502);
  }
  if (!parsed || !Array.isArray(parsed.matches)) parsed = { matches: [] };
  return json(parsed, 200);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function serveHtml() {
  return new Response(INDEX_HTML, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/identify') return identify(request, env);
    if (url.pathname === '/api/health') return json({ ok: true, ts: Date.now() });
    // SPA: all other routes return the same HTML
    return serveHtml();
  },
};
