# CoStar DOM Notes — captured from Alex's live session

Captured 2026-07-07 from `product.costar.com` with Alex's full-Suite login.

## Real URLs (all lowercase, kebab-case, ?new_search=true)

| Purpose | URL |
|---|---|
| All Properties | `https://product.costar.com/search/all-properties/?new_search=true` |
| Multi-Family | `https://product.costar.com/search/multi-family/?new_search=true` |
| Sale Comps | `https://product.costar.com/search/sale-comps/?new_search=true` |
| For Sale listings | `https://product.costar.com/listings/for-sale?new_search=true` |
| For Lease listings | `https://product.costar.com/listings/for-lease?new_search=true` |
| Lease Activity | `https://product.costar.com/suiteapps/lease-activity?new_search=true` |
| Rent Benchmark | `https://product.costar.com/suiteapps/rent-benchmark?new_search=true` |
| Owners → Companies | `https://product.costar.com/suiteapps/owners/companies?new_search=true` |
| Owners → Funds | `https://product.costar.com/owners/funds?new_search` |
| Tenants → Companies | `https://product.costar.com/tenants/companies?new_search` |
| Tenants → Locations | `https://product.costar.com/tenants/locations?new_search` |
| Professionals → Contacts | `https://product.costar.com/app/professionals/contacts/?new_search` |
| Markets & Submarkets | `https://product.costar.com/market/search/map` |
| Public Record (US) | `https://product.costar.com/search/public-record?new_search=true` |
| Data Export center | `https://product.costar.com/AnalyticExport/` |

**Old paths that DO NOT work:** `/Search/SaleComps`, `/Search/LeaseComps`, `/Search/Property` (all capitalized). Legacy paths — CoStar rewrote the SPA sometime in 2024/25.

## Buyer research → Owners → Companies

The real C1 "comparable buyers" search lives at Owners → Companies, not Sale Comps. Sale Comps returns individual transactions; Owners → Companies returns owning entities aggregated across their portfolio, which is what we want for buyer lists.

**Data at hand (unfiltered, national):** 8,540 companies
**Columns (position-indexed, no data-field attrs — CoStar uses `.csg-tw-table-cell` classes only):**

| idx | column | example |
|---:|---|---|
| 0 | select checkbox | — |
| 1 | Company | Blackstone Inc. |
| 2 | Hierarchy | Parent / Subsidiary |
| 3 | Owner Type | Investment Manager, Public REIT, Sovereign Wealth Fund, Insurance Company, Non-Profit, etc. |
| 4 | HQ City | New York |
| 5 | HQ State | New York |
| 6 | HQ Country | United States |
| 7 | Property Count | 11,696 |
| 8 | Total SF Owned | 1,362,355,555 |
| 9 | Avg SF | 116,480 |
| 10 | (SF metric) | 270,092 |
| 11 | (SF metric) | 157,099 |
| 12 | (portfolio count) | 8,616 |
| 13 | Main Property Type | Diversified, Industrial, Multi-Family, Office, Retail |
| 14 | (SF metric) | 28,791,921 |
| 15 | (SF metric) | 12,139,633 |
| 16 | Region | Americas |
| 17 | Country of Investment | United States |
| 18 | Scope | International / Domestic |
| 19 | Recent Deal Count | 123 |
| 20 | Avg Deal $ | $211,381,214 |
| 21 | 12-Month $ | $25,915,491,587 |
| 22 | Total $ Value | $48,459,501,551 |
| 23 | filler | — |

**Filter inputs (by placeholder):**
- `input[placeholder="Owner Name or Ticker"]`
- `input[placeholder="Owner Type"]` (multi-select autocomplete)
- `input[placeholder="Main Property Type"]`
- Portfolio size chip button showing "100K+ SF" default

**Filters button** — opens a side panel with the full filter list including geography radius, buyer types to exclude, etc.
**Export button** — this DOES consume monthly export credits. Do NOT export; only scrape the results table.

## Selectors

**Table:** `table.csg-tw-table`
**Row:** `tr.csg-tw-table-row` (also matches header if included — filter out header by index)
**Cell:** `td.csg-tw-table-cell` (position-indexed; no data-field/data-column attrs)
**Nav tabs:** `button.csg-tui-tab` with `.is-selected` on active tab. Select by textContent: `button.csg-tui-tab:has-text("Owners")`.
**Sub-tabs (Companies/Funds):** same class, another row.

**Sign-in indicator (for ensureLogin):** presence of `button.csg-tui-tab:has-text("Owners")` OR the top-right "Add a Listing" button (`csg-tui-button`) OR the CoStar logo linking away from `/login`.

## Framework

CoStar uses their own component library "csg-tui" + Tailwind (`csg-tw-*` classes). No React `data-testid` attributes on rows/cells — need to select by class + position. Header cells DO have `data-field` attributes worth checking (see `thead th[data-field]`).

## Login flow

Alex uses SSO through `product.costar.com` → redirects to `secure.costargroup.com/login?signin=<TOKEN>`.
- **No 2FA on Alex's account** (confirmed by Britt)
- Email field: `input[name="username"]` or `input[type="email"]`
- Password field: `input[type="password"]`
- Two-step form (email → Continue → password → Submit) — need to click Continue if visible
- Success: URL redirects back to `product.costar.com`

Once logged in, session persists as long as cookies stay — CoStar cookies are long-lived (rolling refresh). With the Render Disk mounted at `/app/sessions`, the storage_state.json will survive redeploys and only re-login when session actually expires.
