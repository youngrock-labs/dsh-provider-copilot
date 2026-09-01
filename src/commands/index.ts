export { MetricsRing, type CallRecord } from "./metrics.js";
export { MeteredProvider } from "./meteredProvider.js";
export { login, logout, status, formatStatus } from "./commands.js";
export type { CommandDeps, LoginResult, LogoutResult, StatusResult } from "./commands.js";
export {
    registerCopilot,
    type DshCommandCtx,
    type DshCommandHandler,
    type DshRegistrationCtx,
    type RegisterOptions,
    type RegisterHandle,
} from "./entry.js";
