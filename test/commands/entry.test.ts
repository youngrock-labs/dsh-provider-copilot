import { describe, it, expect } from "vitest";
import { registerCopilot, type DshCommandHandler, type DshRegistrationCtx } from "../../src/commands/entry.js";

function makeCtx(): {
    ctx: DshRegistrationCtx;
    provider: unknown;
    commands: Map<string, DshCommandHandler>;
    disposers: (() => void | Promise<void>)[];
} {
    let provider: unknown = null;
    const commands = new Map<string, DshCommandHandler>();
    const disposers: (() => void | Promise<void>)[] = [];
    const ctx: DshRegistrationCtx = {
        registerProvider: (p) => {
            provider = p;
        },
        registerCommand: (n, h) => commands.set(n, h),
        effect: (d) => disposers.push(d),
    };
    return { ctx, get provider() { return provider; }, commands, disposers } as unknown as {
        ctx: DshRegistrationCtx;
        provider: unknown;
        commands: Map<string, DshCommandHandler>;
        disposers: (() => void | Promise<void>)[];
    };
}

describe("registerCopilot", () => {
    it("registers a provider and a /copilot command", () => {
        const { ctx, commands } = makeCtx();
        const handle = registerCopilot(ctx);
        expect(commands.has("copilot")).toBe(true);
        expect(handle.provider.id).toBe("copilot");
    });

    it("/copilot status prints a formatted status line", async () => {
        const { ctx, commands } = makeCtx();
        registerCopilot(ctx);
        const lines: string[] = [];
        await commands.get("copilot")!({ args: ["status"], println: (l) => lines.push(l) });
        expect(lines.length).toBe(1);
        expect(lines[0]).toMatch(/^copilot: /);
    });

    it("/copilot status is the default subcommand", async () => {
        const { ctx, commands } = makeCtx();
        registerCopilot(ctx);
        const lines: string[] = [];
        await commands.get("copilot")!({ args: [], println: (l) => lines.push(l) });
        expect(lines[0]).toMatch(/^copilot: /);
    });

    it("/copilot logout prints confirmation", async () => {
        const { ctx, commands } = makeCtx();
        registerCopilot(ctx);
        const lines: string[] = [];
        await commands.get("copilot")!({ args: ["logout"], println: (l) => lines.push(l) });
        expect(lines).toContain("logged out");
    });

    it("unknown subcommand prints usage", async () => {
        const { ctx, commands } = makeCtx();
        registerCopilot(ctx);
        const lines: string[] = [];
        await commands.get("copilot")!({ args: ["bogus"], println: (l) => lines.push(l) });
        expect(lines[0]).toMatch(/unknown subcommand/);
    });

    it("registers a disposer via ctx.effect", () => {
        const { ctx, disposers } = makeCtx();
        const handle = registerCopilot(ctx);
        expect(disposers.length).toBe(1);
        // Idempotent-safe: manual dispose doesn't throw.
        expect(() => handle.dispose()).not.toThrow();
    });
});
