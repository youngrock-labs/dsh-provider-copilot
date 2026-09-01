/**
 * Plugin entry point.
 *
 * Exposed as `registerCopilot(ctx)` — dsh's extension loader invokes this
 * once at startup. The entry:
 *   1. Wires AuthManager → CopilotClient → CopilotProvider (lazy).
 *   2. Wraps the provider with metrics.
 *   3. Registers `/copilot login|logout|status` commands.
 *   4. Returns a disposer that dsh calls on shutdown.
 *
 * We do NOT declare a hard runtime dep on dsh; the ctx shape below is the
 * minimal contract we care about, and dsh's real ctx is a superset.
 */

import { AuthManager, type DeviceCode } from "../auth/index.js";
import { CopilotClient } from "../client/copilotClient.js";
import { CopilotProvider } from "../provider/copilotProvider.js";
import { MetricsRing } from "./metrics.js";
import { MeteredProvider } from "./meteredProvider.js";
import { login, logout, status, formatStatus } from "./commands.js";

export interface DshCommandCtx {
    args: string[];
    signal?: AbortSignal;
    println(line: string): void;
}

export type DshCommandHandler = (ctx: DshCommandCtx) => Promise<void>;

export interface DshRegistrationCtx {
    registerProvider(provider: unknown): void;
    registerCommand(name: string, handler: DshCommandHandler): void;
    /** dsh calls disposers on plugin unload / shutdown. */
    effect?(dispose: () => void | Promise<void>): void;
}

export interface RegisterOptions {
    /** Override the metrics ring capacity (default 10, per PLAN Phase 5). */
    metricsCapacity?: number;
    /** Injectable clock for tests. */
    now?: () => number;
    /** Injectable fetch for tests. */
    fetchImpl?: typeof fetch;
}

export interface RegisterHandle {
    auth: AuthManager;
    client: CopilotClient;
    provider: MeteredProvider;
    metrics: MetricsRing;
    dispose: () => void;
}

/**
 * Register the copilot provider and commands. Returns a handle mainly for
 * tests; dsh itself only needs the side effects on `ctx`.
 */
export function registerCopilot(ctx: DshRegistrationCtx, opts: RegisterOptions = {}): RegisterHandle {
    const now = opts.now ?? Date.now;
    const authOpts: ConstructorParameters<typeof AuthManager>[0] = {};
    if (opts.fetchImpl) authOpts.fetchImpl = opts.fetchImpl;
    if (opts.now) authOpts.now = opts.now;
    const auth = new AuthManager(authOpts);

    const client = new CopilotClient({
        getBearer: async () => {
            const s = await auth.getSession();
            return { token: s.token, endpoints: { api: s.endpoints.api } };
        },
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        now,
    });

    const metrics = new MetricsRing(opts.metricsCapacity ?? 10);
    const raw = new CopilotProvider({ client });
    const provider = new MeteredProvider(raw, metrics, now);
    const deps = { auth, client, metrics, now };

    ctx.registerProvider(provider);

    ctx.registerCommand("copilot", async (cctx) => {
        const sub = cctx.args[0] ?? "status";
        switch (sub) {
            case "login": {
                const onCode = (code: DeviceCode): void => {
                    cctx.println(`open: ${code.verificationUri}`);
                    cctx.println(`code: ${code.userCode}`);
                    cctx.println("waiting for authorization...");
                };
                try {
                    const res = await login(deps, onCode, cctx.signal);
                    cctx.println(`logged in. endpoints.api=${res.endpoints.api}`);
                } catch (e) {
                    cctx.println(`login failed: ${(e as Error).message}`);
                }
                return;
            }
            case "logout": {
                await logout(deps);
                cctx.println("logged out");
                return;
            }
            case "status":
            case undefined: {
                const s = await status(deps);
                cctx.println(formatStatus(s));
                return;
            }
            default:
                cctx.println(`unknown subcommand: ${sub}. usage: /copilot [login|logout|status]`);
        }
    });

    const dispose = (): void => {
        client.invalidateModels();
        metrics.clear();
    };
    ctx.effect?.(dispose);

    return { auth, client, provider, metrics, dispose };
}
