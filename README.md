# dsh-provider-copilot

Bridge a **GitHub Copilot subscription** into **DeepSeek Harness (dsh)** as a plain LLM provider.

Status: **Phase -1 (PoC)** — validating end-to-end HTTP feasibility. See `PLAN.md`.

## Scope

- ✅ Chat completions (streaming)
- ✅ Model listing
- ❌ Tool / function calling (explicitly out of scope)
- ❌ Copilot CLI runtime / FFI (not used)

## Non-public API notice

This project uses `api.github.com/copilot_internal/v2/token` to exchange a GitHub
OAuth token for a Copilot bearer token. That endpoint is a **non-public, unstable
interface**; GitHub may change or revoke it at any time. Use in production at your
own risk.

## PoC usage

```bash
npm install

# One-time: obtain a Copilot-authorized GitHub token via Device Flow
npm run poc -- device
export GH_OAUTH_TOKEN=ghu_xxx

# Run the full-chain check
npm run poc
```

The PoC will:
1. Exchange `GH_OAUTH_TOKEN` for a Copilot token.
2. Print the `endpoints` field to confirm the API base URL is resolved dynamically.
3. `GET /models` and list available models.
4. `POST /chat/completions` and stream a short reply.
