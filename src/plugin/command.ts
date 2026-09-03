/**
 * The `/copilot login | logout | status` command for the dsh command
 * registry.
 *
 * The dsh command surface is "settle once, return text" (`CommandResult`), so
 * `login` cannot stream the device code as it arrives. It therefore returns
 * the code and verification URL immediately and continues polling in the
 * background; a follow-up `/copilot status` confirms the result.
 */

import type { AuthManager } from "../auth/index.js";
import type { MetricsRing } from "../commands/metrics.js";
import type { JsonlLogger } from "../observability/index.js";
import { newRequestId } from "../observability/index.js";
import type { CopilotClientLike } from "./copilotAdapter.js";
import type { DshCommandInvocation, DshCommandResult } from "./dshSurface.js";

/** Dependencies shared with the legacy shell command handlers. */
export interface CopilotCommandDeps {
    auth: AuthManager;
    client: CopilotClientLike;
    metrics: MetricsRing;
    now?: () => number;
}

export interface CopilotCommandOptions {
    logger?: JsonlLogger;
    /** Called with diagnostics when a background login settles. */
    onBackgroundSettled?: (info: { ok: boolean; errorCode?: string }) => void;
}

function usageError(): DshCommandResult {
    return { kind: "error", text: "usage: /copilot [login|logout|status]" };
}

/** Render `/copilot status` output without throwing on network failures. */
async function statusText(deps: CopilotCommandDeps): Promise<DshCommandResult> {
    const now = (deps.now ?? Date.now)();
    const authStatus = await deps.auth.status();
    let modelCount: number | null = null;
    let sku: string | undefined;
    if (authStatus.hasSession) {
        modelCount = await deps.client
            .listModels()
            .then((models) => models.length)
            .catch(() => null);
        sku = authStatus.sku;
    }
    const percentiles = deps.metrics.percentiles();
    const expiresInSeconds = authStatus.expiresAt !== null
        ? Math.max(0, authStatus.expiresAt - Math.floor(now / 1000))
        : null;
    const source = authStatus.source ?? "unknown";
    const exp = expiresInSeconds === null
        ? "?"
        : expiresInSeconds > 3600
            ? `${Math.floor(expiresInSeconds / 3600)}h`
            : `${Math.max(1, Math.floor(expiresInSeconds / 60))}m`;
    const models = modelCount === null ? "?" : String(modelCount);
    const lat = percentiles !== null
        ? ` p50=${percentiles.p50}ms p95=${percentiles.p95}ms (n=${percentiles.n})`
        : "";
    const skuText = sku !== undefined ? ` sku=${sku}` : "";
    return {
        kind: authStatus.hasSession ? "success" : "error",
        text: authStatus.hasSession
            ? `copilot: ok (${source}${skuText}) expires_in=${exp} models=${models}${lat}`
            : "copilot: not logged in — run `/copilot login`",
    };
}

/**
 * Build the `copilot` command handler. `login` prints the device code and
 * returns; authorization continues in the background and is confirmed with
 * `/copilot status`. `logout` wipes memory, the on-disk cache, the models
 * cache, and the metrics ring. `status` never throws.
 */
export function makeCopilotCommandHandler(
    deps: CopilotCommandDeps,
    opts: CopilotCommandOptions = {},
): (invocation: DshCommandInvocation) => Promise<DshCommandResult> {
    const logger = opts.logger;
    const onBackgroundSettled = opts.onBackgroundSettled;

    return async (invocation) => {
        const [sub] = invocation.rawInput.trim().split(/\s+/);
        switch (sub) {
            case "login": {
                let codeText: string;
                try {
                    const { code, done } = await deps.auth.beginLogin(invocation.signal);
                    codeText = `open: ${code.verificationUri}\ncode: ${code.userCode}`;
                    // Background: exchange + persist once the user authorizes.
                    void done.then(
                        () => {
                            deps.client.invalidateModels();
                            if (logger) {
                                void logger.write({
                                    ts: "",
                                    requestId: newRequestId(),
                                    event: "auth_login",
                                    source: "device_flow",
                                });
                            }
                            onBackgroundSettled?.({ ok: true });
                        },
                        (error: unknown) => {
                            const code = error instanceof Error
                                ? (error as Error & { code?: unknown }).code
                                : undefined;
                            onBackgroundSettled?.({
                                ok: false,
                                ...(typeof code === "string" ? { errorCode: code } : {}),
                            });
                        },
                    );
                } catch (error) {
                    return {
                        kind: "error",
                        text: `login failed: ${error instanceof Error ? error.message : String(error)}`,
                    };
                }
                return {
                    kind: "success",
                    text: `${codeText}\nwaiting for authorization... run \`/copilot status\` when done`,
                };
            }
            case "logout": {
                await deps.auth.logout();
                deps.client.invalidateModels();
                deps.metrics.clear();
                if (logger) {
                    await logger.write({ ts: "", requestId: newRequestId(), event: "auth_logout" });
                }
                return { kind: "success", text: "logged out" };
            }
            case "status":
            case undefined:
                return statusText(deps);
            default:
                return usageError();
        }
    };
}
