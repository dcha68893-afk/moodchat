# NECPRA Intelligence Engine

Free, self-hosted intelligence for NECPRA. No paid AI API key. Plain Node.js (no new npm dependencies, no model download).

## What it is
`src/services/intelligence/`
| File | Job |
|---|---|
| `nlp.js` | Normalisation, English + Kiswahili number words ("elfu mbili" = 2000), amounts, phones, periods, dates (Nairobi time) |
| `intents.js` | Intent recognition + slot extraction. Vocabulary is data (`LEX`): add words/languages without code changes. Asks when two intents tie. |
| `engine.js` | Single entry point `handle()`. Conversation context (in memory, 5 min, per user), follow-ups, clarification, routing, fallback |
| `tools.js` | Read-only, user-scoped DUKA/finance queries. Fixed parameterised SQL; every query filtered by the caller's own `owner_id` / `user_id` |
| `forecast.js` | Demand forecast, reorder quantity, slow movers, anomaly detection. Returns **no forecast** with too little history |
| `risk.js` | Transaction risk scoring (explainable rules) + audit service |
| `llm.js` | OPTIONAL Ollama adapter. Off unless `NECPRA_LOCAL_LLM_URL` is set. Output is validated against the action registry |

API (`src/routes/intelligence.js`, JWT required): `GET /api/intelligence/config`, `POST /ask`, `POST /risk/assess`, `POST /risk/:id/resolve`, `GET /risk`.

## Safety rules (enforced in code, covered by tests)
- The engine has no database handle; tools are scoped by the authenticated user id. A client can never pass a user id.
- It never executes a payment, sale, expense, message or reminder. Sensitive intents return `type:"prepare"` and say nothing was done; the existing on-screen confirmation decides.
- Risk scores are hints (`notProof:true`). Mode is **observe only**: nothing is blocked. The user can mark a warning "this is me" (`/risk/:id/resolve`), which is learned for that recipient.
- Answers state whether a figure was counted from records (`retrieved`) or estimated (`predicted`, with a range and confidence). New shops get "not enough history", not a made-up number.
- Spoken/typed text is not stored or logged by the engine. `ai_risk_events` stores no phone numbers; device and IP are hashed.
- `/api/offline/process` no longer pretends to replay requests, and refuses anything financial.

## Deploy
1. `npm run db:migrate` (adds table `ai_risk_events`, idempotent, never dropped on rollback).
2. Copy the new variables from `.env.example`. Defaults work as-is.
3. Optional local model: run Ollama on a machine you control, set `NECPRA_LOCAL_LLM_URL`. Not suitable for free-tier Render RAM.
4. Resource cost of the default (rules-only) engine: no extra memory beyond a small per-user context map; queries use existing DUKA indexes (`duka_sales_shop_date_idx`).
5. Tests: `npm run test:ai` (needs `DUKA_TEST_DB_URL` for the database half; the pure half always runs).

## Marketplace intelligence (`/api/intelligence/marketplace/*`, JWT required)
| Endpoint | What it does |
|---|---|
| `GET /recommendations` | From the caller's own purchases plus aggregate co-purchase. A co-purchase signal needs at least 2 distinct other buyers and never exposes who they are. New buyers get trending, labelled `personalised:false`. |
| `GET /trending?category=` | Ranked by recent real orders (views carry little weight, so view-stuffing does not win). |
| `GET /price-check/:id` | Compares a listing with similar visible listings. Verdicts: typical / higher / much_higher / lower / much_lower / unknown. A very low price is a hint, never called fraud (`notProof:true`). |
| `POST /categorise` | Suggests one of the canonical categories, or none when unclear (alternatives listed). |
| `GET /seller` | The caller's own shop only: 30-day revenue vs previous 30, cancel rate, shipping time, stale listings, price flags, rating. Tips come from the numbers and are not proven causes. |
Only approved, active, available listings are visible to others; sellers can see their own. Read-only: nothing is listed, priced, approved or moved by the AI.

## Known limits
See the final report. Notably: Messenger intelligence is NOT implemented (messages are end-to-end encrypted; on-device work is required), and risk scoring is observe-only. Marketplace price-check needs at least 5 comparable listings before it will judge a price; recommendations are rules/co-purchase based, not a trained model.
