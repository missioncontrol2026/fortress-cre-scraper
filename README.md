# Fortress CRE Scraper Service

Playwright-based scraper service that reproduces every CoStar / Reonomy workflow the original Mission Control agents used. Shipped alongside a SearXNG deployment (see `../searxng/`) that covers the Google-mediated workflows.

**Everything in this folder is built from `SPEC.md`**, which is the verbatim extract of the original MC agent specifications. If a workflow behaves differently from the spec, that's a bug in the code — the spec is source of truth.

## Coverage

| ID  | Vendor  | Workflow                                                | Endpoint                              | Agent  |
| --- | ------- | ------------------------------------------------------- | ------------------------------------- | ------ |
| C1  | CoStar  | Comparable-buyers search (full)                         | `POST /costar/buyer-search` mode=full | 3      |
| C2  | CoStar  | Reverse-wholesale Top-5 shortlist                       | `POST /costar/buyer-search` mode=top5 | 3      |
| C3  | CoStar  | National (non-local) buyer discovery                    | `POST /costar/buyer-search` mode=national | 3  |
| C4  | CoStar  | Sales + lease comps for underwriting brief              | `POST /costar/comps`                  | 5      |
| C5  | CoStar  | Property URL / photo for OM                             | `GET /costar/property?address=`       | 5      |
| C6  | CoStar  | 90-day listing re-check for LT-FU leads                 | `GET /costar/property?address=`       | 8      |
| C7  | CoStar  | Authoritative property-type + occupancy + cap-rate confirm | `GET /costar/property?address=`    | 1      |
| R1  | Reonomy | Industrial property list builder                        | `POST /reonomy/property-list`         | 2      |
| R2  | Reonomy | Per-property owner skip-trace                           | `POST /reonomy/owner-detail`          | 2      |
| G1  | Google  | Off-market / listing-status address search              | `GET /search?q="[address]"`           | 1      |
| G2  | Google  | LoopNet Firsthand listing verification                  | `GET /search?q=site:loopnet.com "[address]"` | 1,2 |
| G3  | Google  | Secretary of State entity lookup                        | `GET /search?q="[entity] LLC" [state] secretary of state` | 3,2 |
| G4  | Google  | State/county assessor lookup                            | `GET /search?q="[city] [state] property assessor"` | 1,5 |
| G5  | Google  | Public records / deed change detection                  | `GET /search?q="[address]" deed`      | 1,8    |

All 14 workflows covered. C1/C2/C3 share one endpoint via `body.mode`. C5/C6/C7 share one endpoint (they read the same property detail page for different fields).

## Deploy to Render

1. Push this folder to a GitHub repo (public is fine — no secrets committed).
2. Render dashboard → **New → Web Service** → connect the repo.
3. Language: **Docker** (Render will find `Dockerfile`).
4. Region: **Virginia** (same as LibreChat + SF proxy).
5. Instance: **Starter ($7/mo)** — Playwright needs the RAM; free tier will OOM.
6. Add env vars:

| Key                 | Value                                                                        |
| ------------------- | ---------------------------------------------------------------------------- |
| `PROXY_API_KEY`     | Generate: `openssl rand -hex 32`. LibreChat sends this as Bearer.            |
| `REONOMY_EMAIL`     | Britt's Reonomy login                                                        |
| `REONOMY_PASSWORD`  | Britt's Reonomy password                                                     |
| `COSTAR_EMAIL`      | `alex.j.valley@gmail.com` (Apex-shared seat)                                 |
| `COSTAR_PASSWORD`   | (Ask Brent)                                                                  |
| `PORT`              | `10000` (Render sets this)                                                   |

7. Deploy. Watch logs. First request will fail login until you seed the sessions (next section).

## First-run: seed the sessions and lock the selectors

The current code has real filter/extraction logic but the **CSS selectors are marked `// TUNE`** — CoStar and Reonomy don't publish stable class names, so the first time we log in we snapshot the DOM and pin the selectors.

Two-step process, ~30 min total:

### Step 1 — Log in and save sessions (once)

**Reonomy** (no 2FA):
```
curl -X POST https://fortress-cre-scraper.onrender.com/admin/login/reonomy \
  -H "Authorization: Bearer $PROXY_API_KEY"
```
On success, `/app/sessions/reonomy.storage.json` is written on the Render disk and every subsequent request reuses it.

**CoStar** (2FA — coordinate with Brent):
1. Brent gets a 2FA code ready.
2. Hit:
```
curl -X POST https://fortress-cre-scraper.onrender.com/admin/login/costar \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"code":"123456"}'
```
Session cached to `/app/sessions/costar.storage.json`.

**Session persistence note:** Render's Starter plan disk resets on redeploy. If you redeploy the scraper, you'll need to re-run these logins. For truly persistent sessions, attach a Render disk (~$1/mo for 1GB).

### Step 2 — Tune the selectors (with me driving)

Run a real Reonomy search + a real CoStar search once. I'll open a Chrome MCP session, snapshot the DOM at every step, and pin the selectors marked `// TUNE` in `routes/reonomy.js` and `routes/costar.js`. Then redeploy.

## Rate limits (defined in `lib/rateLimit.js`)

Defaults enforce the SPEC.md caps + human-like pacing:

|          | perMinute | perHour | perDay | perMonth |
| -------- | --------- | ------- | ------ | -------- |
| CoStar   | 4         | 30      | 60     | 400 (of 500 cap) |
| Reonomy  | 6         | 60      | 200    | 3000     |

Check quota anytime:
```
curl https://fortress-cre-scraper.onrender.com/quota \
  -H "Authorization: Bearer $PROXY_API_KEY"
```

## Business rules enforced

Verbatim from `SPEC.md`:

- Mason's immutable Reonomy floor: **15,000 SF minimum, industrial only** — enforced by `min_size_sf` default and `property_types` enum in the OpenAPI.
- Mason's exclusions: **self-storage, strip, hotel, office, mixed-use** — default `exclude_keywords` filters these out of R1 results.
- CoStar C1 exclusions: **REIT, government, non-profit, institutional** — default `exclude`.
- Retry escalations (C1 zero-results): call again with widened `size_multiplier_low/high` (±50%), `radius_miles=75`, `months_back=36`. The agent doing the calling handles the retry logic per SPEC C1 failure modes.
- LoopNet false-positive rule (G2): stale/expired pages are NOT "listed". The agent evaluating SearXNG results has to check for current broker contact + live price before marking `Listed_With_Broker__c = TRUE`.

## Wiring into LibreChat

For **Fortress** and **Apex** agents, add three Actions:

1. **CoStar Scraper** — paste `openapi/costar-openapi.json`, auth = API Key, Auth Type = Bearer, key = the `PROXY_API_KEY`.
2. **Reonomy Scraper** — paste `openapi/reonomy-openapi.json`, same Bearer key.
3. **Fortress Search (SearXNG)** — paste `openapi/searxng-openapi.json`, no auth (public endpoint).

System prompts for each agent explain when to invoke which workflow — see `../system-prompts/`.

## What's *not* built here (deliberately)

- **Direct Salesforce writes**: matches SPEC — agent generates output; human reviews before upsert.
- **CoStar `/photos` fetch**: SPEC C5 kept as placeholder text; we return `photo_url` when the property detail page exposes one, but no bulk photo download.
- **National multi-state entity matching** for C3: the spec flags this as complex; we return national buyer rows tagged with entity name only. Entity-across-states dedupe is a Phase 3 problem.
