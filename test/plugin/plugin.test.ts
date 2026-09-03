import { describe, it, expect, vi } from "vitest";
import { CopilotAdapter } from "../../src/plugin/copilotAdapter.js";
import { apply, inject, name } from "../../src/plugin/plugin.js";
import type { DshContextLike, DshInjectedContext } from "../../src/plugin/dshSurface.js";

interface FakeCtx {
    ctx: DshContextLike;
    registerAdapter: ReturnType<typeof vi.fn>;
    injected: Array<(ctx: DshInjectedContext) => void>;
    registered: Array<{ name: string; description: string; handler: unknown }>;
}

function makeCtx(overrides?: { withCommandsService?: boolean; registerCommandsConfig?: boolean }): FakeCtx {
    const registerAdapter = vi.fn();
    const registered: FakeCtx["registered"] = [];
    const injected: FakeCtx["injected"] = [];
    const services = overrides?.withCommandsService === true
        ? { commands: { register: (def: FakeCtx["registered"][number]) => registered.push(def) } }
        : undefined;
    const ctx: DshContextLike = {
        llm: { registerAdapter },
        inject: (_, callback) => { injected.push(callback); },
        get: () => services,
        logger: { warn: vi.fn(), error: vi.fn() },
    };
    return { ctx, registerAdapter, injected, registered };
}

describe("plugin surface", () => {
    it("exports the cordis object-plugin identity", () => {
        expect(name).toBe("llm-copilot");
        expect(inject).toEqual(["llm"]);
        expect(typeof apply).toBe("function");
    });

    it("registers the copilot route with a CopilotAdapter", () => {
        const fake = makeCtx();
        apply(fake.ctx, {});
        expect(fake.registerAdapter).toHaveBeenCalledTimes(1);
        const [providers, adapter] = fake.registerAdapter.mock.calls[0]! as [string[], unknown];
        expect(providers).toEqual(["copilot"]);
        expect(adapter).toBeInstanceOf(CopilotAdapter);
    });

    it("registers every configured provider route", () => {
        const fake = makeCtx();
        apply(fake.ctx, { providers: ["copilot", "copilot-eu"] });
        const [providers] = fake.registerAdapter.mock.calls[0]! as [string[], unknown];
        expect(providers).toEqual(["copilot", "copilot-eu"]);
    });

    it("registers /copilot once the commands service is available", () => {
        const fake = makeCtx();
        apply(fake.ctx, {});
        expect(fake.injected).toHaveLength(1);
        // Simulate the commands service coming up after this plugin.
        fake.injected[0]!({
            commands: { register: (def) => fake.registered.push(def) },
        });
        expect(fake.registered).toHaveLength(1);
        expect(fake.registered[0]?.name).toBe("copilot");
        // Host-input declaration: required so the GUI executes `/copilot <arg>`.
        expect(fake.registered[0]?.input).toEqual({ hint: "login|logout|status" });
        expect(typeof fake.registered[0]?.handler).toBe("function");
    });

    it("skips command registration when disabled in config", () => {
        const fake = makeCtx({ withCommandsService: true });
        apply(fake.ctx, { registerCommands: false });
        // No inject subscription at all when commands are disabled.
        expect(fake.injected).toHaveLength(0);
        fake.injected[0]?.({ commands: { register: () => undefined } });
        expect(fake.registered).toHaveLength(0);
    });

    it("falls back to ctx.get when inject is absent", () => {
        const ctx: DshContextLike = {
            llm: { registerAdapter: vi.fn() },
            get: () => ({ register: () => undefined }),
            logger: { warn: vi.fn(), error: vi.fn() },
        };
        expect(() => apply(ctx, {})).not.toThrow();
    });

    it("surfaces invalid config as a throw from apply", () => {
        const fake = makeCtx();
        expect(() => apply(fake.ctx, { providers: ["copilot", "copilot"] })).toThrow(/duplicate/);
    });
});
