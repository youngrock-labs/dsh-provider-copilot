/**
 * Structured log record and the strict allowlist of fields we ever emit.
 *
 * PLAN.md Phase 5 hard rule: never log messages, request/response bodies,
 * headers, tokens, or full error bodies. This module exposes ONLY the
 * fields listed here — the whole point is to make leakage a compile error.
 *
 * `requestId` is a UUIDv4 minted per stream call; downstream tooling can
 * correlate a metrics ring entry with a JSONL line by id.
 */

export interface LogRecord {
    ts: string; // ISO-8601, seconds precision
    requestId: string;
    event: "stream_start" | "stream_end" | "stream_error" | "auth_login" | "auth_logout" | "auth_refresh";
    model?: string;
    /** Never a full body; opaque error code from ClientError / AuthError. */
    errorCode?: string;
    latencyMs?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    /** Auth source, when relevant (`cache`, `device_flow`, `env_copilot_token`, ...). */
    source?: string;
    /** SKU tier for observability of tier-specific bugs (`individual` etc.). */
    sku?: string;
}

/** Structural check that a record only contains allowed fields. */
export function assertLogSafe(record: LogRecord): void {
    const allowed = new Set<keyof LogRecord>([
        "ts",
        "requestId",
        "event",
        "model",
        "errorCode",
        "latencyMs",
        "promptTokens",
        "completionTokens",
        "totalTokens",
        "source",
        "sku",
    ]);
    for (const k of Object.keys(record)) {
        if (!allowed.has(k as keyof LogRecord)) {
            throw new Error(`log record contains disallowed field: ${k}`);
        }
    }
}
