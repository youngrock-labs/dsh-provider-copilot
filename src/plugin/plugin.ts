/**
 * dsh plugin entry: `name` / `inject` / `apply` (cordis object plugin).
 *
 * Mounting this package in a dsh profile (see `cordis.patch.yml`) makes dsh
 * call `apply(ctx, config)` once the `llm` service is up. The plugin then:
 *   1. wires AuthManager → CopilotClient → CopilotAdapter (lazy auth);
 *   2. registers the provider route(s) on `ctx.llm` — the model picker and
 *      session routing pick it up automatically (`llm/adapters-updated`);
 *   3. registers the `/copilot login|logout|status` command when the dsh
 *      command service is present;
 *   4. records per-call metrics + JSONL log lines through an observer.
 *
 * Registration lives on the apply fiber (cordis effects), so it is released
 * automatically when the plugin is unloaded or hot-reloaded.
 */

import { AuthManager } from "../auth/index.js";
import { CopilotClient } from "../client/copilotClient.js";
import { MetricsRing } from "../commands/metrics.js";
import { JsonlLogger } from "../observability/index.js";
import { CopilotAdapter } from "./copilotAdapter.js";
import type { CopilotAdapterOptions, CopilotCallObserver } from "./copilotAdapter.js";
import { makeCopilotCommandHandler } from "./command.js";
import { resolvePluginConfig, type CopilotPluginConfig } from "./config.js";
import type { DshCommandsService, DshContextLike } from "./dshSurface.js";

export const name = "llm-copilot";

/** Provider registration happens once the `llm` service exists. */
export const inject = ["llm"];

const COMMAND_NAME = "copilot";
const COMMAND_DESCRIPTION = "Manage GitHub Copilot sign-in and status (login, status, logout).";

/**
 * Activate the Copilot provider in one dsh composition. Idempotent per
 * apply fiber; config changes that need a re-registration are handled by the
 * loader restarting the plugin (or, later, a settings section driving
 * `registration.replace`).
 */
export function apply(ctx: DshContextLike, rawConfig?: CopilotPluginConfig): void {
    const config = resolvePluginConfig(rawConfig);
    const now = Date.now;

    const auth = new AuthManager();
    const clientOptions: ConstructorParameters<typeof CopilotClient>[0] = {
        getBearer: () => auth.getBearer(),
        now,
        ...(config.timeouts !== undefined ? { timeouts: config.timeouts } : {}),
        ...(config.modelsTtlMs !== undefined ? { modelsTtlMs: config.modelsTtlMs } : {}),
    };
    const client = new CopilotClient(clientOptions);
    const metrics = new MetricsRing();
    const logger = new JsonlLogger({ disabled: config.disableLog });

    const adapterOptions: CopilotAdapterOptions = {
        client,
        peekSession: () => auth.status(),
        observer: makeObserver(metrics, logger, now),
        now,
        ...(config.defaultContextWindow !== undefined
            ? { defaultContextWindow: config.defaultContextWindow }
            : {}),
        ...(config.defaultMaxTokens !== undefined ? { defaultMaxTokens: config.defaultMaxTokens } : {}),
    };
    const adapter = new CopilotAdapter(adapterOptions);

    ctx.llm.registerAdapter([...config.providers], adapter);

    if (!config.registerCommands) return;
    const registerCommand = (services: { commands?: DshCommandsService }): void => {
        services.commands?.register({
            name: COMMAND_NAME,
            description: COMMAND_DESCRIPTION,
            // Host-input declaration: without it dsh treats the command as
            // "bare" and only executes it with no trailing arguments, so
            // `/copilot status` would fall through to the model.
            input: { hint: "login|logout|status" },
            handler: makeCopilotCommandHandler(
                { auth, client, metrics, now },
                {
                    logger,
                    onBackgroundSettled: (info) => {
                        if (!info.ok) {
                            ctx.logger?.warn?.(
                                `llm-copilot: background login failed${info.errorCode === undefined
                                    ? ""
                                    : ` (${info.errorCode})`}`,
                            );
                        }
                    },
                },
            ),
        });
    };
    if (ctx.inject !== undefined) {
        // The commands service may start after this plugin; inject defers
        // registration until it does (mirrors llm-pi-ai's authorization seam).
        ctx.inject(["commands"], registerCommand);
    } else {
        const commands = ctx.get?.<DshCommandsService>("commands");
        if (commands !== undefined) registerCommand({ commands });
    }
}

/** Per-call metrics + JSONL instrumentation shared by the adapter observer. */
function makeObserver(
    metrics: MetricsRing,
    logger: JsonlLogger,
    now: () => number,
): CopilotCallObserver {
    return {
        onStart: async (info) => {
            await logger.write({
                ts: "",
                requestId: info.requestId,
                event: "stream_start",
                model: info.model,
            });
        },
        onEnd: async (info) => {
            metrics.record({
                at: now(),
                model: info.model,
                latencyMs: info.latencyMs,
                ok: info.ok,
                ...(info.errorCode === undefined ? {} : { errorCode: info.errorCode }),
                ...(info.usage?.promptTokens !== undefined
                    ? { promptTokens: info.usage.promptTokens }
                    : {}),
                ...(info.usage?.completionTokens !== undefined
                    ? { completionTokens: info.usage.completionTokens }
                    : {}),
            });
            await logger.write({
                ts: "",
                requestId: info.requestId,
                event: info.ok ? "stream_end" : "stream_error",
                model: info.model,
                latencyMs: info.latencyMs,
                ...(info.errorCode === undefined ? {} : { errorCode: info.errorCode }),
                ...(info.usage?.promptTokens !== undefined
                    ? { promptTokens: info.usage.promptTokens }
                    : {}),
                ...(info.usage?.completionTokens !== undefined
                    ? { completionTokens: info.usage.completionTokens }
                    : {}),
                ...(info.usage?.totalTokens !== undefined ? { totalTokens: info.usage.totalTokens } : {}),
            });
        },
    };
}
