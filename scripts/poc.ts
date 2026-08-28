/**
 * Phase -1 PoC: verify end-to-end feasibility of the Copilot HTTP path.
 *
 * Input: GH_OAUTH_TOKEN — a GitHub OAuth/PAT token that is already authorized
 *        for Copilot. Obtain it via `npm run poc -- device` (Device Flow) or
 *        a PAT with the appropriate Copilot scopes. `gh auth token` does NOT
 *        work here: the gh CLI's client_id is rejected by
 *        `/copilot_internal/v2/token`.
 *
 * Checks (mapping to PLAN.md Phase -1):
 *   [1] Token exchange succeeds and the response contains `endpoints`.
 *   [2] API base URL is resolved dynamically from `endpoints.api` (no hardcoding).
 *   [3] GET /models returns a non-empty list.
 *   [4] POST /chat/completions?stream=true yields streaming deltas.
 *   [5] Log the response shape as a reference for the real auth/client impl.
 */

// Official VSCode GitHub Copilot Chat OAuth App client_id (public value).
const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";

async function deviceFlow(): Promise<string> {
    const start = await fetch("https://github.com/login/device/code", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ client_id: COPILOT_CLIENT_ID, scope: "read:user" }),
    });
    if (!start.ok) throw new Error(`device/code HTTP ${start.status}: ${await start.text()}`);
    const d = (await start.json()) as {
        device_code: string;
        user_code: string;
        verification_uri: string;
        interval: number;
        expires_in: number;
    };
    console.log("\n============================================");
    console.log(`Open: ${d.verification_uri}`);
    console.log(`Enter code: ${d.user_code}`);
    console.log("============================================\nWaiting for authorization ...");

    let interval = (d.interval || 5) * 1000;
    const deadline = Date.now() + d.expires_in * 1000;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, interval));
        const r = await fetch("https://github.com/login/oauth/access_token", {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify({
                client_id: COPILOT_CLIENT_ID,
                device_code: d.device_code,
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }),
        });
        const j = (await r.json()) as { access_token?: string; error?: string };
        if (j.access_token) return j.access_token;
        if (j.error === "authorization_pending") { process.stdout.write("."); continue; }
        if (j.error === "slow_down") { interval += 5000; continue; }
        throw new Error(`device flow error: ${j.error}`);
    }
    throw new Error("device flow timeout");
}

if (process.argv[2] === "device") {
    deviceFlow()
        .then((tok) => {
            console.log("\n✅ got token. Run:");
            console.log(`export GH_OAUTH_TOKEN=${tok}`);
            console.log("npm run poc");
        })
        .catch((e) => { console.error(e); process.exit(1); });
    // Prevent the rest of main() from running.
    // @ts-expect-error top-level early exit
    await new Promise(() => {});
}

const OAUTH_TOKEN = process.env.GH_OAUTH_TOKEN;
if (!OAUTH_TOKEN) {
    console.error("missing env GH_OAUTH_TOKEN");
    console.error("hint: npm run poc -- device  # run Device Flow to obtain a Copilot-authorized token");
    process.exit(2);
}

// The Copilot backend identifies callers via headers; use an editor-style identity.
// In the real implementation these live in client.ts; the PoC inlines them.
const COMMON_HEADERS: Record<string, string> = {
    "editor-version": "vscode/1.95.0",
    "editor-plugin-version": "copilot-chat/0.22.0",
    "copilot-integration-id": "vscode-chat",
    "user-agent": "GitHubCopilotChat/0.22.0",
};

interface CopilotTokenResponse {
    token: string;
    expires_at: number;
    refresh_in: number;
    endpoints?: {
        api?: string;
        "origin-tracker"?: string;
        proxy?: string;
        telemetry?: string;
    };
    // Also includes chat_enabled, sku, and many more fields — the PoC prints them all.
    [k: string]: unknown;
}

async function exchangeCopilotToken(): Promise<CopilotTokenResponse> {
    const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
        headers: {
            authorization: `token ${OAUTH_TOKEN}`,
            accept: "application/json",
            ...COMMON_HEADERS,
        },
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`token exchange failed: ${res.status} ${res.statusText}\n${body}`);
    }
    return (await res.json()) as CopilotTokenResponse;
}

async function listModels(apiBase: string, copilotToken: string): Promise<{ id: string; [k: string]: unknown }[]> {
    const res = await fetch(`${apiBase}/models`, {
        headers: {
            authorization: `Bearer ${copilotToken}`,
            accept: "application/json",
            ...COMMON_HEADERS,
        },
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`list models failed: ${res.status} ${res.statusText}\n${body}`);
    }
    const json = (await res.json()) as { data?: { id: string }[] };
    return json.data ?? [];
}

async function streamChat(apiBase: string, copilotToken: string, model: string): Promise<void> {
    const res = await fetch(`${apiBase}/chat/completions`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${copilotToken}`,
            "content-type": "application/json",
            accept: "text/event-stream",
            ...COMMON_HEADERS,
        },
        body: JSON.stringify({
            model,
            stream: true,
            messages: [
                { role: "system", content: "You are a terse assistant. Reply in one short sentence." },
                { role: "user", content: "Say hello and name yourself." },
            ],
        }),
    });
    if (!res.ok || !res.body) {
        const body = await res.text();
        throw new Error(`stream chat failed: ${res.status} ${res.statusText}\n${body}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let chunks = 0;
    let content = "";

    process.stdout.write("  reply: ");
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Minimal SSE splitter (the real impl in client.ts handles the full spec).
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
                const evt = JSON.parse(payload) as {
                    choices?: { delta?: { content?: string } }[];
                };
                const delta = evt.choices?.[0]?.delta?.content;
                if (delta) {
                    content += delta;
                    process.stdout.write(delta);
                    chunks++;
                }
            } catch {
                // ignore malformed line in PoC
            }
        }
    }
    process.stdout.write("\n");
    console.log(`  chunks=${chunks} totalChars=${content.length}`);
    if (chunks === 0) throw new Error("no streaming chunks received");
}

async function main(): Promise<void> {
    console.log("[1] exchange Copilot token …");
    const tok = await exchangeCopilotToken();
    const expiresIn = tok.expires_at - Math.floor(Date.now() / 1000);
    console.log(`    ok — expires_at=${tok.expires_at} (in ${expiresIn}s), refresh_in=${tok.refresh_in}s`);
    console.log(`    endpoints=${JSON.stringify(tok.endpoints ?? null)}`);

    const apiBase = tok.endpoints?.api;
    if (!apiBase) throw new Error("token response missing endpoints.api — must not hardcode base URL");
    console.log(`[2] api base (dynamic) = ${apiBase}`);

    console.log("[3] list models …");
    const models = await listModels(apiBase, tok.token);
    console.log(`    ok — count=${models.length}`);
    console.log(`    ids=${models.map((m) => m.id).join(", ")}`);
    if (models.length === 0) throw new Error("empty model list");

    // Pick a widely available model; prefer gpt-4o-mini (available to most accounts).
    const preferred = ["gpt-4o-mini", "gpt-4o", "gpt-4.1", models[0]!.id];
    const chosen = preferred.find((id) => models.some((m) => m.id === id))!;
    console.log(`[4] stream chat with model=${chosen} …`);
    await streamChat(apiBase, tok.token, chosen);

    console.log("\n✅ PoC PASSED — Phase -1 end-to-end path verified");
}

main().catch((err) => {
    console.error("\n❌ PoC FAILED");
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
});
