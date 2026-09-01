# Copilot → dsh Provider Roadmap

## Phase -1: Feasibility PoC (1 day)

- [x] End-to-end: GitHub token → Copilot token → `/models` → streaming `/chat/completions`
      (`scripts/poc.ts`; verified locally on 2026-08-28: 57 models listed,
      `gpt-4o-mini` streamed 7 chunks successfully)
- [x] Resolve API base URL dynamically from the `endpoints` field of the token response
      (do not hardcode). Individual subscription returns `https://api.individual.githubcopilot.com`;
      business/enterprise likely use different subdomains, so `client.ts` must always use
      `endpoints.api`.
- [x] Document compliance and stability risk of `copilot_internal/v2/token` being a
      non-public API (see "Key findings" below).
- [ ] Cover response differences across organization / enterprise / no-Copilot-entitlement
      accounts (currently only the individual tier is verified; other tiers to be tested
      once accounts are available — not blocking the main track).
- [ ] Confirm dsh command handlers support long-running tasks + streaming output;
      otherwise switch `login` to an async model (to be validated in Phase 4).

### Key findings (PoC)

- **UA-sensitive**: A `user-agent` that is not prefixed with `GitHubCopilot*` is blocked
  by `api.github.com` anti-scraping and returns a 403 "scraping" response (not an auth
  error). The production implementation must pin a Copilot-style UA.
- **Must use the Copilot OAuth App**: Tokens obtained via `gh auth token` (whose
  `client_id` belongs to the gh CLI) are rejected by `/copilot_internal/v2/token`.
  We must run our own Device Flow with the official VSCode Copilot
  `client_id=Iv1.b507a08c87ecfe98` to obtain a `ghu_*` token → Device Flow in
  `auth.ts` is mandatory; we cannot reuse `gh`.
- **`endpoints` differ by subscription tier**: individual uses
  `*.individual.githubcopilot.com`; business/enterprise are expected to use
  `*.business.*` or custom enterprise domains → base URL must be dynamic.
- **Model pool is far larger than expected**: 57 models, including many internal/
  experimental ones (`exec-agent-*`, `copilot-search-*`, `trajectory-compaction`, ...)
  → the Phase 3 whitelist intersection strategy is required; do not expose everything.
- **Compliance risk**: `copilot_internal/v2/token` is an internal API with no SLA;
  UA and `client_id` allowlists may tighten at any time. The README must clearly state
  this is not a GitHub-supported path.

## Phase 0: New repository (0.5 day) — DONE

- [x] Standalone git repo initialized.
- [x] From-scratch `package.json`, `tsconfig.json`, `eslint.config.mjs`, `.gitignore`, MIT LICENSE.
- [x] `engines.node = ">=20.10.0"`; no `@github/copilot` / `koffi` / `allowScripts` /
      `prepare` scripts.
- [x] Skeleton: `.pi/extensions/copilot/`, `src/{auth,client,provider}.ts`, `test/`.

## Phase 1: Auth (`src/auth/`) (1.5 days) — DONE

- [x] Full Device Flow state machine: `authorization_pending` (poll again) /
      `slow_down` (interval +5s per spec) / `expired_token` (→ `device_flow_expired`) /
      `access_denied` (→ `device_flow_denied`) / client-side timeout
      (→ `device_flow_timeout`). Implemented in `src/auth/deviceFlow.ts`.
- [x] Exchange GitHub token → Copilot token via `copilot_internal/v2/token`,
      caching at `~/.config/dsh/copilot/` (dir 0700, files 0600, atomic writes
      via `O_CREAT|O_EXCL|0600` + rename). Implemented in `src/auth/store.ts` +
      `src/auth/tokenExchange.ts`.
- [x] Token-kind separation: `COPILOT_TOKEN` (bearer, skips exchange) vs
      `COPILOT_GITHUB_TOKEN` (drives exchange). Enforced in `src/auth/sources.ts`
      and honored by `AuthManager.doRefresh`.
- [x] Source priority: `BYOK` → `env COPILOT_TOKEN` → `env COPILOT_GITHUB_TOKEN`
      → OAuth cache → `gh` `hosts.yml` (opt-in `DSH_COPILOT_ALLOW_GH_HOSTS=1`)
      → `GH_TOKEN`/`GITHUB_TOKEN` (opt-in `DSH_COPILOT_ALLOW_ENV_GH=1`).
      Implemented in `src/auth/sources.ts::resolveToken`.
- [x] Refresh policy: blocking refresh when remaining lifetime < 2 min;
      opportunistic background refresh when < 5 min; concurrent refreshes
      deduplicated to a single in-flight promise (`AuthManager.inflightRefresh`).
- [x] Pinned Copilot User-Agent + editor headers (`src/auth/headers.ts`) — matches
      Phase -1 finding that non-Copilot UAs are 403'd by api.github.com.
- [x] Unit tests (`test/auth/*.test.ts`): priority chain, Device Flow state machine
      + slow_down backoff + deadline enforcement, token-exchange 401/403/success/
      missing-endpoints, cache 0600/0700 permissions + idempotent clear, refresh
      concurrency dedup, blocking near-expiry refresh, logout wipe.
- [x] Public API re-exported from `src/index.ts` via `src/auth/index.ts` barrel.

### Phase 1 known follow-ups (deferred, not blocking Phase 2)

- Add a `--yes` / non-interactive login mode once dsh command shell semantics are
  confirmed (Phase 4).
- Persist `sessionSource` alongside `session.json` so `status` reports the origin
  after a cold restart (currently reports `cache` on warm-load).
- Encrypt cache files at rest if/when we support shared workstations (out of scope
  for MVP; documented in README's non-public API notice).

## Phase 2: HTTP client `client.ts` (2 days)

- [ ] `listModels()` (5 min TTL), `chatCompletionsStream(req, signal)`.
- [ ] SSE parsing must cover: fragmented data, CRLF, blank lines, `[DONE]`,
      UTF-8 split across chunks, non-JSON lines, disconnects.
- [ ] Layered timeouts: connect / first-byte / idle / total, distinguishable error codes.
- [ ] Single retry with backoff on 429 + `Retry-After`.
- [ ] `redactSecrets()`: Bearer, GitHub PATs, Copilot semicolon-token
      (`tid=` / `exp=` ...), `Authorization` values.
- [ ] Unit tests: every SSE branch, redact, abort, timeouts.

## Phase 3: Provider `provider.ts` (1 day)

- [ ] Implement dsh `LlmProvider`: `id` / `listModels` / `stream`.
- [ ] Forward `messages` structurally (**no string concatenation**); do not send `tools`.
- [ ] `delta.content` → text chunk; `delta.reasoning_content` → reasoning chunk.
- [ ] Wire `AbortSignal` straight through to `fetch`.
- [ ] Model set = remote `/models` ∩ local whitelist (whitelist carries context
      window, reasoning support, and other metadata).
- [ ] Unit tests: forwarding, abort, intersection, aliases.

## Phase 4: Commands & entry point (0.5 day)

- [ ] `/copilot login|logout|status` (status shows auth source, token expiry,
      model count, p50/p95 over the last 10 calls).
- [ ] Plugin entry: register provider + commands, clean up via `ctx.effect`,
      lazily initialize the client.

## Phase 5: Observability (0.5 day)

- [ ] JSONL logs under `~/.config/dsh/copilot/log/` (0700, 7-day rotation).
- [ ] Fields: `requestId` / `model` / `tokens` / `latencyMs` / `errorCode`.
- [ ] **Never log: messages, body, headers, tokens, full error bodies.**
- [ ] In-memory ring buffer of the last 10 calls for `/copilot status`.

## Phase 6: Test & release (1.5 days)

- [ ] SSE fixture recording + mock-server E2E (login → list → stream).
- [ ] ≥ 90% coverage on the three core files.
- [ ] CI: lint + test on Node 20 / 22.
- [ ] `package.json` with pinned versions + `package-lock.json` (`npm ci`).
- [ ] Finalize the public package name; rewrite README (architecture diagram,
      sequence diagram, "no tool calls", stability risk, troubleshooting table).
- [ ] Publish to npm.

## Phase 7: Rollout (ongoing)

- [ ] Internal test with 3–5 users for a week; tune timeout/retry based on latency data.
- [ ] Define rollback criteria (error-rate threshold, upstream lockout).
- [ ] Tag 1.0.0 once stable; point the old repo's README to the new one.

---

## Milestones

| Milestone | Cumulative | Deliverable |
|---|---|---|
| M0 PoC pass | 1d | End-to-end script runs |
| M1 Auth | 3d | `/copilot login` yields a Copilot token |
| M2 Streaming | 6d | Provider API streams (unit tests + fixtures green) |
| M3 Integration | 7d | Copilot models appear in dsh's model picker |
| M4 Release | 8.5d | npm package + green CI + README |

## Non-goals

- ❌ Tool / function calling
- ❌ Prompt cache optimizations
- ❌ A generic LLM SDK compatibility layer
- ❌ A standalone UI
