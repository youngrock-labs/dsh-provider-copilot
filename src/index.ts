// Public exports. Phase 1: auth/, Phase 2: client/, Phase 3: provider/, Phase 4: commands/, Phase 5: observability/.
export const VERSION = "0.0.1";
export * from "./auth/index.js";
export * from "./client/index.js";
export * from "./provider/index.js";
export * from "./commands/index.js";
export * from "./observability/index.js";

// dsh plugin surface (see INTEGRATION.md / PLAN.md): a cordis object plugin
// that registers the Copilot adapter route(s) on ctx.llm when mounted.
export { name, inject, apply } from "./plugin/plugin.js";
export { resolvePluginConfig } from "./plugin/config.js";
export type { CopilotPluginConfig, ResolvedPluginConfig } from "./plugin/config.js";
export { CopilotAdapter } from "./plugin/copilotAdapter.js";
export type {
    CopilotAdapterOptions,
    CopilotClientLike,
    CopilotCallObserver,
    UsageSummary,
} from "./plugin/copilotAdapter.js";
export { LlmError, ERROR_CODES } from "./plugin/errors.js";
export type { LlmErrorOptions, ErrorCode } from "./plugin/errors.js";
export { translate, mapFinishReason, mapUsage } from "./plugin/translate.js";
export type {
    DshCommandDefinition,
    DshCommandInvocation,
    DshCommandResult,
    DshCommandsService,
    DshContextLike,
    DshInjectedContext,
    DshLlmService,
} from "./plugin/dshSurface.js";

