# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`hydro-ai-tutor` is a HydroOJ addon (plugin) that adds an AI tutoring button to submission detail pages. It streams heuristic, code-free coaching feedback (DeepSeek/OpenAI-compatible) to students via SSE, manages per-user credit balances, and enforces monthly usage quotas.

## Installing / running

This is a HydroOJ addon — it has no standalone build step. The HydroOJ framework transpiles TypeScript at load time.

```bash
# Register the addon
hydrooj addon add /root/.hydro/addons/ai-tutor

# Restart the server to pick up changes
pm2 restart hydrooj

# Watch logs
pm2 logs hydrooj
```

API keys are configured per-domain in the admin UI (not in `.env`). The domain-level config is stored in MongoDB collection `ai.domain_config`.

## Architecture

### Entry point: `index.ts`

`apply(ctx)` is called by HydroOJ on load. It:
- Registers system settings via `ctx.inject(['setting'], ...)` — required pattern; do not call setting APIs directly
- Registers a weekly worker task (`WEEKLY_CREDIT_RESET_TASK`) for credit expiry + grant
- Registers custom scripts (`ctx.addScript`) for batch operations
- Creates MongoDB indexes on `app/started`
- Listens to `record/judge` to award first-AC credits
- Registers routes, UI injection points, and i18n strings

### Handler structure

`handlers.ts` is a barrel re-export. Handlers live in `handlers/`:

| File | Handler(s) | Route |
|---|---|---|
| `suggestion.ts` | `AiSuggestionHandler`, `AiSuggestionAvailabilityHandler` | `/record/:rid/ai` |
| `admin.ts` | `AiTutorDomainRecordsHandler` | `/domain/ai-tutor/records` |
| `domain_manage.ts` | `AiTutorDomainManageHandler` | `/domain/ai-tutor` |
| `domain_batch.ts` | `AiTutorDomainBatchHandler` | `/domain/ai-tutor/batch` |
| `domain_quota.ts` | `AiTutorDomainQuotaHandler` | `/domain/ai-tutor/quota` |
| `credit_detail.ts` | `AiTutorCreditDetailHandler` | `/ai-tutor/credits` |

`AiSuggestionHandler` POST actions (`postStart`, `postClear`, `postReflect`, `postRegenerateReflect`) are dispatched by HydroOJ from the `action` form field (e.g. `action=start` → `postStart`). The word `operation` is a reserved field in Hydro — always use `action`.

### SSE streaming pattern

`postStart` and `postReflect` stream AI responses as SSE. The required pattern to bypass Hydro's response post-processing:

```ts
this.request.websocket = true;  // tells framework/base.ts to skip ctx.body rewrite
ctx.body = passThroughStream;
(ctx as any).compress = false;
ctx.set('X-Accel-Buffering', 'no');
```

The async fetch runs in a fire-and-forget IIFE inside `post()` — do not await it. Koa pumps the PassThrough stream to the HTTP response automatically after `post()` returns.

### Credit system (`credits.ts`)

- **`ai.credit`** — one doc per `(domainId, uid)`, fields: `balance`, `totalEarned`, `totalSpent`
- **`ai.credit_ledger`** — append-only; each grant/deduction is a row with `remaining` and `expiresAt` (30 days)
- **`ai.usage`** — monthly call log; quota is counted with `countDocuments({ uid, domainId, monthKey })`
- Credits expire FIFO by `expiresAt`. `deductCredit` drains the oldest lots first.
- Interrupted/empty AI replies trigger `refundDeductedCredit`.

### MongoDB collections (all defined in `constants.ts`)

| Constant | Collection | Purpose |
|---|---|---|
| `COLL_ANALYSIS` | `ai.analysis` | Saved AI reply per record (one doc per rid) |
| `COLL_USAGE` | `ai.usage` | Per-call log for monthly quota |
| `COLL_CREDIT` | `ai.credit` | Per-user balance |
| `COLL_CREDIT_LEDGER` | `ai.credit_ledger` | Append-only credit change log |
| `COLL_AWARD` | `ai.credit_award` | First-AC award deduplication |
| `COLL_DOMAIN_ACCESS` | `ai.domain_access` | Per-domain user enable/quota |
| `COLL_DOMAIN_CONFIG` | `ai.domain_config` | Per-domain provider/key config |
| `COLL_CREDIT_ADJUST` | `ai.credit_adjust` | Audit log for teacher-granted quota |

### Key utilities (`utils.ts`)

- `cfg<T>(key, fallback)` — reads `ai-tutor.<key>` from `SystemModel`
- `resolveProvider(ctx, domainId)` — looks up `ai.domain_config` to get `baseUrl`, `model`, `apiKey`
- `buildUserPrompt(pdoc, rdoc, ...)` — assembles the user-turn prompt from problem + code + results
- `monthlyQuotaCap(access, month)` — system cap + per-user bonus

### Hydro model access

HydroOJ models **must** be accessed inside handlers via `global.Hydro.model.*` (e.g. `global.Hydro.model.record`). Top-level imports like `import { RecordModel } from 'hydrooj'` will be `undefined` at module load time.

### Frontend (`frontend/record_ai_button.page.tsx`)

Uses HydroOJ's `NamedPage` / `addPage` to inject a button on `record_detail`. It calls `/record/:rid/ai/available` first to check eligibility, then inserts the button next to the download link. The domain prefix (`/d/<domain>`) must be preserved in all URLs to avoid `domainId` resolving to `system`.

### Templates

Nunjucks templates in `templates/`. All permission checks are done in the handler; templates only receive booleans/strings — never pass `PERM.*` constants or BigInt values to Nunjucks.

### Provider configuration

Providers are defined in `constants.ts → PROVIDERS`. API key is stored **per-domain** in `ai.domain_config.apiKey` (set via the domain manage UI), not in system settings or `.env`. The `resolveProvider` utility merges the domain config with the preset table.
