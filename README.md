# dsh-provider-copilot

Bridge a **GitHub Copilot subscription** into **DeepSeek Harness (dsh)** as a plain LLM provider.

Status: **Phase 6 (release prep)** — plugin surface is complete; final packaging & rollout in progress. See `PLAN.md`.

---

## Scope

- ✅ Chat completions (streaming)
- ✅ Model listing (whitelist ∩ remote)
- ✅ Reasoning-stream passthrough (`delta.reasoning_content` → `reasoning` chunk)
- ✅ `/copilot login | logout | status` commands
- ✅ JSONL observability with strict field allowlist
- ❌ Tool / function calling (explicitly out of scope)
- ❌ Copilot CLI runtime / FFI (not used)

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                         dsh (host)                                 │
│  registerCopilot(ctx) ──▶  MeteredProvider (id:"copilot")          │
└────────────────┬───────────────────────────────────────────────────┘
                 │
                 ▼
┌────────────────────────────┐   ┌────────────────────────────────┐
│    CopilotProvider         │──▶│    CopilotClient (HTTP)        │
│  • messages structural     │   │  • layered timeouts             │
│  • no tools ever           │   │  • SSE parser                    │
│  • whitelist ∩ /models     │   │  • 429 retry once                │
│  • alias collapse          │   │  • never hardcodes base URL      │
└────────────┬───────────────┘   └────────────────┬───────────────┘
             │                                    │
             ▼                                    ▼
┌────────────────────────────┐   ┌────────────────────────────────┐
│    JsonlLogger + Metrics   │   │    AuthManager                 │
│  • ring buffer for status  │   │  • Device Flow state machine   │
│  • JSONL 0600/0700 daily   │   │  • token exchange + cache      │
│  • strict field allowlist  │   │  • blocking + bg refresh, dedup│
└────────────────────────────┘   └────────────────────────────────┘
```

## Sequence: first call after login

```
user       dsh         MeteredProvider   CopilotClient   AuthManager   github
 │  /copilot login    │                 │              │             │
 │──────────────────▶│                 │              │             │
 │                    │  login()        │              │             │
 │                    │─────────────────────────────────▶ Device Flow │
 │                    │                 │              │──── code ───▶│
 │                    │◀── user code ────────────────────────── code ─│
 │◀── open URL/code ──│                 │              │             │
 │  authorize in browser                                             │
 │                    │                 │              │◀── ghu_* ───│
 │                    │                 │              │──── exchange│
 │                    │                 │              │◀ Copilot bearer + endpoints
 │  first prompt      │                 │              │             │
 │──────────────────▶│  stream(req)    │              │             │
 │                    │───────────────▶│ getBearer()  │             │
 │                    │                 │────────────▶│ cached      │
 │                    │                 │◀── bearer ──│             │
 │                    │                 │──── POST /chat/completions (SSE) ─▶
 │                    │                 │◀────── text chunks ────────────────
 │                    │◀── text chunks ─│              │             │
 │◀── rendered ───────│                 │              │             │
```

## Non-public API notice

This project uses `api.github.com/copilot_internal/v2/token` to exchange a
GitHub OAuth token for a Copilot bearer token. That endpoint is a
**non-public, unstable interface**; GitHub may change or revoke it at any
time. Use in production at your own risk.

Additional compliance notes:

- User-Agent must start with `GitHubCopilot*`; anti-scraping otherwise returns
  a 403 that looks like an auth error.
- The plugin ships the official VSCode Copilot Chat OAuth `client_id`
  (`Iv1.b507a08c87ecfe98`). Tokens are minted under your GitHub account and
  used only against the Copilot subscription you own.
- The Device Flow scope is `read:user` only. No repository / gist / issue
  scopes are requested.

## Install

```bash
npm install dsh-provider-copilot
```

dsh discovers the plugin under `.pi/extensions/copilot/` and calls
`registerCopilot(ctx)` on startup. There is no runtime dependency on dsh
itself; the plugin binds by shape.

## Usage — inside dsh

```
/copilot login    # Device Flow: opens https://github.com/login/device
/copilot status   # shows source, expiry, model count, p50/p95 latency
/copilot logout   # wipes cache + memory + metrics
```

Once logged in, Copilot models appear in dsh's model picker under the
`copilot` provider.

## Usage — programmatic (BYOK)

```ts
import { AuthManager, CopilotClient, CopilotProvider } from "dsh-provider-copilot";

const auth = new AuthManager({
    byok: { kind: "github", token: process.env.MY_GITHUB_TOKEN! },
});
const client = new CopilotClient({
    getBearer: async () => {
        const s = await auth.getSession();
        return { token: s.token, endpoints: { api: s.endpoints.api } };
    },
});
const provider = new CopilotProvider({ client });

for await (const chunk of provider.stream({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hi" }],
})) {
    if (chunk.type === "text") process.stdout.write(chunk.text);
}
```

### Token source priority

`AuthManager` resolves credentials in this order:

1. `byok` constructor option — a `{ kind: "bearer" | "github", token }`.
2. `env COPILOT_TOKEN` — a raw Copilot bearer; skips exchange.
3. `env COPILOT_GITHUB_TOKEN` — a GitHub token; drives exchange.
4. On-disk OAuth cache from a previous `/copilot login`.
5. `~/.config/gh/hosts.yml` (opt-in: `DSH_COPILOT_ALLOW_GH_HOSTS=1`).
6. `GH_TOKEN` / `GITHUB_TOKEN` (opt-in: `DSH_COPILOT_ALLOW_ENV_GH=1`).

Sources 5–6 are opt-in because "any GitHub token" leaking into a
Copilot-specific credential surface is easy to do by accident.

## Configuration

| Env var                       | Effect                                                     |
| ----------------------------- | ---------------------------------------------------------- |
| `COPILOT_TOKEN`               | Skip exchange; use as Copilot bearer directly.             |
| `COPILOT_GITHUB_TOKEN`        | GitHub token to exchange for a Copilot bearer.             |
| `DSH_COPILOT_ALLOW_GH_HOSTS`  | `1` enables reading `gh` `hosts.yml` as fallback.          |
| `DSH_COPILOT_ALLOW_ENV_GH`    | `1` enables reading `GH_TOKEN` / `GITHUB_TOKEN` fallback.  |
| `DSH_COPILOT_NO_LOG`          | `1` disables JSONL log writes (no directory / files).      |
| `XDG_CONFIG_HOME`             | Standard XDG override for cache & log location.            |

## Observability

- **In-memory ring buffer:** last 10 successful calls used for
  `/copilot status` p50/p95.
- **JSONL log:** `~/.config/dsh/copilot/log/copilot-YYYY-MM-DD.jsonl`.
  Fields are a hard-coded allowlist:
  `ts, requestId, event, model, latencyMs, promptTokens, completionTokens,
  totalTokens, errorCode, source, sku`.
  Any attempt to log outside that set is rejected at runtime.
- **Retention:** 7 days by default; pruning is lazy on the first write
  of a new UTC day; failures are silent.
- **Perms:** dir 0700, files 0600, matching auth cache.

## Troubleshooting

| Symptom                                        | Likely cause / fix                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `403 scraping` from `api.github.com`           | Non-Copilot UA. Do not override the built-in headers.                                                 |
| `token_exchange_forbidden` (403)               | Account has no Copilot entitlement (individual not subscribed, org/enterprise seat unassigned).       |
| `token_exchange_unauthorized` (401)            | Stale GitHub token. `/copilot logout` then `/copilot login`.                                          |
| `no_token_source`                              | Nothing to authenticate with. Set `COPILOT_TOKEN` / `COPILOT_GITHUB_TOKEN` or run `/copilot login`.   |
| `http_connect_timeout`                         | Network / DNS. Check corporate proxy; tune `timeouts.connectMs` if needed.                            |
| `http_first_byte_timeout`                      | Upstream slow to respond. Tune `timeouts.firstByteMs`.                                                |
| `http_idle_timeout`                            | Stream stalled mid-flight. Tune `timeouts.idleMs`.                                                    |
| Model missing from `/copilot status` count     | Not in the whitelist ∩ upstream. Pass a custom `whitelist` to `CopilotProvider` if you know the id.   |
| `unknown subcommand: X`                        | Only `login`, `logout`, `status` are supported.                                                       |

## Development

```bash
npm install
npm test           # 111 tests across auth / client / provider / commands / observability / e2e
npm run typecheck
npm run lint
```

Feasibility PoC (Device Flow → models → stream):

```bash
npm run poc -- device
export GH_OAUTH_TOKEN=ghu_xxx
npm run poc
```

Coverage is opt-in:

```bash
npm i -D @vitest/coverage-v8@2.1.8   # match your vitest version
npx vitest run --coverage
```

## License

MIT — see `LICENSE`.
