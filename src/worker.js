// Flora — Cloudflare Worker (bundled, no external assets)
//
// The frontend (public/index.html) is base64-encoded and prepended to this file
// by scripts/build.sh, defining a global `INDEX_HTML_B64` constant.
//
// Env bindings required (set via scripts/deploy.sh or wrangler):
//   ANTHROPIC_API_KEY — secret used for the Claude Vision call
//   PLANTNET_API_KEY  — secret used for the Pl@ntNet identification call

// Decode to raw bytes (NOT a JS string) so multi-byte UTF-8 chars like em-dash
// and emojis survive the round-trip. Using a string + Response() would re-encode
// each binary byte as UTF-8, doubling the encoding.
function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// eslint-disable-next-line no-undef
const INDEX_HTML_BYTES = typeof INDEX_HTML_B64 !== 'undefined'
  ? b64ToBytes(INDEX_HTML_B64)
  : new TextEncoder().encode('<h1>Not bundled — run scripts/build.sh</h1>');

// PWA assets — manifest, service worker, icons. All decoded once at
// cold-start and served with the right MIME types.
// eslint-disable-next-line no-undef
const MANIFEST_BYTES = typeof MANIFEST_B64 !== 'undefined' ? b64ToBytes(MANIFEST_B64) : null;
// eslint-disable-next-line no-undef
const SW_BYTES = typeof SW_B64 !== 'undefined' ? b64ToBytes(SW_B64) : null;
// eslint-disable-next-line no-undef
const ICON_192_BYTES = typeof ICON_192_B64 !== 'undefined' ? b64ToBytes(ICON_192_B64) : null;
// eslint-disable-next-line no-undef
const ICON_512_BYTES = typeof ICON_512_B64 !== 'undefined' ? b64ToBytes(ICON_512_B64) : null;
// eslint-disable-next-line no-undef
const ICON_MASK_BYTES = typeof ICON_MASK_B64 !== 'undefined' ? b64ToBytes(ICON_MASK_B64) : null;

const IDENTIFY_SYSTEM_PROMPT = `You are a naturalist identifying plants, fungi, lichens and mosses from photographs. For each image, return up to 3 plausible matches, ordered by confidence (highest first). Respond with JSON ONLY — no prose, no markdown fences.

Schema:
{
  "matches": [
    {
      "common_name": "string",
      "scientific_name": "string",
      "family": "string",
      "category": "tree" | "shrub" | "flower" | "grass" | "fern" | "succulent" | "vine" | "fungus" | "lichen" | "moss" | "other",
      "confidence": 0.0-1.0,
      "tagline": "one short sentence for the reader",
      "description": "2-3 sentences of useful field context",
      "native_range": "string",
      "habitat": "string",
      "edibility": "string — for fungi ALWAYS prefix with 'Do not eat based on photo ID alone.' followed by edibility facts",
      "bloom": { "months": [1-12 integers], "label": "human readable like 'May – September' or '—' if not applicable" },
      "toxicity": {
        "level": "safe" | "toxic" | "severe",
        "note": "one-sentence safety note for humans and pets. For fungi, be explicit about lookalike risks."
      },
      "care": {
        "light": "string",
        "water": "string",
        "humidity": "string",
        "temperature": "string (e.g. '18–27°C')"
      },
      "tags": ["short", "tags", "like", "Houseplant", "Flowering", "Drought-tolerant"],
      "similar": [
        {
          "common_name": "string",
          "scientific_name": "string",
          "differentiator": "one short sentence on how this differs from the main match — focus on a feature the user can actually check (leaf shape, flower colour, habitat, smell, gill colour, etc)"
        }
      ]
    }
  ]
}

The "similar" array should hold up to 3 plausible look-alikes — species in the same genus, family or with similar visual silhouette. For fungi this MUST include known toxic look-alikes when relevant. Skip the field if you genuinely cannot name any.

Category guidance:
- tree: woody, single dominant trunk, typically >4m at maturity
- shrub: woody, multi-stemmed, usually <4m
- flower: herbaceous flowering plant (incl. wildflowers, herbs, houseplants with flowers)
- grass: grasses, sedges, rushes, bamboos
- fern: ferns and fern allies
- succulent: succulents and cacti
- vine: climbers and trailing plants
- fungus: mushrooms, brackets, moulds, any fruiting body of Fungi kingdom
- lichen: crustose/foliose/fruticose lichens
- moss: bryophytes
- other: only if none of the above fit

For FUNGI specifically:
- Be extra conservative with confidence (cap at 0.7 unless distinctive features like gill colour, spore print, habitat are clearly visible)
- Default toxicity to "toxic" unless you are certain the species is safe, since many edible species have deadly lookalikes
- The toxicity.note MUST mention the risk of toxic lookalikes by name where relevant
- tags should include "Mushroom" or "Fungus"
- care.light/water/humidity/temperature may all be "—" (fungi aren't cultivated through those metrics)

If you cannot identify the subject, return {"matches": []}.
If the image does not contain a plant, fungus, lichen or moss, return {"matches": []}.
Be conservative with confidence: 0.9+ only for textbook-clear identifications.`;

const IDENTIFY_POOP_SYSTEM_PROMPT = `You are a wildlife tracker and scat-identification specialist. You are looking at a photograph of animal droppings (scat). For each image, return up to 3 plausible animal sources, ordered by confidence (highest first). Respond with JSON ONLY — no prose, no markdown fences.

Schema:
{
  "matches": [
    {
      "common_name": "string — common animal name (e.g. 'Domestic dog', 'Red fox')",
      "scientific_name": "string — Latin binomial of the animal",
      "family": "string — animal family (e.g. 'Canidae')",
      "category": "scat",
      "confidence": 0.0-1.0,
      "tagline": "one short sentence highlighting the most diagnostic feature",
      "description": "2-3 sentences on what gives it away — size, shape, contents (bone fragments, hair, seeds, plant fibre, insect parts), colour, twist, taper, segmentation",
      "native_range": "where this animal occurs",
      "habitat": "where you typically encounter this scat (path, lawn, woodland edge, near water, latrine site, etc.)",
      "edibility": "Do not handle without gloves. Animal scat can carry pathogens including roundworm, salmonella, leptospirosis, toxoplasmosis and giardia.",
      "bloom": { "months": [], "label": "—" },
      "toxicity": {
        "level": "toxic" | "severe",
        "note": "specific health risks from contact or accidental ingestion (e.g. 'Cat scat carries Toxoplasma gondii — pregnant women should avoid handling.')"
      },
      "care": { "light": "—", "water": "—", "humidity": "—", "temperature": "—" },
      "tags": ["short", "tags", "like", "Carnivore", "Omnivore", "Fresh", "Berry-eater"],
      "similar": [
        {
          "common_name": "string — another plausible animal",
          "scientific_name": "string",
          "differentiator": "one short sentence on what to look for to tell them apart — size, contents, shape, latrine behaviour"
        }
      ]
    }
  ]
}

Diagnostic guidance:
- Size and shape: tubular vs pellet vs splat, twisted ends, tapered points, segmentation
- Contents: hair, bone fragments, seeds, berry skins, plant fibre, insect chitin, grass — these give strong dietary signals
- Colour and freshness: dark and moist = recent; pale and crumbling = old
- Habitat context visible in the photo (path, lawn, woodland, near water, on a prominent rock)
- Common temperate species to consider: domestic dog, domestic cat, red fox, badger, otter (spraint), pine marten, hedgehog, brown rat, grey squirrel, rabbit (round pellets), hare, deer (oval pellets), sheep, horse, cow, fox cub. In other regions consider coyote, raccoon, bear, bobcat, mountain lion, wolf, moose — adapt to plausible regional fauna.

Safety rules (MANDATORY):
- toxicity.level MUST be "toxic" or "severe" — never "safe"
- toxicity.note MUST mention disease risk
- edibility MUST start with "Do not handle without gloves."

If the image does not contain animal scat, return {"matches": []}.
Be conservative with confidence: 0.9+ only when distinctive features (size, contents, twist, segmentation) are clearly visible.`;

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

  // Two modes:
  //   1. Inline data URL — used for fresh scans
  //   2. { entry_id, device_id } — re-identify a stored R2 photo without
  //      requiring the client to upload the photo a second time
  let mediaType, base64;
  if (body?.entry_id && body?.device_id) {
    if (!validateDeviceId(body.device_id)) return json({ error: 'Invalid device_id' }, 400);
    const row = await env.DB.prepare(
      `SELECT photo_key FROM journal_entries WHERE id = ? AND device_id = ?`
    ).bind(body.entry_id, body.device_id).first();
    if (!row || !row.photo_key) return json({ error: 'Entry or photo not found' }, 404);
    const obj = await env.PHOTOS.get(row.photo_key);
    if (!obj) return json({ error: 'Photo missing from R2' }, 404);
    const buf = await obj.arrayBuffer();
    mediaType = obj.httpMetadata?.contentType || 'image/jpeg';
    // Convert to base64 for the Anthropic API
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    base64 = btoa(bin);
  } else {
    const image = body?.image;
    if (typeof image !== 'string' || !image.startsWith('data:image/')) {
      return json({ error: 'Expected { image: "data:image/...;base64,..." } or { entry_id, device_id }' }, 400);
    }
    const m = image.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
    if (!m) return json({ error: 'Malformed image data URL' }, 400);
    mediaType = m[1];
    base64 = m[2];
  }

  // Optional hint about which part of the subject the photo shows. Helps
  // disambiguate when the visible features don't uniquely identify the species.
  const ALLOWED_PARTS = ['whole', 'leaf', 'flower', 'bark'];
  const part = ALLOWED_PARTS.includes(body?.part) ? body.part : null;
  const subject = body?.subject === 'poop' ? 'poop' : 'plant';

  // Pl@ntNet only knows plants. Force Claude when identifying scat.
  const requested = ['plantnet', 'hybrid', 'claude'].includes(body?.source) ? body.source : 'hybrid';
  const source = subject === 'poop' ? 'claude' : requested;
  if (source === 'plantnet') return identifyViaPlantnet({ env, mediaType, base64, part });
  if (source === 'hybrid')   return identifyViaHybrid({ env, mediaType, base64, part });

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'Server not configured: missing ANTHROPIC_API_KEY' }, 500);
  }

  const partHint = part && subject === 'plant'
    ? ` The user has indicated this image shows the ${part === 'whole' ? 'whole subject' : part}.`
    : '';

  const systemPrompt = subject === 'poop' ? IDENTIFY_POOP_SYSTEM_PROMPT : IDENTIFY_SYSTEM_PROMPT;
  const userText = subject === 'poop'
    ? 'Identify the animal source of this scat. Return JSON only per the schema in the system prompt.'
    : `Identify the subject (plant, fungus, lichen or moss).${partHint} Return JSON only per the schema in the system prompt.`;

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
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: userText },
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

// Calls the Pl@ntNet API and returns { ok, status, results } where results is
// an array of { common, scientific, family, score }. Pulled out of the
// HTTP-response layer so the hybrid path can re-use it.
async function callPlantnet({ env, mediaType, base64, part }) {
  const PART_TO_ORGAN = { leaf: 'leaf', flower: 'flower', bark: 'bark', whole: 'auto' };
  const organ = PART_TO_ORGAN[part] || 'auto';

  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const ext = mediaType === 'image/png' ? 'png' : mediaType === 'image/webp' ? 'webp' : 'jpg';
  const blob = new Blob([bytes], { type: mediaType });
  const form = new FormData();
  form.append('images', blob, `photo.${ext}`);
  form.append('organs', organ);

  const url = `https://my-api.plantnet.org/v2/identify/all?api-key=${encodeURIComponent(env.PLANTNET_API_KEY)}&include-related-images=false&no-reject=false`;
  const res = await fetch(url, { method: 'POST', body: form });

  // Pl@ntNet returns 404 + "Species Not Found" for an unmatched image —
  // treat as an empty result, not an error.
  if (res.status === 404) return { ok: true, status: 404, results: [] };

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error('Pl@ntNet error', res.status, errText);
    return { ok: false, status: res.status, error: errText.slice(0, 500) };
  }

  let data;
  try { data = await res.json(); }
  catch { return { ok: false, status: 502, error: 'Pl@ntNet returned non-JSON' }; }

  const results = (Array.isArray(data?.results) ? data.results.slice(0, 3) : []).map(r => {
    const sp = r.species || {};
    const sci = sp.scientificNameWithoutAuthor || '';
    return {
      common: (Array.isArray(sp.commonNames) && sp.commonNames[0]) || sci || 'Unknown',
      scientific: sci,
      family: sp.family?.scientificNameWithoutAuthor || '',
      score: typeof r.score === 'number' ? r.score : 0,
    };
  });
  return { ok: true, status: 200, results };
}

// Pl@ntNet-only path: shape the species list into our standard match
// schema with field-guide fields left blank.
async function identifyViaPlantnet({ env, mediaType, base64, part }) {
  if (!env.PLANTNET_API_KEY) {
    return json({ error: 'Server not configured: missing PLANTNET_API_KEY' }, 500);
  }
  const r = await callPlantnet({ env, mediaType, base64, part });
  if (!r.ok) return json({ error: `Pl@ntNet API error (${r.status})`, detail: r.error }, 502);

  const matches = r.results.map(s => ({
    common_name: s.common,
    scientific_name: s.scientific,
    family: s.family,
    category: 'other',
    confidence: s.score,
    tagline: s.family ? `${s.family} family · identified by Pl@ntNet` : 'Identified by Pl@ntNet',
    description: 'Match from the Pl@ntNet crowdsourced botanical database. No field-guide details available — switch to Hybrid or Claude for care notes, toxicity and similar species.',
    native_range: '',
    habitat: '',
    edibility: '',
    bloom: { months: [], label: '—' },
    toxicity: { level: 'safe', note: 'Pl@ntNet provides no safety data. Verify before consumption or skin contact.' },
    care: { light: '—', water: '—', humidity: '—', temperature: '—' },
    tags: ['Pl@ntNet'],
    similar: [],
  }));
  return json({ matches, source: 'plantnet' }, 200);
}

// Pl@ntNet identifies the species, Claude enriches each one with the
// field-guide fields (care, toxicity, similar species, etc.). Single
// text-only Claude call covers all candidates at once.
const ENRICH_SYSTEM_PROMPT = `You are a botanical/mycological field-guide author. You will receive a list of candidate species already identified from a photograph by another system, with a confidence score and family for each. For each candidate, generate a structured field-guide entry. Respond with JSON ONLY — no prose, no markdown fences.

Schema:
{
  "matches": [
    {
      "common_name": "string — prefer the one provided; improve if the provided one is just the scientific name and a better English common name exists",
      "scientific_name": "string — preserve exactly as given",
      "family": "string — preserve as given unless clearly wrong",
      "category": "tree" | "shrub" | "flower" | "grass" | "fern" | "succulent" | "vine" | "fungus" | "lichen" | "moss" | "other",
      "confidence": 0.0-1.0 (preserve the given score),
      "tagline": "one short sentence for the reader",
      "description": "2-3 sentences of useful field context",
      "native_range": "string",
      "habitat": "string",
      "edibility": "string — for fungi ALWAYS prefix with 'Do not eat based on photo ID alone.' followed by edibility facts",
      "bloom": { "months": [1-12 integers], "label": "human readable like 'May – September' or '—' if not applicable" },
      "toxicity": {
        "level": "safe" | "toxic" | "severe",
        "note": "one-sentence safety note for humans and pets. For fungi, be explicit about lookalike risks."
      },
      "care": {
        "light": "string",
        "water": "string",
        "humidity": "string",
        "temperature": "string (e.g. '18–27°C')"
      },
      "tags": ["short", "tags", "like", "Houseplant", "Flowering", "Drought-tolerant"],
      "similar": [
        {
          "common_name": "string",
          "scientific_name": "string",
          "differentiator": "one short sentence on how this differs from the main match — focus on a feature the user can actually check"
        }
      ]
    }
  ]
}

Preserve the order of the input list. Preserve scientific_name and confidence exactly. The "similar" array should hold up to 3 plausible look-alikes — for fungi this MUST include known toxic look-alikes when relevant. If you don't recognise a species, still fill in family/category-level guidance and acknowledge uncertainty in the tagline.`;

async function enrichWithClaude({ env, candidates }) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('missing ANTHROPIC_API_KEY for Claude enrichment');
  }
  const userText = `Generate field-guide entries for these ${candidates.length} candidate species. Return JSON only per the schema in the system prompt.\n\n${
    JSON.stringify(candidates.map(c => ({
      common_name: c.common,
      scientific_name: c.scientific,
      family: c.family,
      confidence: c.score,
    })), null, 2)
  }`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 3072,
      system: ENRICH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error('Claude enrich error', res.status, errText);
    throw new Error(`Claude API error (${res.status}): ${errText.slice(0, 200)}`);
  }
  const payload = await res.json();
  const text = payload?.content?.find(c => c.type === 'text')?.text || '';
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const parsed = JSON.parse(cleaned);
  if (!parsed || !Array.isArray(parsed.matches)) return { matches: [] };
  return parsed;
}

async function identifyViaHybrid({ env, mediaType, base64, part }) {
  if (!env.PLANTNET_API_KEY) {
    return json({ error: 'Server not configured: missing PLANTNET_API_KEY' }, 500);
  }
  const r = await callPlantnet({ env, mediaType, base64, part });
  if (!r.ok) return json({ error: `Pl@ntNet API error (${r.status})`, detail: r.error }, 502);
  if (r.results.length === 0) return json({ matches: [], source: 'hybrid' }, 200);

  let enriched;
  try {
    enriched = await enrichWithClaude({ env, candidates: r.results });
  } catch (e) {
    console.error('Hybrid enrich failed, falling back to plantnet-only', e);
    // Fall back to the plain plantnet shape so the user still sees a result.
    return identifyViaPlantnet({ env, mediaType, base64, part });
  }

  // Belt-and-braces: even if Claude rewrote them, snap the scientific name
  // and confidence back to the Pl@ntNet values, in case the model drifted.
  const matches = enriched.matches.slice(0, 3).map((m, i) => {
    const src = r.results[i];
    if (!src) return m;
    const tags = Array.isArray(m.tags) ? Array.from(new Set([...m.tags, 'Pl@ntNet'])) : ['Pl@ntNet'];
    return {
      ...m,
      scientific_name: src.scientific || m.scientific_name,
      confidence: src.score,
      tags,
    };
  });
  return json({ matches, source: 'hybrid' }, 200);
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
  return new Response(INDEX_HTML_BYTES, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Short TTL so deploys propagate quickly. Browser revalidates every minute.
      'cache-control': 'public, max-age=0, must-revalidate',
    },
  });
}

function serveStatic(bytes, contentType, cacheControl) {
  if (!bytes) return json({ error: 'Asset missing — rebuild' }, 500);
  return new Response(bytes, {
    headers: { 'content-type': contentType, 'cache-control': cacheControl },
  });
}

// ── Journal (D1) + Photos (R2) ─────────────────────────────────────
// Device ID is an anonymous client-generated UUID held in localStorage.
// It's the only access key — entries are scoped by device_id, and deletes
// only work when the caller presents the owning device_id.

const DEVICE_ID_RE = /^[a-zA-Z0-9-_]{10,64}$/;
const MAX_PHOTO_BYTES = 600 * 1024; // 600 KB after client-side downscale

function validateDeviceId(id) {
  return typeof id === 'string' && DEVICE_ID_RE.test(id);
}

function decodeDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!m) return null;
  const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  return { contentType: m[1], bytes };
}

function extFromContentType(ct) {
  if (ct === 'image/jpeg') return 'jpg';
  if (ct === 'image/png') return 'png';
  if (ct === 'image/webp') return 'webp';
  if (ct === 'image/gif') return 'gif';
  return 'bin';
}

async function journalPost(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const deviceId = body?.device_id;
  if (!validateDeviceId(deviceId)) return json({ error: 'Invalid device_id' }, 400);

  const plant = body?.plant;
  if (!plant || typeof plant !== 'object') return json({ error: 'Missing plant object' }, 400);

  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const category = typeof plant.category === 'string' ? plant.category : 'other';
  const date = typeof body.date === 'string' ? body.date.slice(0, 40) : '';
  const location = typeof body.location === 'string' ? body.location.slice(0, 120) : '';
  const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : '';
  const lat = Number.isFinite(body?.coords?.lat) ? body.coords.lat : null;
  const lng = Number.isFinite(body?.coords?.lng) ? body.coords.lng : null;

  let photoKey = null;
  if (body.image) {
    const decoded = decodeDataUrl(body.image);
    if (!decoded) return json({ error: 'Malformed image data URL' }, 400);
    if (decoded.bytes.length > MAX_PHOTO_BYTES) {
      return json({ error: `Photo too large (${decoded.bytes.length} bytes, max ${MAX_PHOTO_BYTES})` }, 413);
    }
    photoKey = `photos/${deviceId}/${id}.${extFromContentType(decoded.contentType)}`;
    await env.PHOTOS.put(photoKey, decoded.bytes, {
      httpMetadata: { contentType: decoded.contentType },
    });
  }

  // Alternatives: the other Claude matches from the original scan. Stored
  // as JSON so the user can flip to another ID later without re-scanning.
  const alternativesJson = Array.isArray(body.alternatives) && body.alternatives.length
    ? JSON.stringify(body.alternatives.slice(0, 5))
    : null;

  await env.DB.prepare(
    `INSERT INTO journal_entries (id, device_id, plant_json, category, date, location, lat, lng, note, photo_key, created_at, alternatives)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, deviceId, JSON.stringify(plant), category, date, location, lat, lng, note, photoKey, createdAt, alternativesJson
  ).run();

  return json({ id, photo_key: photoKey, created_at: createdAt });
}

async function journalPatch(request, env, id) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const deviceId = body?.device_id;
  if (!validateDeviceId(deviceId)) return json({ error: 'Invalid device_id' }, 400);
  if (!id) return json({ error: 'Missing id' }, 400);

  // Right now only plant + category + alternatives may be rewritten, which
  // is enough to power "use this alternative" and "re-identify this capture".
  const row = await env.DB.prepare(
    `SELECT id FROM journal_entries WHERE id = ? AND device_id = ?`
  ).bind(id, deviceId).first();
  if (!row) return json({ error: 'Not found' }, 404);

  const sets = [];
  const values = [];
  if (body.plant && typeof body.plant === 'object') {
    sets.push('plant_json = ?'); values.push(JSON.stringify(body.plant));
    const cat = typeof body.plant.category === 'string' ? body.plant.category : 'other';
    sets.push('category = ?'); values.push(cat);
  }
  if (Array.isArray(body.alternatives)) {
    sets.push('alternatives = ?'); values.push(body.alternatives.length ? JSON.stringify(body.alternatives.slice(0, 5)) : null);
  }
  if (!sets.length) return json({ error: 'No updatable fields' }, 400);

  values.push(id, deviceId);
  await env.DB.prepare(
    `UPDATE journal_entries SET ${sets.join(', ')} WHERE id = ? AND device_id = ?`
  ).bind(...values).run();
  return json({ ok: true });
}

async function journalList(request, env) {
  const url = new URL(request.url);
  const deviceId = url.searchParams.get('device_id');
  if (!validateDeviceId(deviceId)) return json({ error: 'Invalid device_id' }, 400);

  const { results } = await env.DB.prepare(
    `SELECT id, plant_json, category, date, location, lat, lng, note, photo_key, created_at, alternatives
     FROM journal_entries WHERE device_id = ? ORDER BY created_at DESC LIMIT 500`
  ).bind(deviceId).all();

  const entries = (results || []).map(r => {
    let plant = null;
    try { plant = JSON.parse(r.plant_json); } catch { plant = null; }
    let alternatives = [];
    if (r.alternatives) {
      try { alternatives = JSON.parse(r.alternatives) || []; } catch { alternatives = []; }
    }
    return {
      id: r.id,
      plant,
      category: r.category,
      date: r.date || '',
      location: r.location || '',
      coords: (r.lat != null && r.lng != null) ? { lat: r.lat, lng: r.lng } : null,
      note: r.note || '',
      photoUrl: r.photo_key ? `/api/photos/${r.photo_key}` : null,
      createdAt: r.created_at,
      alternatives,
    };
  });
  return json({ entries });
}

async function journalDelete(request, env, id) {
  const url = new URL(request.url);
  const deviceId = url.searchParams.get('device_id');
  if (!validateDeviceId(deviceId)) return json({ error: 'Invalid device_id' }, 400);
  if (!id) return json({ error: 'Missing id' }, 400);

  const row = await env.DB.prepare(
    `SELECT photo_key FROM journal_entries WHERE id = ? AND device_id = ?`
  ).bind(id, deviceId).first();
  if (!row) return json({ error: 'Not found' }, 404);

  if (row.photo_key) {
    try { await env.PHOTOS.delete(row.photo_key); } catch (e) { console.error('R2 delete failed', e); }
  }
  await env.DB.prepare(`DELETE FROM journal_entries WHERE id = ? AND device_id = ?`)
    .bind(id, deviceId).run();
  return json({ ok: true });
}

async function servePhoto(request, env, key) {
  if (!key || key.includes('..')) return json({ error: 'Bad key' }, 400);
  const obj = await env.PHOTOS.get(key);
  if (!obj) return json({ error: 'Not found' }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(obj.body, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/identify') return identify(request, env);
    if (path === '/api/health') return json({ ok: true, ts: Date.now() });

    // PWA assets
    if (path === '/manifest.json') return serveStatic(MANIFEST_BYTES, 'application/manifest+json; charset=utf-8', 'public, max-age=3600');
    if (path === '/sw.js') return serveStatic(SW_BYTES, 'application/javascript; charset=utf-8', 'public, max-age=0, must-revalidate');
    if (path === '/icon-192.png') return serveStatic(ICON_192_BYTES, 'image/png', 'public, max-age=2592000, immutable');
    if (path === '/icon-512.png') return serveStatic(ICON_512_BYTES, 'image/png', 'public, max-age=2592000, immutable');
    if (path === '/icon-maskable-512.png') return serveStatic(ICON_MASK_BYTES, 'image/png', 'public, max-age=2592000, immutable');
    // iOS doesn't read manifest icons; it looks for /apple-touch-icon.png.
    if (path === '/apple-touch-icon.png' || path === '/apple-touch-icon-precomposed.png') {
      return serveStatic(ICON_192_BYTES, 'image/png', 'public, max-age=2592000, immutable');
    }

    if (path === '/api/journal') {
      if (request.method === 'POST') return journalPost(request, env);
      if (request.method === 'GET') return journalList(request, env);
      return json({ error: 'Method not allowed' }, 405);
    }
    const entryMatch = path.match(/^\/api\/journal\/([a-zA-Z0-9-]+)$/);
    if (entryMatch) {
      if (request.method === 'DELETE') return journalDelete(request, env, entryMatch[1]);
      if (request.method === 'PATCH') return journalPatch(request, env, entryMatch[1]);
    }
    if (path.startsWith('/api/photos/')) {
      return servePhoto(request, env, path.slice('/api/photos/'.length));
    }

    // SPA: all other routes return the same HTML
    return serveHtml();
  },
};
