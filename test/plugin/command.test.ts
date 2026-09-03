import { describe, it, expect, vi } from "vitest";
import type { AuthManager } from "../../src/auth/index.js";
import type { MetricsRing } from "../../src/commands/metrics.js";
import { makeCopilotCommandHandler } from "../../src/plugin/command.js";
import type { CopilotClientLike } from "../../src/plugin/copilotAdapter.js";
import type { DshCommandResult } from "../../src/plugin/dshSurface.js";

const NOW = 1_800_000_000_000;

function makeDeps(overrides?: {
    auth?: Partial<AuthManager>;
    client?: Partial<CopilotClientLike>;
    metrics?: Partial<MetricsRing>;
}) {
    const auth = {
        beginLogin: vi.fn(async () => ({
            code: { verificationUri: "https://github.com/login/device", userCode: "ABCD-1234" },
            done: Promise.resolve({ expiresAt: Math.floor(NOW / 1000) + 3600 } as never),
        })),
        logout: vi.fn(async () => undefined),
        status: vi.fn(async () => ({
            hasSession: false,
            source: null,
            expiresAt: null,
            endpoints: null,
        })),
        ...overrides?.auth,
    } as unknown as AuthManager;

    const client = {
        listModels: vi.fn(async () => []),
        invalidateModels: vi.fn(),
        streamChatCompletions: vi.fn(async function* () { /* no chunks */ }),
        ...overrides?.client,
    } as CopilotClientLike;

    const metrics = {
        percentiles: vi.fn(() => null),
        record: vi.fn(),
        clear: vi.fn(),
        snapshot: vi.fn(() => []),
        ...overrides?.metrics,
    } as unknown as MetricsRing;

    return { auth, client, metrics };
}

describe("makeCopilotCommandHandler", () => {
    it("reports usage on unknown subcommands", async () => {
        const { auth, client, metrics } = makeDeps();
        const handler = makeCopilotCommandHandler({ auth, client, metrics });
        const result = (await handler({ rawInput: "frobnicate" })) as DshCommandResult;
        expect(result.kind).toBe("error");
        expect(result.text).toMatch(/usage/);
    });

    it("status says not logged in and never throws", async () => {
        const { auth, client, metrics } = makeDeps();
        const handler = makeCopilotCommandHandler({ auth, client, metrics });
        const result = (await handler({ rawInput: "status" })) as DshCommandResult;
        expect(result.kind).toBe("error");
        expect(result.text).toMatch(/not logged in/);
    });

    it("login returns the device code immediately and finishes in the background", async () => {
        const { auth, client, metrics } = makeDeps();
        let settled: { ok: boolean } | undefined;
        const handler = makeCopilotCommandHandler(
            { auth, client, metrics },
            { onBackgroundSettled: (info) => { settled = info; } },
        );
        const result = (await handler({ rawInput: "login" })) as DshCommandResult;
        expect(result.kind).toBe("success");
        expect(result.text).toContain("open: https://github.com/login/device");
        expect(result.text).toContain("code: ABCD-1234");
        expect(auth.beginLogin).toHaveBeenCalledOnce();
        await Promise.resolve();
        await Promise.resolve();
        expect(settled?.ok).toBe(true);
        expect(client.invalidateModels).toHaveBeenCalledOnce();
    });

    it("logout clears auth, model cache, and metrics", async () => {
        const { auth, client, metrics } = makeDeps();
        const handler = makeCopilotCommandHandler({ auth, client, metrics });
        const result = (await handler({ rawInput: "logout" })) as DshCommandResult;
        expect(result.kind).toBe("success");
        expect(auth.logout).toHaveBeenCalledOnce();
        expect(client.invalidateModels).toHaveBeenCalledOnce();
        expect(metrics.clear).toHaveBeenCalledOnce();
    });

    it("status renders session info when logged in", async () => {
        const { auth, client, metrics } = makeDeps({
            auth: {
                status: vi.fn(async () => ({
                    hasSession: true,
                    source: "device_flow",
                    expiresAt: Math.floor(NOW / 1000) + 3600,
                    endpoints: { api: "https://api.individual.githubcopilot.com" },
                    sku: "individual",
                })),
            },
            client: {
                listModels: vi.fn(async () => [{ id: "gpt-4o-mini" }]),
            },
        });
        const handler = makeCopilotCommandHandler({ auth, client, metrics });
        const result = (await handler({ rawInput: "status" })) as DshCommandResult;
        expect(result.kind).toBe("success");
        expect(result.text).toContain("copilot: ok");
        expect(result.text).toContain("sku=individual");
        expect(result.text).toContain("models=1");
    });
});
