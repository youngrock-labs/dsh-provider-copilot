/**
 * Adapter error taxonomy for the dsh stream boundary.
 *
 * dsh normalizes anything an adapter throws into a terminal `finish` chunk.
 * Its normalizer (`packages/llm/llm/src/adapter-failure.ts` in the dsh
 * repository) trusts a thrown value that carries its OWN data properties
 * `code` and `failure` when both agree, even across package copies — which is
 * exactly how a shape-bound plugin can surface stable codes without importing
 * `LlmError` from `@deepseek-ai/dsh-llm`. This mirror keeps that shape, so
 * switching to the real class later is a one-line import change.
 */

import type { LlmFailure } from "./protocol.js";

export interface LlmErrorOptions {
    /** Valid HTTP status observed at the provider boundary. */
    status?: number;
    /** Positive finite provider-requested delay in milliseconds. */
    providerRetryAfterMs?: number;
    /** Non-empty opaque provider request id. */
    requestId?: string;
    /** Wrapped upstream cause (auth, client, transport). */
    cause?: unknown;
}

/** Stable codes the adapter maps upstream failures onto. */
export const ERROR_CODES = {
    MISSING_CREDENTIAL: "MISSING_CREDENTIAL",
    AUTH: "AUTH",
    RATE_LIMIT: "RATE_LIMIT",
    INVALID_REQUEST: "INVALID_REQUEST",
    INVALID_MODEL: "INVALID_MODEL",
    CONTEXT_WINDOW_EXCEEDED: "CONTEXT_WINDOW_EXCEEDED",
    SERVER: "SERVER",
    NETWORK: "NETWORK",
    TIMEOUT: "TIMEOUT",
    STREAM_IDLE_TIMEOUT: "STREAM_IDLE_TIMEOUT",
    ABORTED: "ABORTED",
    MALFORMED_RESPONSE: "MALFORMED_RESPONSE",
    EMPTY_RESPONSE: "EMPTY_RESPONSE",
    STREAM_CLOSED: "STREAM_CLOSED",
    UNSUPPORTED_CONTENT: "UNSUPPORTED_CONTENT",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Adapter-bound error: throws from `stream()` (or values a stream yields as
 * terminal failures) must be this class so dsh can route on a stable code.
 */
export class LlmError extends Error {
    override readonly name = "LlmError";
    /** Own data property (not a prototype accessor) so dsh can read it cross-package. */
    readonly code: string;
    /** Serializable facts dsh detaches into the terminal failure chunk. */
    readonly failure: LlmFailure;

    constructor(message: string, code: string, options?: LlmErrorOptions) {
        if (typeof message !== "string" || message.length === 0) {
            throw new Error("LlmError message must be a non-empty string");
        }
        if (typeof code !== "string" || code.length === 0) {
            throw new Error("LlmError code must be a non-empty string");
        }
        super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
        // Own data properties (not prototype accessors) — this is what dsh's
        // cross-package normalizer reads.
        this.code = code;
        if (options?.status !== undefined
            && (!Number.isInteger(options.status) || options.status < 100 || options.status > 599)) {
            throw new Error("LlmError status must be an integer from 100 through 599");
        }
        if (options?.providerRetryAfterMs !== undefined
            && (!Number.isFinite(options.providerRetryAfterMs) || options.providerRetryAfterMs <= 0)) {
            throw new Error("LlmError providerRetryAfterMs must be a positive finite number");
        }
        if (options?.requestId !== undefined && options.requestId.length === 0) {
            throw new Error("LlmError requestId must be non-empty");
        }
        this.failure = Object.freeze({
            message,
            code,
            ...(options?.status === undefined ? {} : { status: options.status }),
            ...(options?.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: options.providerRetryAfterMs }),
            ...(options?.requestId === undefined ? {} : { requestId: options.requestId }),
        });
    }
}

/** Stable code for one HTTP status observed at the Copilot boundary. */
export function httpErrorCode(status: number): string {
    if (status === 401 || status === 403) return ERROR_CODES.AUTH;
    if (status === 429) return ERROR_CODES.RATE_LIMIT;
    if (status === 400) return ERROR_CODES.INVALID_REQUEST;
    if (status === 404) return ERROR_CODES.INVALID_MODEL;
    if (status >= 500) return ERROR_CODES.SERVER;
    return `HTTP_${status}`;
}

/**
 * Map any upstream throw (auth, client, transport, or a previous LlmError)
 * onto a stable `LlmError` suitable for the adapter stream boundary.
 * Unknown throws keep a generic message and code so no caller crashes on an
 * unexpected shape.
 */
export function toLlmError(error: unknown): LlmError {
    if (error instanceof LlmError) return error;
    if (error instanceof Error) {
        const typed = error as Error & { code?: unknown; status?: unknown; providerRetryAfterMs?: unknown };
        const upstreamCode = typeof typed.code === "string" ? typed.code : "";
        const message = error.message.length > 0 ? error.message : "LLM adapter failed";
        const status = Number.isInteger(typed.status) ? (typed.status as number) : undefined;

        if (upstreamCode === "no_token_source") {
            return new LlmError(
                "no Copilot credential available; run /copilot login or set COPILOT_TOKEN / COPILOT_GITHUB_TOKEN",
                ERROR_CODES.MISSING_CREDENTIAL,
                status !== undefined ? { status, cause: error } : { cause: error },
            );
        }
        if (upstreamCode === "token_exchange_unauthorized" || upstreamCode === "token_exchange_forbidden") {
            return new LlmError(
                `Copilot token exchange refused (${upstreamCode}); re-run /copilot login`,
                ERROR_CODES.AUTH,
                status !== undefined ? { status, cause: error } : { cause: error },
            );
        }
        if (upstreamCode.startsWith("device_flow_")) {
            return new LlmError(
                `Copilot device login failed: ${upstreamCode}`,
                ERROR_CODES.AUTH,
                { cause: error },
            );
        }
        if (upstreamCode === "http_status") {
            const code = httpErrorCode(status ?? 0);
            return new LlmError(
                `Copilot API error (HTTP ${status ?? "?"}): ${message}`,
                code,
                status !== undefined ? { status, cause: error } : { cause: error },
            );
        }
        if (upstreamCode === "http_aborted") return new LlmError(message, ERROR_CODES.ABORTED, { cause: error });
        if (upstreamCode === "http_idle_timeout" || upstreamCode === "sse_stream_error") {
            return new LlmError(message, ERROR_CODES.STREAM_IDLE_TIMEOUT, { cause: error });
        }
        if (upstreamCode.startsWith("http_")) {
            // connect / first-byte / total timeouts and network failures.
            const code = upstreamCode.includes("timeout") ? ERROR_CODES.TIMEOUT : ERROR_CODES.NETWORK;
            return new LlmError(message, code, { cause: error });
        }
        if (upstreamCode === "sse_bad_frame") {
            return new LlmError(message, ERROR_CODES.MALFORMED_RESPONSE, { cause: error });
        }
        // Unknown upstream code: preserve the original message, fall back to
        // the stable transport code rather than inventing a taxonomy entry.
        return new LlmError(message, ERROR_CODES.NETWORK, status !== undefined ? { status, cause: error } : { cause: error });
    }
    const text = String(error);
    return new LlmError(text.length > 0 ? text : "LLM adapter failed", ERROR_CODES.NETWORK, { cause: error });
}

/** Extract a stable machine code from any thrown value, for observability. */
export function errorCodeOf(error: unknown): string {
    if (error instanceof LlmError) return error.failure.code;
    if (error instanceof Error) {
        const code = (error as Error & { code?: unknown }).code;
        if (typeof code === "string" && code.length > 0) return code;
        return error.name;
    }
    return "unknown";
}
