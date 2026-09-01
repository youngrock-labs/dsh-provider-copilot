/** Typed HTTP client errors. Callers key on `.code` (never string matching). */
export type ClientErrorCode =
    | "http_connect_timeout"
    | "http_first_byte_timeout"
    | "http_idle_timeout"
    | "http_total_timeout"
    | "http_status" // non-2xx from a non-streaming endpoint
    | "http_aborted" // caller-provided AbortSignal fired
    | "http_network" // fetch threw / socket error
    | "sse_stream_error" // upstream disconnected mid-stream
    | "sse_bad_frame"; // malformed SSE payload (kept for observability; parser skips)

export class ClientError extends Error {
    override readonly name = "ClientError";
    readonly code: ClientErrorCode;
    readonly status?: number;
    constructor(code: ClientErrorCode, message: string, opts?: { status?: number; cause?: unknown }) {
        super(message, opts?.cause ? { cause: opts.cause } : undefined);
        this.code = code;
        if (opts?.status !== undefined) this.status = opts.status;
    }
}
