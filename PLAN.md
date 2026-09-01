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

## Phase 2: HTTP client (`src/client/`) (2 days) — DONE

- [x] `CopilotClient.listModels()` with 5-min TTL cache + in-flight dedup
      (`invalidateModels()` for tests / manual refresh).
- [x] `CopilotClient.streamChatCompletions(req, signal)` returns an
      `AsyncGenerator<ChatCompletionChunk>`; always sends `stream: true`.
- [x] SSE parser (`src/client/sse.ts`) covers: fragmented `data:` payloads,
      CRLF/LF line endings, blank lines as event separators, `[DONE]` sentinel,
      UTF-8 code points split across chunks (`TextDecoder({stream:true})`),
      non-JSON `data:` lines skipped, comment / keep-alive lines (`: ...`)
      skipped, clean termination without `[DONE]`, empty stream.
- [x] Layered timeouts (`src/client/http.ts`): `connectMs`, `firstByteMs`,
      `idleMs`, `totalMs`; each maps to a distinguishable `ClientError.code`.
- [x] Single retry on 429 with `Retry-After` (seconds or HTTP-date); a second
      429 surfaces as-is.
- [x] `redactSecrets()` covers Bearer, `token <t>` header form, `gh[pou s r]_*`,
      legacy 40-hex PATs, and Copilot semicolon-token bodies.
- [x] Base URL always derived from `getBearer().endpoints.api` — never hardcoded.
- [x] Unit tests (`test/client/*.test.ts`, 30 tests): SSE across all branches
      including UTF-8 split, redact rules, 429 retry-once behavior, timeouts
      (connect/first-byte/idle), caller-abort mapping, network-error mapping,
      list-models cache + invalidation, stream `stream:true` enforcement, HTTP
      4xx surfacing before the generator yields.
- [x] Public API re-exported via `src/client/index.ts` → `src/index.ts`.

### Phase 2 known follow-ups (deferred, not blocking Phase 3)

- Wire `totalMs` into the streaming reader (currently only enforced at
  connect + retry; long streams can outlast it silently).
- Emit a `metrics` event on malformed SSE frames so the observability layer
  (Phase 5) can surface parser drops.
- Consider `Retry-After: <http-date>` fuzz tests once we see live 429s in
  Phase 7 rollout data.

## Phase 3: Provider (`src/provider/`) (1 day) — DONE

- [x] `CopilotProvider` implements the dsh `LlmProvider` interface
      (`id` / `listModels` / `stream`). Interface is declared locally in
      `src/provider/dshInterface.ts` — no runtime dep on dsh; dsh loads by shape.
- [x] `messages` forwarded structurally (mapped 1:1 to
      `{ role, content, name? }`). Verified by test: request payload equals
      the input array; no string concatenation on any path.
- [x] Never sends `tools` / `tool_choice`; verified by negative assertion in
      the forwarding test.
- [x] `delta.content` → `{ type: "text" }`; `delta.reasoning_content` →
      `{ type: "reasoning" }`; a final `{ type: "finish", reason?, usage? }`
      is always emitted so dsh can settle its rendering.
- [x] `AbortSignal` passed straight through to `CopilotClient.streamChatCompletions`
      (identity-equal, verified in test).
- [x] Model set = remote `/models` ∩ local whitelist (`DEFAULT_WHITELIST`).
      Whitelist entries carry `contextWindow`, `maxOutputTokens`, `family`,
      `reasoning`, optional `vision`. Aliases collapse dated snapshots
      (e.g. `gpt-4o-2024-11-20` → canonical `gpt-4o`) to a single row.
- [x] Fallback: empty intersection exposes raw remote ids as `{ id }` so
      brand-new accounts aren't hard-locked; opt-out via
      `fallbackToRemoteOnEmpty: false`.
- [x] Unit tests (`test/provider/*.test.ts`, 16 tests): intersection, alias
      resolution, custom whitelist, structural forwarding, no-tools guarantee,
      reasoning mapping, abort passthrough, alias-to-canonical model id on
      the outgoing request, finish + usage propagation, upstream error surfacing.
- [x] Public API re-exported via `src/provider/index.ts` → `src/index.ts`.

### Phase 3 known follow-ups (deferred, not blocking Phase 4)

- Whitelist metadata (context window / max output) is currently a static
  best-guess; revisit after Phase 6 fixtures when we can read real 400
  responses at edge sizes.
- No `usage` accumulation for streams where upstream splits it across chunks;
  we take the last one wins. Fine for observability; may need summation if
  dsh wants per-token billing.
- Consider exposing `getRemoteModelIds()` (unfiltered) as a debug helper for
  the Phase 4 `/copilot status` command.

## Phase 4: Commands & entry (`src/commands/`) (0.5 day) — DONE

- [x] `/copilot login | logout | status` implemented in
      `src/commands/commands.ts`. `login` streams the Device Flow user code
      via an `onCode` callback so shells can print it without blocking the
      auth manager; `logout` wipes memory, disk cache, model cache, and the
      metrics ring; `status` reports auth source, token expiry (`expiresInSeconds`),
      SKU, model count, and p50/p95 over the last N calls.
- [x] `status` never throws: `/models` failure surfaces as `modelCount = null`,
      so `/copilot status` still renders when the network is down.
- [x] `formatStatus()` produces a shell-friendly one-liner (e.g.
      `copilot: ok (cache sku=individual) expires_in=29m models=57 p50=200ms p95=350ms (n=10)`).
- [x] `MetricsRing` (`src/commands/metrics.ts`): capacity-bounded, ok-only p50/p95,
      nearest-rank percentile (small N ⇒ no interpolation needed).
- [x] `MeteredProvider` (`src/commands/meteredProvider.ts`) wraps
      `CopilotProvider.stream` to record latency, ok/err, `errorCode` (from
      thrown `ClientError.code`), and usage tokens. `listModels` is delegated
      untouched to avoid double-counting.
- [x] Plugin entry `registerCopilot(ctx, opts?)` in `src/commands/entry.ts`
      wires `AuthManager → CopilotClient → CopilotProvider → MeteredProvider`,
      lazily via `getBearer` closure (no auth is touched until first request).
- [x] Command handlers are shell-agnostic (`{ args, signal, println }`);
      the entry translates dsh's ctx shape to that surface. dsh runtime is not
      a hard dependency — the plugin binds by shape.
- [x] `ctx.effect(dispose)` registered so dsh calls our cleanup on unload
      (invalidates models cache, clears metrics ring).
- [x] Unit tests (`test/commands/*.test.ts`, 17 tests): ring capacity + percentile
      edge cases, MeteredProvider ok/err recording + errorCode mapping,
      status with & without session, `/models` failure fallback,
      `formatStatus` shape, entry registers provider + command, unknown
      subcommand usage, disposer registration.
- [x] Public API re-exported via `src/commands/index.ts` → `src/index.ts`.

### Phase 4 known follow-ups (deferred, not blocking Phase 5)

- Rendering `expiresInSeconds` in the CLI uses a coarse `h`/`m` format;
  Phase 5 will emit structured events so a richer UI can format its own way.
- `/copilot status` does not currently show endpoint hostnames; Phase 5
  status will include them under a verbose flag.
- `login` prints the user code via `println`; a future improvement is to
  optionally open the browser (opt-in — must not be default on servers).

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
