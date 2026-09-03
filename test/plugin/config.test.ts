import { afterEach, describe, it, expect, vi } from "vitest";
import { resolvePluginConfig } from "../../src/plugin/config.js";

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("resolvePluginConfig", () => {
    it("returns sensible defaults for an absent section", () => {
        const config = resolvePluginConfig(undefined);
        expect(config.providers).toEqual(["copilot"]);
        expect(config.registerCommands).toBe(true);
        expect(config.disableLog).toBe(false);
        expect(config.timeouts).toBeUndefined();
    });

    it("keeps provided providers and passes through tunables", () => {
        const config = resolvePluginConfig({
            providers: ["copilot", "copilot-eu"],
            timeouts: { connectMs: 5000, idleMs: 90000 },
            modelsTtlMs: 0,
            defaultContextWindow: 200000,
            defaultMaxTokens: 8192,
            registerCommands: false,
        });
        expect(config.providers).toEqual(["copilot", "copilot-eu"]);
        expect(config.timeouts).toEqual({ connectMs: 5000, idleMs: 90000 });
        expect(config.modelsTtlMs).toBe(0);
        expect(config.defaultContextWindow).toBe(200000);
        expect(config.defaultMaxTokens).toBe(8192);
        expect(config.registerCommands).toBe(false);
    });

    it("refuses duplicate or malformed provider routes", () => {
        expect(() => resolvePluginConfig({ providers: ["copilot", "copilot"] })).toThrow(/duplicate/);
        expect(() => resolvePluginConfig({ providers: ["Upper_Case"] })).toThrow(/route name/);
        expect(() => resolvePluginConfig({ providers: [] })).not.toThrow();
    });

    it("refuses invalid timeouts and negative modelsTtlMs", () => {
        expect(() => resolvePluginConfig({ timeouts: { idleMs: -1 } })).toThrow(/timeouts\.idleMs/);
        expect(() => resolvePluginConfig({ modelsTtlMs: -5 })).toThrow(/modelsTtlMs/);
        expect(() => resolvePluginConfig({ defaultContextWindow: 0 })).toThrow(/defaultContextWindow/);
    });

    it("honors DSH_COPILOT_NO_LOG for the log default", () => {
        vi.stubEnv("DSH_COPILOT_NO_LOG", "1");
        expect(resolvePluginConfig(undefined).disableLog).toBe(true);
        expect(resolvePluginConfig({ disableLog: false }).disableLog).toBe(false);
    });
});
