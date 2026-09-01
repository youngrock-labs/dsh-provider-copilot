import { describe, it, expect } from "vitest";
import { status, formatStatus, logout, type CommandDeps } from "../../src/commands/commands.js";
import { MetricsRing } from "../../src/commands/metrics.js";
import type { AuthManager, AuthStatus } from "../../src/auth/index.js";
import type { CopilotClient } from "../../src/client/copilotClient.js";

function makeDeps(overrides: {
    auth?: Partial<AuthManager>;
    authStatus?: AuthStatus;
    models?: { id: string }[];
    modelsThrows?: boolean;
    metricsSeed?: { latencyMs: number; ok: boolean }[];
    now?: number;
}): CommandDeps {
    const metrics = new MetricsRing(10);
    for (const s of overrides.metricsSeed ?? []) {
        metrics.record({ at: 0, model: "m", latencyMs: s.latencyMs, ok: s.ok });
    }
    const auth = {
        status: async () =>
            overrides.authStatus ?? {
                hasSession: false,
                source: null,
                expiresAt: null,
                endpoints: null,
            },
        logout: async () => undefined,
        ...overrides.auth,
    } as unknown as AuthManager;
    const client = {
        listModels: async () => {
            if (overrides.modelsThrows) throw new Error("network");
            return overrides.models ?? [];
        },
        invalidateModels: () => undefined,
    } as unknown as CopilotClient;
    return { auth, client, metrics, now: () => overrides.now ?? 2_000_000_000_000 };
}

describe("status()", () => {
    it("returns a not-logged-in shape when auth has no session", async () => {
        const s = await status(makeDeps({}));
        expect(s.hasSession).toBe(false);
        expect(s.modelCount).toBeNull();
        expect(formatStatus(s)).toMatch(/not logged in/);
    });

    it("returns model count + p50/p95 when logged in", async () => {
        const s = await status(
            makeDeps({
                authStatus: {
                    hasSession: true,
                    source: "cache",
                    expiresAt: Math.floor(2_000_000_000_000 / 1000) + 1800,
                    endpoints: { api: "https://api.individual.githubcopilot.com" },
                    sku: "individual",
                },
                models: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }],
                metricsSeed: [
                    { latencyMs: 100, ok: true },
                    { latencyMs: 200, ok: true },
                    { latencyMs: 300, ok: true },
                ],
                now: 2_000_000_000_000,
            }),
        );
        expect(s.hasSession).toBe(true);
        expect(s.modelCount).toBe(2);
        expect(s.expiresInSeconds).toBe(1800);
        expect(s.latency).toEqual({ p50: 200, p95: 300, n: 3 });
        expect(formatStatus(s)).toContain("copilot: ok");
        expect(formatStatus(s)).toContain("sku=individual");
        expect(formatStatus(s)).toContain("models=2");
    });

    it("still renders when /models throws (modelCount = null)", async () => {
        const s = await status(
            makeDeps({
                authStatus: {
                    hasSession: true,
                    source: "device_flow",
                    expiresAt: Math.floor(2_000_000_000_000 / 1000) + 60,
                    endpoints: { api: "https://x" },
                },
                modelsThrows: true,
            }),
        );
        expect(s.hasSession).toBe(true);
        expect(s.modelCount).toBeNull();
    });
});

describe("logout()", () => {
    it("clears metrics ring and invalidates models cache", async () => {
        let invalidated = false;
        const deps = makeDeps({
            metricsSeed: [{ latencyMs: 1, ok: true }],
        });
        (deps.client as unknown as { invalidateModels: () => void }).invalidateModels = () => {
            invalidated = true;
        };
        await logout(deps);
        expect(invalidated).toBe(true);
        expect(deps.metrics.size()).toBe(0);
    });
});
