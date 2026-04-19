# Flora — a pocket botanist

Mobile-first plant identification web app. Point your camera at a leaf, flower, or whole plant; Claude Vision identifies it and returns care, toxicity, and bloom info. Hosted entirely on Cloudflare at [flora.clydeford.net](https://flora.clydeford.net).

## Architecture

One Cloudflare Worker, one HTML file, one API key.

```
public/index.html    — the whole frontend (React + Babel in-browser, no build step)
src/worker.js        — Worker routes: /api/identify (→ Claude Vision) + SPA fallback
scripts/build.sh     — bundles public/index.html into build/worker.js as base64
scripts/deploy.sh    — uploads Worker, sets secret, binds custom domain via CF API
wrangler.jsonc       — config for wrangler CLI (optional, if you install it)
```

The frontend is a single HTML file. React + Babel transform the JSX in-browser. No Node.js, no Vite, no bundler. Deploys are one curl away.

## Screens

1. **Home** — camera viewfinder + "near you today" carousel + journal bottom sheet
2. **Scan** — radar animation while the photo is sent to Claude Vision
3. **Results** — top-3 matches with confidence ring, tox badge, tags
4. **Detail** — overview / care / nearby / similar tabs
5. **Journal** — saved finds (persisted in `localStorage`, cap 50)

Design source: exported from [Claude Design](https://claude.ai/design). Theme locked to _Mossy_ (juicy greens, generous curves) with _Botanical_ type pairing (Cormorant Garamond + Nunito Sans) and immersive card layout.

## Deploy

Put your secrets in `.env` (gitignored):

```bash
CLOUDFLARE_API_TOKEN=...         # needs Workers Scripts:Edit + DNS:Edit
CLOUDFLARE_ACCOUNT_ID=...
ANTHROPIC_API_KEY=sk-ant-...
```

Then:

```bash
bash scripts/deploy.sh
```

The script:

1. Bundles `public/index.html` into `build/worker.js` (base64-encoded, decoded at cold start)
2. `PUT /accounts/{id}/workers/scripts/flora` — uploads the Worker
3. `PUT .../secrets` — sets `ANTHROPIC_API_KEY` as a Worker secret
4. `PUT .../workers/domains` — binds `flora.clydeford.net` (auto-creates DNS + route)

Override defaults with `FLORA_WORKER_NAME`, `FLORA_HOSTNAME`, `FLORA_ZONE_NAME`.

## API

### `POST /api/identify`

Body: `{ "image": "data:image/jpeg;base64,..." }` (JPEG ≤ 1568px long edge — shrunk client-side)

Response:

```json
{
  "matches": [
    {
      "common_name": "Swiss Cheese Plant",
      "scientific_name": "Monstera deliciosa",
      "family": "Araceae",
      "confidence": 0.94,
      "tagline": "...",
      "toxicity": { "level": "toxic", "note": "..." },
      "care": { "light": "...", "water": "...", "humidity": "...", "temperature": "..." },
      "bloom": { "months": [5, 6, 7], "label": "Late spring – midsummer" },
      "tags": ["Climber", "Aroid", "Houseplant"]
    }
  ]
}
```

Up to 3 matches. Empty array if unidentifiable or non-plant.

### `GET /api/health`

Liveness ping.

## Local iteration

There is no local dev server. Edit `public/index.html`, run `bash scripts/deploy.sh`, test in your phone browser. If you want hot reload, `npm i -g wrangler` and run `wrangler dev` — `wrangler.jsonc` is already wired.
