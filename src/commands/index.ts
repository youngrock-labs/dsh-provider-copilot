export { MetricsRing, type CallRecord } from "./metrics.js";
export { MeteredProvider } from "./meteredProvider.js";
export { login, logout, status, formatStatus } from "./commands.js";
export type { CommandDeps, LoginResult, LogoutResult, StatusResult } from "./commands.js";
export {
} from "./entry.js";
    type RegisterHandle,
    type RegisterOptions,
    type DshRegistrationCtx,
    type DshCommandHandler,
    type DshCommandCtx,
    registerCopilot,
