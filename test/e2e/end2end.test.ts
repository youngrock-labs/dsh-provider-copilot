import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { registerCopilot } from "../../src/commands/entry.js";
import { AuthStore } from "../../src/auth/store.js";
import { MockFetch, jsonResponse, sseResponse } from "./mockServer.js";
import { CHAT_SIMPLE_SSE, MODELS_JSON, TOKEN_EXCHANGE_JSON } from "./fixtures/copilot.js";

async function tmpDir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), "dsh-copilot-e2e-"));
}

function bootstrap(_mock: MockFetch): {
    ctx: {
        registerProvider: (p: unknown) => void;
        registerCommand: (n: string, h: (c: unknown) => Promise<void>) => void;
        effect?: (d: () => void | Promise<void>) => void;
    };
    provider: { id: string; listModels: () => Promise<{ id: string }[]>; stream: (r: unknown) => AsyncGenerator<unknown> };
    commands: Map<string, (c: unknown) => Promise<void>>;
} {
    let provider: unknown = null;
    const commands = new Map<string, (c: unknown) => Promise<void>>();
    const ctx = {
        registerProvider: (p: unknown) => {
            provider = p;
        },
        registerCommand: (n: string, h: (c: unknown) => Promise<void>) => commands.set(n, h),
        effect: () => undefined,
    };
    return { ctx, get provider() { return provider as never; }, commands } as never;
}

describe("E2E: login → list → stream", () => {
    let cacheDir: string;

    beforeEach(async () => {
        cacheDir = await tmpDir();
        // Route COPILOT_GITHUB_TOKEN through env so we skip Device Flow.
        process.env.COPILOT_GITHUB_TOKEN = "ghu_e2e";
        process.env.DSH_COPILOT_NO_LOG = "1";
    });

    it("streams a chat completion end-to-end through the mock server", async () => {
        const mock = new MockFetch();
        mock.on("GET", "https://api.github.com/copilot_internal/v2/token", () =>
            jsonResponse(TOKEN_EXCHANGE_JSON),
        );
        mock.on("GET", "https://api.individual.githubcopilot.com/models", () =>
            jsonResponse(MODELS_JSON),
        );
        mock.on("POST", "https://api.individual.githubcopilot.com/chat/completions", () =>
            sseResponse(CHAT_SIMPLE_SSE),
        );

        // Wire a custom AuthStore under the tmp dir to avoid touching $HOME.
        const { ctx, commands } = bootstrap(mock);
        const handle = registerCopilot(ctx, { fetchImpl: mock.fetch, disableLog: true });
        // Swap the AuthStore's dir for isolation.
        (handle.auth as unknown as { store: AuthStore }).store = new AuthStore(cacheDir);

        // ---- list models ----
        const models = await handle.provider.listModels();
        const ids = models.map((m) => m.id).sort();
        expect(ids).toContain("gpt-4o-mini");
        expect(ids).toContain("gpt-4o"); // collapsed from gpt-4o-2024-11-20
        expect(ids).toContain("claude-sonnet-4.5");
        // Noise filtered out.
        expect(ids).not.toContain("exec-agent-a");
        expect(ids).not.toContain("trajectory-compaction");

        // ---- stream chat ----
        const chunks: string[] = [];
        let finish = null as null | { type: string; usage?: { totalTokens?: number } };
        for await (const c of handle.provider.stream({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "You are terse." },
                { role: "user", content: "Say hello." },
            ],
        })) {
            const ch = c as { type: string; text?: string; usage?: { totalTokens?: number } };
            if (ch.type === "text") chunks.push(ch.text ?? "");
            if (ch.type === "finish") finish = ch;
        }
        expect(chunks.join("")).toBe("Hello, world!");
        expect(finish?.usage?.totalTokens).toBe(16);

        // ---- /copilot status renders after the call ----
        const lines: string[] = [];
        await commands.get("copilot")!({ args: ["status"], println: (l: string) => lines.push(l) } as never);
        expect(lines[0]).toMatch(/copilot: ok/);
        expect(lines[0]).toMatch(/models=/);

        // Call log covers the whole chain.
        const paths = mock.callLog.map((c) => `${c.method} ${new URL(c.url).pathname}`);
        expect(paths).toContain("GET /copilot_internal/v2/token");
        expect(paths).toContain("GET /models");
        expect(paths).toContain("POST /chat/completions");
    });
});
