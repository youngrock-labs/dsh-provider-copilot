/**
 * Typed auth errors. Keep the error surface small and stable so callers
 * (provider, CLI) can key on `.code` instead of matching strings.
 */
export type AuthErrorCode =
    | "device_flow_slow_down" // internal: never surfaced to callers
    | "device_flow_expired" // user did not finish authorization in time
    | "device_flow_denied" // user clicked "cancel" / denied
    | "device_flow_timeout" // client-side polling deadline exceeded
    | "device_flow_http" // 4xx/5xx from device/access_token endpoints
    | "token_exchange_http" // 4xx/5xx from copilot_internal/v2/token
    | "token_exchange_forbidden" // 403 — likely no Copilot entitlement
    | "token_exchange_unauthorized" // 401 — bad or expired GitHub token
    | "no_token_source" // priority chain exhausted; no credential
    | "cache_io"; // read/write of on-disk cache failed

export class AuthError extends Error {
    override readonly name = "AuthError";
    readonly code: AuthErrorCode;
    readonly status?: number;
    constructor(code: AuthErrorCode, message: string, opts?: { status?: number; cause?: unknown }) {
        super(message, opts?.cause ? { cause: opts.cause } : undefined);
        this.code = code;
        if (opts?.status !== undefined) this.status = opts.status;
    }
}
