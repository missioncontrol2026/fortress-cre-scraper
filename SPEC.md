# Mission Control Scraper Service — Complete Spec

**Purpose:** Reproduce every CoStar, Reonomy, and Google Search workflow used by the original Mission Control agent build, so the standalone scraper service can be built from this document alone.

**Source-of-truth docs (all copied verbatim where relevant):**
- `Fortress Agents/03_build/agents/agent_01_lead_enrichment.md` — property enrichment via Google + LoopNet + assessor + CoStar
- `Fortress Agents/03_build/agents/agent_02_list_builder.md` — Reonomy property list scraping + Reonomy owner skip-trace
- `Fortress Agents/03_build/agents/agent_03_buyer_research.md` — CoStar comparable-buyers + reverse-wholesale top-5 + national buyer discovery
- `Fortress Agents/03_build/agents/agent_05_deal_package.md` — CoStar photo links + preliminary comp pull for underwriting brief
- `Fortress Agents/03_build/agents/agent_07_morning_briefing.md` — reads Interested_Buyers records tagged with `Source__c = "CoStar_Buyer_Search"`
- `Fortress Agents/03_build/reference/stage_transitions_matrix.md` — off-market re-check cadence, buyer-to-stage mapping, CoStar 500-export budget
- `Fortress Agents/03_build/agents/agent_01_shirley_dominick_sample.md` — worked example of the Google/assessor/LoopNet chain
- `fortress-retool-rebuild/03_data_model.md` and `06_panel_spec.md` — dashboard treatment (agent runs, not dashboard reads)

**Agents that do NOT invoke CoStar/Reonomy/Google:** Agent 4 (Salesforce Dashboard Fixer, layout cleanup only), Agent 6 (Offer/PSA Prep, template fill only — no external scrapes), Agent 8 (Call QA, Deepgram + Call Tools only).

---

## Global constraints (apply to all tools)

### CoStar
- **Account:** Apex-shared seat under `alex.j.valley@gmail.com`
- **2FA holder:** Brent Kakwitch — real-time 2FA coordination required to open a session
- **Export cap:** 500 exports / month (hard limit)
- **Budget forecast (from Agent 5 spec):**
  - Agent 3 full buyer research: ~5–10 exports per Transaction, ~50/mo at 4 transactions
  - Agent 3 reverse wholesale (top-5): ~1–2 exports per Opportunity, ~20–30/mo at 16 Opps
  - Agent 5 underwriting brief (Phase 2): ~2–3 exports per Opportunity, ~40/mo
  - Total forecast: ~120/mo, well under 500 cap "if disciplined"
- **Usage tracking:** Agent 8 tracks usage; alerts when 80%+ consumed (per stage_transitions §7.4 q14)
- **UI documented as:** "CoStar Apex account" and "CoStar Comps" module — Agent 3 open question notes ambiguity between "buyer search" vs. "Comps" module (spec says "clarify right filter path")

### Reonomy
- **No export on Fortress account** (per stage_transitions glossary — "alternative to CoStar; no export on Fortress account")
- **Access pattern:** Human runs the scrape in browser, copy-pastes results table into Claude chat
- **No 2FA note documented**
- **Owner detail view** used for skip-trace step (Agent 2 Step 6.5)

### Google Search
- Used for **listing-status verification** (Agent 1) — check for active MLS/broker listing
- Query pattern always includes full property address in quotes
- Complementary sources returned: Zillow snippets, Google Street View, Redfin, Trulia, MLS pages
- No rate-limit documented — treated as unmetered

### LoopNet (adjacent to Google; folded into Google workflow)
- **LoopNet Firsthand portal** used to disambiguate "listed vs. stale/expired listing"
- **False-positive rule:** Stale/expired LoopNet pages ≠ listed. A property is "listed" only if LoopNet shows current broker contact + live listing price
- Search by address OR APN

### Human-in-the-loop protocol (applies to all three)
- Agent does NOT have direct scrape access. Human runs the search in the vendor UI. Agent generates the filter spec, receives pasted results, dedupes, formats, and outputs.
- All output CSVs / JSON are drafts — never auto-write to Salesforce.

---

# Tool: CoStar

## Workflow C1 — Comparable-buyers search (full buyer research)

- **Which agent uses it:** Agent 3 (Buyer Research), primary Transaction trigger
- **Trigger:** Salesforce Opportunity StageName = "Under Contract" (Record Type "Fortress Industrial") — full buyer research (20+ buyers targeted). Also supports manual "Research buyers for [property address]" invocation.
- **Purpose:** Identify entities that purchased comparable industrial properties in the region + timeframe, so Fortress can pre-market the deal to warm buyers.

### Input parameters (verbatim from Agent 3 filter spec)

```
CoStar Buyer Search:
- Property type: [Industrial Warehouse / Flex / Manufacturing]
- Purchase date range: [last 24 months]
- Size range: [property_size * 0.7 to property_size * 1.5] SF
- Geography: [within 50 miles of property address]
- Buyer type: Any
- Exclude: REIT, government, non-profit
```

**Filter list (parameterized):**
| Filter | Type | Default | Allowed range/values | Mandatory |
|---|---|---|---|---|
| Property type | picklist | (inherited from Opp) | Industrial Warehouse, Industrial Flex, Industrial Manufacturing | Yes |
| Purchase date range | window | Last 24 months | Expandable to 36 months on zero-results retry | Yes |
| Size range (min SF) | number | property_size × 0.7 | Broadenable to ±50% on zero-results retry | Yes |
| Size range (max SF) | number | property_size × 1.5 | See above | Yes |
| Geography (radius) | number (miles) | 50 miles from property address | Expandable to 75 miles on zero-results retry | Yes |
| Buyer type | multi-select | Any | Any | No |
| Exclude entities | multi-select | REIT, government, non-profit | Also excludes "institutional" per Failure Modes | No |

Concrete example (from spec):
```
CoStar Buyer Search:
- Property type: Industrial Warehouse
- Purchase date range: last 24 months
- Size range: 15,000–45,000 SF
- Geography: within 50 miles of Birmingham, AL
- Exclude: REIT, institutional, gov
```

### Search steps in the UI (as documented)
1. Coordinate with Brent Kakwitch for 2FA (see Human-in-the-loop notes below).
2. Open CoStar Apex account (`alex.j.valley@gmail.com`).
3. Enter the property-type filter (single or multi-select for Industrial Warehouse/Flex/Manufacturing).
4. Set purchase date range (default: last 24 months).
5. Set size range (0.7× to 1.5× subject size).
6. Set geography (radius from property address).
7. Apply exclusions (REIT, government, non-profit, institutional).
8. Run the search.
9. Export results (this consumes ~1 export from the 500/month cap).
10. Copy-paste results table into Claude chat.

### Output fields (verbatim from CoStar results table schema)
| Column | Type | Notes |
|---|---|---|
| Entity Name | text | Buyer legal entity (e.g., "XYZ Capital Partners LLC") |
| Entity Type | picklist (LLC/Corp/Other) | "LLC", "Corp", "Other" |
| Principal Name | text | May be blank OR "agent-of-service [state agency]" only |
| Purchase Address | text | Full street + city, state, zip |
| Purchase Date | date | ISO or MM-DD-YYYY |
| Purchase Size SF | number | Square footage of purchased property |
| Purchase Price | currency | (optional in some result sets; present in Agent 3 scrape schema table) |

### Downstream use
- Feeds Interested_Buyers junction CSV (Salesforce bulk upsert)
- Blank Principal Names → routed to Workflow G3 (Secretary of State lookup, drafted by Agent 3)
- Dedupe check against Salesforce `Buyer_Contacts__c` and `Interested_Buyers__c` (exact + fuzzy 80% match on entity name)
- Confidence score assigned:
  - **HIGH:** LLC principal found via SOS + mailing address + recent purchase
  - **MEDIUM:** LLC with principal in CoStar (no SOS needed) OR SOS returned only agent-of-service
  - **LOW:** LLC with no principal, mailing address only, no recent activity
- CSV column mapping to `Interested_Buyers__c`:
  - `Opportunity_ID__c`, `Buyer_Contact__c`, `Buyer_Entity_Name__c`, `Principal_Name__c`, `Principal_Email__c`, `Mailing_Address__c`, `Recent_Purchase_Address__c`, `Recent_Purchase_Date__c`, `Recent_Purchase_Size_SF__c`, `Confidence_Score__c`, `Source__c = "CoStar_Buyer_Search"`, `Notes__c`

### Rate limits / caps
- 500 exports / month CoStar cap (hard)
- Estimated per invocation (from Agent 3 demo narrative): "~5 exports" per Transaction
- Failure mode: "[N] buyer records collected before export limit hit; recommend batching remaining properties or switching to broker research"

### Human-in-the-loop notes
- CoStar is Apex-shared seat (`alex.j.valley@gmail.com`)
- Brent Kakwitch holds 2FA
- Explicit user-facing warning drafted by Agent 3: `⚠️ NOTE: CoStar is an Apex-shared seat (alex.j.valley@gmail.com). Brent Kakwitch holds 2FA. You may need to coordinate 2FA access before running this search. Export limit: 500/month. This search will consume ~[estimate] exports.`
- Open question in Agent 3 spec: "How should Agent 3 handle Brent's 2FA requirement? Should it output a Slack/email notification to Brent, or is manual coordination acceptable?" — unresolved

### Failure modes (verbatim table)
| Scenario | Action |
|---|---|
| Zero CoStar results | Expand purchase date range (24 → 36 months), expand geography (50 → 75 miles), or broaden size (±50% vs ±30%) |
| All results are REIT/institutional | Confirm filter excludes institutional. May indicate market is REIT-heavy; suggest manual broker outreach instead |
| Principal name is blank for all entities | Proceed to bulk SOS lookup; assign MEDIUM confidence if lookup succeeds, LOW if fails |
| SOS lookup for entity fails (not found in state) | Assign LOW confidence; note "Entity may be shell, dissolved, or filed in different state"; suggest LinkedIn/broker research |
| Entity already in Salesforce (dedupe hit) | Output list of matched Interested_Buyers records; skip upsert; note "Buyer already tracked for different property" |
| Email address blank for all results | Leave principal_email empty; note "requires LinkedIn or manual research"; recommend direct phone outreach instead |
| CoStar export limit hit (500/month cap) | Stop; output: "[N] buyer records collected before export limit hit"; recommend batching remaining properties or switching to broker research |

---

## Workflow C2 — Reverse Wholesale Top-5 buyer pre-marketing (Opportunity stage)

- **Which agent uses it:** Agent 3 (Buyer Research), **Opportunity trigger** (Mason priority addition)
- **Trigger:** Opportunity reaches Stage Opp 2 (Offer Sent) or later
- **Purpose:** Identify top-5 buyers while the deal is still in Opportunity pipeline, so warm buyers exist when PSA is signed. Compresses Transaction timeline by 1–2 weeks.

### Input parameters — "focused" CoStar filter, tighter than full search
| Filter | Value |
|---|---|
| Property type | Same as subject (Industrial Warehouse / Flex / Manufacturing) |
| Size range | property_size × 0.8 to property_size × 1.3 (tighter than 0.7×–1.5×) |
| Geography radius | **25 miles** (hyperlocal, tighter than 50 miles) |
| Purchase date range | Last 18 months (more recent = more active, tighter than 24 months) |
| Result limit | **Top 5 results by recency + size match** |

### Search steps in the UI
1. (Coordinate 2FA — same as C1)
2. Enter tighter filter set above.
3. Run search, sort by recency + size match.
4. Export top-5 rows (consumes ~1–2 exports).

### Output fields — same as C1, but only top-5 rows

### Downstream use
- SOS lookups on top 5 only (skip full dedupe — this is a quick scan)
- Output stored in Opportunity notes field (NOT Interested_Buyers records yet)
- **Guardrail:** NO outreach happens during Opportunity stage. Research-only. Outreach begins after Opportunity converts to Transaction.
- When Opportunity converts to Transaction, top-5 carry forward as first contacts in Interested Buyers pipeline (Stage IB 1: Cold). Agent 6 begins NDA outreach on Day 1 of Transaction.

### Output format (Opportunity-level)
```
REVERSE WHOLESALE — TOP-5 BUYER SHORTLIST
Property: [address]
Generated: [date]
Status: Pre-marketing (Opportunity stage; no outreach until PSA signed)

1. [Entity Name] — [Principal] — purchased [address] ([size] SF) on [date] — [confidence]
2. ...
3. ...
4. ...
5. ...
```

### Rate limits / caps
- ~1–2 exports per invocation
- ~20–30/mo at 16 Opportunities/month (within 500 cap)

### Human-in-the-loop notes
- Same 2FA / Apex-seat / cap-tracking as C1
- Open question: "Should the top-5 shortlist generate at Opp Stage 2 (Offer Sent) or wait until Opp Stage 4 (Negotiation) when the deal is more likely to close? Earlier = more lead time but more wasted research on deals that fall through."

---

## Workflow C3 — National (non-local) buyer discovery (Phase 3, future)

- **Which agent uses it:** Agent 3 (Buyer Research) — Mason's Phase 3 addition
- **Trigger:** After Workflow C1 completes local search (50-mile radius). Optional second pass.
- **Purpose:** Some of the best buyers are national operators/funds who buy in multiple markets. The 50-mile filter misses these.

### Input parameters
| Filter | Value |
|---|---|
| Property type | Same as subject |
| Size range | Same as C1 (0.7×–1.5×) |
| Geography | **NATIONAL** (remove geographic filter) |
| Purchase date range | Last 24 months |
| Buyer filter | Entities that have purchased **3+ industrial properties** across multiple states in last 24 months |
| Result limit | Top 10 national buyers |

### Downstream use
- Added to buyer list at **MEDIUM confidence** by default
- Flagged: "National buyer — may need local market education in outreach"
- Same_entity across different LLC names in different states is a complication flagged in the Phase 3 note

### Rate limits / caps
- Additional CoStar exports on top of C1
- Explicit note: "requires additional CoStar export budget + more complex entity matching"

### Phase
- Phase 3 (post-launch stabilization); NOT built for initial launch.

---

## Workflow C4 — Sales & lease comps pull for underwriting brief (Phase 2)

- **Which agent uses it:** Agent 5 (Deal Package / Underwriting Brief) — Mason's Phase 2 addition
- **Trigger:** Opportunity reaches Stage Opp 1 (Appointment Set) or Stage Opp 2 (Offer Sent)
- **Purpose:** Pull preliminary comp data to help Mason decide offer price BEFORE the deal is under contract

### Input parameters
| Filter | Value |
|---|---|
| Comp type | Sales comps within 5 miles |
| Property type | Industrial (inherited from Opp) |
| Purchase date range | Last 18 months |
| Result set | Recent sales comps (3–5) + recent lease comps (3–5) |
| Assessor data (via CoStar or complementary lookup) | Lot size, zoning, assessed value |

### Search steps in the UI
1. (Coordinate 2FA)
2. Sales-comps tab: filter to 5-mile radius, last 18 months, industrial type
3. Export sales comps
4. Lease-comps tab: same filter
5. Export lease comps
6. Pull property assessor data (lot size, zoning, assessed value) — cross-reference through CoStar or via assessor workflow (G4 below)

### Output fields (comp table)
| Column | Type |
|---|---|
| Comp address | text |
| Comp price per SF | currency |
| Comp date | date |
| Size SF | number |
| (for lease comps) $/SF NNN or Gross | currency + type |

### Downstream use — "Underwriting Brief" output format
```
UNDERWRITING BRIEF — [Property Address]
Asking: $X | Size: [SF] sf | Lot: [acres] ac
Market comps (sales): $X-$Y/sf (3 comps, last 18 mo)
Market comps (lease): $X-$Y/sf NNN (3 comps)
Assessed value: $X (county assessor, [year])
Implied cap at ask: X.X%
Fortress MAO estimate: $X (based on [method])
RECOMMENDATION: [Pursue at $X / Pass / Need more data]
```

### Rate limits / caps
- ~2–3 CoStar exports per Opportunity
- ~40/mo at 16 Opps/mo

### Downstream field mapping (Opportunity notes)
- Stored as `Underwriting_Brief` note on Opportunity
- Carried forward to OM (Offering Memorandum) when deal converts to Transaction — no re-research needed
- Feeds `Comp_Address__c`, `Comp_Price_SF__c` custom fields on Opportunity for later OM generation

### Phase
- Phase 2. Requires CoStar comp access (same human-in-loop pattern as Agent 3).

---

## Workflow C5 — Photo/link references in OM (Offering Memorandum)

- **Which agent uses it:** Agent 5 (Deal Package) — active workflow, Transaction stage
- **Trigger:** Opportunity converts to Transaction; OM generation

### Input parameters
- No filter; direct URL lookup for the subject property in CoStar
- Property address is the key

### Search steps in the UI
1. Look up subject property in CoStar
2. Copy photo permalink OR Drive-mirrored image link

### Output fields
- Photo placeholder text inserted into OM section:
  - `[Photos available on CoStar: <link>]` OR `[Photos in deal folder]`

### Downstream use
- Placeholder text in Offering Memorandum "Condition" section
- Never auto-fetched by agent (open question #2 in Agent 5 spec: "Should Agent 5 fetch CoStar photos automatically (if API available) or just link placeholders? — Recommendation: placeholder for CoStar link; manual review step for Mason.")

### Rate limits / caps
- No export consumed for photo-link references (just URL copy)

---

## Workflow C6 — 90-day listing re-check for Long-Term Follow-Up leads

- **Which agent uses it:** Agent 8 (Call QA / cadence monitoring), or CRM automation
- **Trigger:** Lead is in Stage 6 (Long-Term Follow-Up) with `Listed_With_Broker__c = TRUE`, automated 90-day cadence fires
- **Purpose:** If a previously listed property is now delisted, re-engage seller

### Input parameters
- Property address (from Lead)
- Time window: 90 days since last check
- CoStar "listing status" check — is the property currently listed with a broker?

### Search steps in the UI
1. Open CoStar
2. Search property by address or APN
3. Note listing status: Active / Expired / Delisted / Not Found
4. Compare to prior status stored on Lead

### Output fields
- `listing_status`: Active / Expired / Delisted / Not Found
- If Delisted or Expired: recommend transition Lead → Stage 3 (Working — Cold), set `Listed_With_Broker__c = FALSE`, `Qualified_Mason_KPI__c = TRUE`

### Downstream use
- Update Lead field `Listed_With_Broker__c`
- Trigger stage transition rules per Stage 6 → Stage 3 in stage_transitions_matrix
- If still listed after 12+ months of re-checks, move Lead → Stage 7 (Dead)

### Rate limits / caps
- Volume: dependent on LT-FU backlog. Documented open question #7.3.3 in stage_transitions_matrix: "The 90-day re-check assumes CoStar API or scheduled export availability. How do we implement? Agent 8 manual check? Automated Zapier CoStar query? — RECOMMENDATION: Confirm CoStar export capability + budget before finalizing automation rules."

### Human-in-the-loop notes
- Same 2FA / Apex seat
- Currently manual (Agent 8 flags for manual re-check); automation TBD

---

## Workflow C7 — Property-type + occupancy + cap rate confirmation (Agent 1 enrichment)

- **Which agent uses it:** Agent 1 (Lead Enrichment) — quaternary source
- **Trigger:** New Lead created; enrichment chain reaches CoStar as authoritative confirmation
- **Purpose:** Authoritative property type + square footage + occupancy + cap rate comps

### Input parameters
- Property address (from Lead)

### Search steps in the UI
1. Look up property address in CoStar
2. Extract: authoritative property type, occupancy status, cap rate comps for the submarket

### Output fields
- Property Type (authoritative override)
- Occupancy status
- Cap rate comp range

### Downstream use
- Feeds Agent 1 enrichment proposal JSON
- Overrides county assessor data if conflict (CoStar is treated as authoritative for property type)
- Escalation path: "If Size range spans above and below 15k sqft threshold → Show range; flag as 'borderline'; recommend CoStar for authoritative count."

### Rate limits / caps
- Exports subject to 500/mo cap (each authoritative lookup = 1 export)
- Optional / quaternary — Agent 1 can complete without CoStar if 2FA unavailable

### Human-in-the-loop notes
- Open question #1 in Agent 1 spec: "CoStar credential scope: Is Brent Kakwitch available for real-time 2FA during demo, or should we assume CoStar lookup is blocked during the live run? (Affects whether we can show an actual CoStar verification step.)"
- Explicit failure-mode row: "LoopNet/CoStar down or inaccessible → Proceed with Google + assessor data; note limitation in enrichment summary. Recommend human re-check in 24h."

---

# Tool: Reonomy

## Workflow R1 — Industrial property list builder

- **Which agent uses it:** Agent 2 (List Builder)
- **Trigger:** User request "Build me a list for [region] / [size range] / [asset subtype]" OR weekly/ad-hoc "Refresh the [region] pipeline"
- **Purpose:** Generate industrial property list matching Mason's criteria; dedupe against CK call list; output CSV for Salesforce/Call Tools upload

### Input parameters (verbatim from Agent 2 Reonomy Filter Spec)

```
Reonomy Filter Specification:
- Property type: [exact Reonomy values, e.g., "Industrial - Warehouse" OR "Industrial - Flex"]
- Size: [floor]+ SF
- Geography: [counties or cities]
- Owner type: [Private / exclude REIT]
- Years owned: 10+
- Exclude keywords: [self-storage, strip, hotel, etc.]
```

**Full filter list:**
| Filter | Type | Default | Allowed range/values | Mandatory |
|---|---|---|---|---|
| Property type | multi-select | (user-specified) | Exact Reonomy values: "Industrial - Warehouse", "Industrial - Flex", "Industrial - Manufacturing" ONLY | Yes |
| Property type EXCLUDES | (fixed) | Self-storage, strip retail, hotels, office, mixed-use | (immutable per Mason) | Yes |
| Size floor | number | 15,000 SF (Mason's immutable floor) | User can raise floor for tighter list (e.g., 20k+) | Yes |
| Geography | multi-value | (user-specified) | Counties or cities. Example: "Davidson, Williamson, Rutherford counties TN" | Yes |
| Owner type | picklist | Private preferred | Exclude REIT; flag institutional for manual review | Yes |
| Years owned | number | 10+ (preferred) | Hard rule per spec; open question #3 asks if 8–10 year properties should be flagged instead of excluded | Yes |
| Exclude keywords | free text | self-storage, strip, hotel | Also excludes anything matching Mason's excluded asset types | No |

**Off-market rule (post-filter, per Mason):** "NOT currently listed on broker site, NOT on auction (CoStar FP check: if property appears in LoopNet 'for sale' or 'for lease' within 90 days, EXCLUDE it)"

### Search steps in the UI (as documented)
1. Human runs the generated filter spec in Reonomy UI (agent does NOT have direct access).
2. Copy/paste the results table into Claude chat.

### Output fields (expected columns from Reonomy results page)
| Column | Type | Notes |
|---|---|---|
| Property Name | text | Building or complex name |
| Address | text | Street address |
| City | text | |
| State | text | 2-char |
| Size SF | number | |
| Property Type | picklist | Reonomy classification |
| Owner | text | Entity name (e.g., LLC or individual) |
| Years Owned | number | Ownership tenure |
| Owner Contact (Email/Phone) | text | May be absent |

### Downstream use
- **Dedupe against CK call list** (phone exact match; address fuzzy: street# + street name + city/state match, ZIP-mismatch tolerated)
- **Rule filter re-check** (self-storage, strip, hotel, <15k, institutional REIT flag)
- **Skip-trace routing** (Workflow R2 below) for properties without owner contact
- **Output CSV** for Call Tools bulk upload:
  ```
  first_name,last_name,company,address,city,state,zip,phone,property_address,property_type,sq_ft,notes,campaign_tag
  ```
- **Salesforce Lead field mapping:**
  - `Company` = owner_name
  - `Address` / `City` / `State` / `PostalCode` = property fields
  - `Record Type` = "Fortress Industrial"
  - `CK_List_Origin__c` = campaign_tag (e.g., `nashville_industrial_2026q2`)
  - `Notes` = property details

### Rate limits / caps
- No documented cap (unlike CoStar 500/mo)
- No export budget concern

### Human-in-the-loop notes
- Reonomy access is human-only. Human runs UI, copy-pastes.
- No 2FA note documented.
- Format issue: "Pasted table has unexpected columns → Ask human to re-copy from Reonomy with standard columns"

### Failure modes (verbatim table)
| Scenario | Action |
|---|---|
| Zero results from Reonomy | Suggest: expand geography (add counties), lower size floor, or relax asset type (add office/flex retail if applicable) |
| All properties match CK list | Suggest: run CoStar comparable-buyers search instead, OR ask if list should be date-filtered (recent 90-day acquisitions) |
| Reonomy scrape has unexpected columns | Ask human to re-copy from Reonomy UI ensuring standard columns visible |
| Owner name is corporate shell (e.g., "ABC Ventures Fund IV LP") | Flag for manual review; note that principal name may require Secretary of State lookup |
| Years owned = 0 or missing | Flag as "recently acquired"; suggest manual review for off-market timing |
| Zip code mismatch in dedupe | Accept address match if street + city/state align (ZIP is often stale) |

---

## Workflow R2 — Per-property owner skip-trace (Reonomy owner detail view)

- **Which agent uses it:** Agent 2 (List Builder) — Mason's Phase 1 Enhancement, inserted between spec Steps 6 and 7
- **Trigger:** For each property that passes rule filters AND has no owner phone/email from Reonomy results table
- **Purpose:** Enrich the property list with owner contact info before hitting Call Tools

### Input parameters
- Owner entity name (LLC, trust, individual) — from the R1 results table

### Search steps in the UI
1. Open the Reonomy **owner detail view** for the entity
2. If Reonomy shows a contact: capture phone + email if available
3. If Reonomy shows only an LLC with no contact: this becomes a Secretary of State lookup task (routes to Workflow G3)

### Output fields
Per property, add a `skip_trace_status` column:
| Value | Meaning |
|---|---|
| `FOUND` | phone/email obtained |
| `SOS_NEEDED` | LLC registered agent lookup required (human task; Workflow G3) |
| `MAIL_ONLY` | mailing address found, no phone (direct mail candidate) |
| `NOT_FOUND` | no contact info available (drop or flag for manual research) |

### Downstream use
- Adds phone to Call Tools CSV `phone` column when `FOUND`
- `MAIL_ONLY` → flagged as "mail campaign candidate" in separate output bucket
- `SOS_NEEDED` → drives Workflow G3 (Secretary of State lookup) — could be handled by Agent 2 human-in-loop or handed off to Agent 3 (open question #7 in Agent 2 spec)

### Rate limits / caps
- None documented

### Human-in-the-loop notes
- Same pattern as R1: Agent 2 generates the skip-trace spec, human runs Reonomy's owner detail view, pastes back results

---

# Tool: Google Search

## Workflow G1 — Off-market / listing-status verification (address search)

- **Which agent uses it:** Agent 1 (Lead Enrichment) — first step in property research chain
- **Trigger:** Every new Lead in "New Lead" status with a property address
- **Purpose:** Detect if the property is actively listed with a broker, or on an auction site — critical for the off-market gate

### Input parameters
- Full property address (mandatory)

### Query pattern (verbatim from Agent 1 spec)
```
"[full address]"
```
Concrete examples (from Shirley Dominick sample and Agent 1 spec):
- `"16013 Waterfall Rd" "Haymarket VA 20169"`
- `"16013 Waterfall Rd Haymarket VA 20169"` (also documented as a single-quoted variant)

### Search steps in the UI
1. Execute Google search with quoted full address
2. Review top results for signals of:
   - Active MLS listing (Redfin, Zillow, Trulia, MLS pages)
   - Broker website with active listing
   - Listing announcement press release
   - Auction site listing (LiveAuctioneers, Ten-X, etc.)
   - Zillow classification (Residential vs. Commercial) — feeds property-type inference
3. Cross-reference with Google Street View (Google Maps) for visual confirmation of architecture (residential vs. warehouse/industrial)

### Output fields
| Field | Type | Notes |
|---|---|---|
| Active MLS listing found | boolean | With source URL if TRUE |
| Broker listing URL | text | If any |
| Auction site listing | boolean | With URL if TRUE |
| Zillow snippet | text | Property classification hint |
| Google Street View URL | text | Used for visual confirmation |
| Result snippet examples | text | Copied into enrichment_summary |

### Downstream use
- Feeds Agent 1 `listed_with_broker` field (`{ value, confidence, source }`)
- Feeds `off_market_verified` field
- Feeds `Property_Type__c` inference (Residential vs. Industrial)
- Sources cited verbatim in Agent 1 `sources_consulted` array:
  ```json
  "Google search: '16013 Waterfall Rd Haymarket VA 20169' (2026-04-23 22:15 UTC)"
  ```
- Feeds enrichment_summary narrative

### Rate limits / caps
- None documented

### Human-in-the-loop notes
- Automated agent step (LLM does the search or generates the query for a scraper to run)
- No 2FA / credentials required

### Failure modes
- "Address malformed or incomplete" → Flag: "Address missing [street/city/state]. Manual lookup required."
- Ambiguous property type (light industrial vs. mixed-use) → escalate to CoStar (Workflow C7)

---

## Workflow G2 — LoopNet Firsthand portal listing verification

- **Which agent uses it:** Agent 1 (Lead Enrichment), Agent 2 (List Builder — off-market re-check per Mason's rule)
- **Trigger:** After Google search (G1), or during Agent 2 post-filter validation
- **Purpose:** Disambiguate "listed vs. stale/expired listing" (Google alone can surface expired listings that look active)

### Input parameters
- Property address OR APN

### Search steps in the UI
1. Open LoopNet Firsthand portal
2. Search by address (fallback: APN)
3. Determine listing status:
   - **Live listing** = current broker contact + live listing price → property IS listed
   - **Stale/expired** = old page, no current contact, no live price → property is NOT considered listed (per Fortress false-positive rule)
   - **No record** = property not in LoopNet → off-market

### Output fields
| Field | Type | Notes |
|---|---|---|
| Listing status | picklist (Live / Stale / No record) | |
| Broker name | text | If live |
| Broker contact | text | If live |
| Listing price | currency | If live |
| Listing URL | text | If exists (stale or live) |

### Downstream use
- Confirms/overrides Google (G1) determination
- Feeds `Listed_With_Broker__c` (boolean) — TRUE only if LoopNet shows live listing per false-positive rule
- Feeds `Off_Market_Verified__c` (boolean)
- For Agent 2 List Builder: "if property appears in LoopNet 'for sale' or 'for lease' within 90 days, EXCLUDE it"

### Rate limits / caps
- None documented
- Failure mode: "LoopNet unavailable → Use Google + state assessor only; note limitation."

### Human-in-the-loop notes
- Automated where possible; falls back to human if LoopNet UI blocks scraping
- Same false-positive discipline applies: expired pages ≠ listed

---

## Workflow G3 — Secretary of State entity lookup (via web search)

- **Which agent uses it:** Agent 3 (Buyer Research) primarily; also invoked by Agent 2 skip-trace (R2 `SOS_NEEDED` status)
- **Trigger:** CoStar returned an entity with blank Principal Name OR only "agent-of-service [state agency]" — extract real principal
- **Purpose:** Extract LLC principal names, mailing addresses, formation date from state business searches

### Input parameters
- Entity name (LLC / Corp)
- State of formation (inferred from purchase address by default; open question #6 asks about multi-state check)

### Query / search steps (documented instruction Agent 3 outputs to human)
```
Secretary of State Lookup Required:
Entity: ABC Ventures LLC (AL)
Go to: https://arc-sos.alabama.gov/
Search: "ABC Ventures LLC"
Paste back: Principal name, mailing address, formation date
```

Steps:
1. Navigate to state Secretary of State business search URL (e.g., `arc-sos.alabama.gov` for Alabama)
2. Search the entity name
3. Extract: Principal name, Manager address, Formation date, Entity status

### Output fields (verbatim from Agent 3 SOS lookup result schema)
```
Entity: ABC Ventures LLC (Alabama)
State: Alabama
Business ID: 123456789
Principal/Manager: John Smith
Manager address: 789 Main St, Montgomery, AL 36104
Formation date: 2022-03-15
Entity status: Active
```

| Field | Type | Notes |
|---|---|---|
| State | text | |
| Business ID | text | State-issued identifier |
| Principal / Manager | text | The real person |
| Manager address | text | Mailing address (used for outreach) |
| Formation date | date | ISO |
| Entity status | picklist (Active/Dissolved/etc.) | |

### Downstream use
- Fills `Principal_Name__c`, `Mailing_Address__c` in Interested_Buyers junction (Agent 3)
- Fills owner contact for Call Tools list (Agent 2 R2 `SOS_NEEDED` resolution)
- Determines confidence score:
  - Principal found → HIGH
  - Only agent-of-service found → MEDIUM
  - Entity not found in state → LOW
- Recommended `Notes__c` (Agent 3): "Principal from SOS, agent-of-service only" or "Entity may be shell, dissolved, or filed in different state"

### Rate limits / caps
- No API caps — but each state has different search UI, some require CAPTCHAs
- Time cost: per lookup, manual

### Human-in-the-loop notes
- Agent 3 outputs the lookup instruction to human; human runs and pastes back
- Open question #6 (Agent 3): "Should Agent 3 assume all LLCs are single-state (e.g., ABC Ventures LLC = Alabama)? Or should it check multi-state filings (formations in DE, FL, etc.)?"
- Phase 2 alternative: skip-trace API (BatchSkipTracing, TLO, BeenVerified Pro) — see Agent 3 Phase 2 expansion; $0.10–$0.50 per record; requires 2–3 provider test against 50 known entities

---

## Workflow G4 — State/county property assessor lookup (via Google + assessor site)

- **Which agent uses it:** Agent 1 (Lead Enrichment) — tertiary source in research chain
- **Trigger:** Every Lead in enrichment; also assessor data feeds Agent 5 underwriting brief (C4)
- **Purpose:** Confirm square footage, year built, owner name (catches residential misclassifications)

### Input parameters
- Property address
- County (inferred from zip)
- Optionally APN if available

### Search steps in the UI
1. Determine county from Lead address (zip → county lookup, or Google search "[city] [state] property assessor")
2. Navigate to county assessor website
3. Search by address (fallback: APN)
4. Extract: Owner, Property Use / Zoning Code, Square Footage, Lot Size, Year Built, Annual Assessed Value

### Output fields (from Shirley Dominick sample)
| Field | Type | Notes |
|---|---|---|
| Owner | text | Compare to Lead owner |
| Property Use / Zoning Code | picklist | e.g., "R-1 Single Family Residential" — critical for industrial vs. residential |
| Square Footage | number | Authoritative for the size gate (15k floor) |
| Lot Size | number + unit | e.g., "1.05 acres" |
| Year Built | number | |
| Annual Assessed Value | currency | Feeds underwriting brief |

### Downstream use
- Feeds Agent 1 `proposed_field_values`:
  - `Square_Footage__c`
  - `Property_Type__c` (with zoning code as source)
  - `Year_Built__c`
  - `Lot_Size__c`
- Sources cited verbatim (Shirley Dominick sample):
  - "Loudoun County Property Assessor database (zoning R-1, 4,524 sqft, 1992 build)"
  - "Loudoun County GIS Zoning Query: R-1 (Single-Family Residential)"
- Feeds Agent 5 underwriting brief (assessed value line)

### Rate limits / caps
- Varies by county; some have public web forms, some require CAPTCHAs, some are behind logins
- Failure mode: "Property not found in assessor database → Search by APN if available; try neighboring county; flag for manual County Assessor website lookup."
- Failure mode: "Assessor site unreachable → Note in enrichment summary; recommend retry in 24h."

### Human-in-the-loop notes
- Semi-automated; state-by-state variation means some counties require human input
- Open question #13 (stage_transitions): "Off-Market Verification SOP: Google search + LoopNet false-positive check is manual today. Should Agent 1 automate this, or keep human-in-loop? — RECOMMENDATION: Scope with Britt during Agent 1 build (likely scrape + semi-auto)."

---

## Workflow G5 — Public records / deed change detection (long-term)

- **Which agent uses it:** Agent 1 (post-Dead / Stage 7 monitoring), Agent 8 (long-term cadence)
- **Trigger:** Dead leads or Long-Term Follow-Up leads periodically re-checked for ownership changes
- **Purpose:** Detect property sold (deed filed) → close the lead permanently, OR detect new owner → potential re-engagement

### Input parameters
- Property address / APN

### Search steps in the UI
- Public records search (Google or direct county recorder site)
- Look for recent deed filings

### Output fields
- Deed change status (Yes / No)
- New owner name (if changed)
- Recording date

### Downstream use
- If deed change detected + Lead is in Stage 6 (LT Follow-Up): move to Stage 7 (Dead), log reason "Sold — deed filed"
- If deed change detected + Lead is in Stage 7 (Dead): flag for buyer lead re-engagement if property changed owners (per Stage 7 field entry: "Flag for buyer lead re-engagement if property changes owners")

### Rate limits / caps
- Depends on source; no API budget

### Human-in-the-loop notes
- Currently ad-hoc; no formal automation
- Stage 7 "Long-Term Dead-Lead Cadence" is documented as INFERRED — "source docs do not specify a formal 'reanimate dead lead' rule"

---

# Cross-workflow business rules

## Mason's immutable qualification criteria (applies to R1 output and C7 confirmation)
1. **Geography:** Anywhere (no geographic restriction) — user specifies region per request
2. **Asset type:** Any industrial EXCEPT self-storage, strip malls, hotels (zoning/use-class overlap traps). Also excludes office, mixed-use per Agent 2 spec.
3. **Minimum size:** 15,000 sqft
4. **Off-market status:** Must NOT be listed with a broker OR on an auction site
   - Verified via G1 (Google search) + G2 (LoopNet false-positive check)
   - If Reonomy result (R1) shows LoopNet "for sale" or "for lease" within 90 days → EXCLUDE

## Dual-KPI implication
- Even when CoStar/LoopNet workflows disqualify Mason (`Qualified_Mason_KPI__c = FALSE`), the call agent's KPI stays TRUE if they made valid contact — no punishment for pre-dial-unknowable properties.

## Confidence scoring (Agent 3, applies to C1/C2/C3 outputs)
- **HIGH:** LLC principal via SOS + mailing address + recent purchase
- **MEDIUM:** Principal from CoStar (no SOS needed) OR SOS returned agent-of-service only
- **LOW:** No principal, only mailing address, no recent activity

## Interested-Buyers-to-Transaction stage mapping (feeds off C1 / C2 outputs)
| Interested Buyers State | Parent Transaction Stage |
|---|---|
| 0–5 buyers added, all Cold | TXN 1 (New Contract) or TXN 2 (Disposition Cold) |
| 5–20 buyers, some NDA Sent/Warm | TXN 2 (Disposition Cold) |
| 20+ buyers, multiple Warm/Interested | TXN 3 (Warm) |
| 1+ Hot buyers (offers made) | TXN 4 (Hot) |
| 1 buyer at Assignment Stage | TXN 5 (Assignment Contract Created) |
| 1 buyer Under Contract | TXN 6 (Assigned Deals) |

## Property research chain order (Agent 1)
1. Google search (Workflow G1)
2. LoopNet Firsthand (Workflow G2)
3. Property assessor by state (Workflow G4)
4. CoStar if available (Workflow C7)
5. Call transcript (human-provided, no external tool)

## Retool dashboard treatment (per `03_data_model.md` and `06_panel_spec.md`)
- **Explicit exclusion from v1 dashboard:** "Reonomy / CoStar scrape results. These come from agent runs, not dashboard reads. Stays in Cowork agent runs."
- Dashboard `list_agents` metadata for Agent 2: `purpose: 'Reonomy + CoStar scrapes on demand', trigger: 'on-demand'`
- Dashboard `list_agents` metadata for Agent 3: `purpose: 'Rank buyers at Opp Stage 2 + Under Contract', trigger: 'event'`
- No dashboard queries call CoStar or Reonomy APIs directly

---

# Coverage summary — workflow inventory

| ID | Tool | Workflow name | Agent | Trigger |
|---|---|---|---|---|
| C1 | CoStar | Comparable-buyers search (full) | Agent 3 | Opp → Under Contract |
| C2 | CoStar | Reverse-wholesale Top-5 buyer shortlist | Agent 3 | Opp Stage 2+ (Offer Sent) |
| C3 | CoStar | National (non-local) buyer discovery | Agent 3 | After C1 (Phase 3) |
| C4 | CoStar | Sales & lease comps for underwriting brief | Agent 5 | Opp Stage 1 or 2 (Phase 2) |
| C5 | CoStar | Photo/link reference for OM | Agent 5 | Transaction / OM generation |
| C6 | CoStar | 90-day listing re-check (LT-FU leads) | Agent 8 | Stage 6 cadence |
| C7 | CoStar | Authoritative property-type + occupancy + cap rate confirm | Agent 1 | Lead enrichment (quaternary) |
| R1 | Reonomy | Industrial property list builder | Agent 2 | User request |
| R2 | Reonomy | Per-property owner skip-trace | Agent 2 | After R1 rule filter |
| G1 | Google | Off-market / listing-status address search | Agent 1 | New Lead enrichment |
| G2 | Google (LoopNet) | LoopNet Firsthand listing verification | Agent 1, Agent 2 | After G1 / R1 post-filter |
| G3 | Google (SOS sites) | Secretary of State entity lookup | Agent 3, Agent 2 | CoStar blank principal / Reonomy SOS_NEEDED |
| G4 | Google (assessor sites) | State/county property assessor lookup | Agent 1, Agent 5 | Lead enrichment / underwriting brief |
| G5 | Google (public records) | Deed change / public records monitoring | Agent 1, Agent 8 | Dead / LT-FU cadence |

**14 workflows total** across three tools.
