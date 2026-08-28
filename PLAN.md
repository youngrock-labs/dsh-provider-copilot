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

## Phase 0: New repository (0.5 day)

- [ ] Create a standalone git repository (e.g. `dsh-provider-copilot`); do not fork
      the old repo. Archive the old repo as read-only.
- [ ] Initialize from scratch: `package.json`, `tsconfig.json`, `eslint`, `.gitignore`,
      MIT LICENSE.
- [ ] `engines.node = ">=20.10.0"`. Do not depend on `@github/copilot` / `koffi` /
      `allowScripts` / `prepare` build scripts.
- [ ] Directory skeleton: `.pi/extensions/copilot/`, `src/{auth,client,provider}.ts`,
      `test/`.

## Phase 1: Auth `auth.ts` (1.5 days)

- [ ] Full Device Flow state machine: `authorization_pending` / `slow_down` /
      `expired_token` / `access_denied`.
- [ ] Exchange GitHub token for Copilot token; cache under `~/.config/dsh/copilot/`
      (directory 0700, files 0600).
- [ ] Separate token types: `COPILOT_TOKEN` (bearer) vs `COPILOT_GITHUB_TOKEN`
      (used for exchange).
- [ ] Source priority: BYOK → `COPILOT_TOKEN` → `COPILOT_GITHUB_TOKEN` → OAuth cache
      → `gh` `hosts.yml` → `GH_TOKEN` / `GITHUB_TOKEN` (off by default, opt-in).
- [ ] Refresh policy: blocking refresh when remaining lifetime < 2 min; background
      pre-refresh 5 min before expiry; deduplicate concurrent refreshes.
- [ ] Unit tests: priority, state machine, concurrent refresh, cache permissions.

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
