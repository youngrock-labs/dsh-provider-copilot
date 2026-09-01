/**
 * Cross-runtime fetch with layered timeouts and a single retry-on-429.
 *
 * Timeout layers (all optional, all in ms):
 *   - connectMs      Time until fetch resolves (headers received). Enforced with
 *                    an AbortController wired to the caller signal.
 *   - firstByteMs    From resolved-headers to the first stream byte. Enforced by
 *                    the streaming reader (see `withFirstByteTimeout`).
 *   - idleMs         Between consecutive bytes on a streaming response.
 *                    Enforced by the streaming reader.
 *   - totalMs        Wall-clock budget across the whole call, including retry.
 *
 * The connect timeout uses a fresh AbortController that is linked to the
 * caller-provided `signal` (via `AbortSignal.any` when available, else manual
 * forwarding) so the caller can always cancel.
 */

import { ClientError } from "./errors.js";

export interface HttpTimeouts {
    connectMs?: number;
    firstByteMs?: number;
    idleMs?: number;
    totalMs?: number;
}

export interface FetchOptions extends RequestInit {
    timeouts?: HttpTimeouts;
    /** Retry once on 429; honors `Retry-After` when a plain integer (seconds). */
    retryOn429?: boolean;
    /** Injectable for tests. */
    fetchImpl?: typeof fetch;
    /** Injectable for tests. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_TIMEOUTS: Required<HttpTimeouts> = {
    connectMs: 15_000,
    firstByteMs: 30_000,
    idleMs: 60_000,
    totalMs: 300_000,
};

export function resolveTimeouts(t?: HttpTimeouts): Required<HttpTimeouts> {
    return { ...DEFAULT_TIMEOUTS, ...(t ?? {}) };
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(t);
            reject(new DOMException("aborted", "AbortError"));
        };
        if (signal) {
            if (signal.aborted) {
                clearTimeout(t);
                reject(new DOMException("aborted", "AbortError"));
                return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
        }
    });

/**
 * fetch() with connect-timeout enforcement and optional 429 retry. Returns the
 * Response as-is; streaming-body timeouts are the responsibility of the reader
 * (see `withStreamTimeouts`).
 */
export async function fetchWithTimeouts(
    url: string,
    opts: FetchOptions = {},
): Promise<Response> {
    const f = opts.fetchImpl ?? fetch;
    const sleep = opts.sleep ?? defaultSleep;
    const timeouts = resolveTimeouts(opts.timeouts);
    const callerSignal = opts.signal ?? undefined;
    const totalDeadline = Date.now() + timeouts.totalMs;

    const attempt = async (isRetry: boolean): Promise<Response> => {
        if (callerSignal?.aborted) {
            throw new ClientError("http_aborted", "request aborted by caller");
        }
        const remainingTotal = totalDeadline - Date.now();
        if (remainingTotal <= 0) {
            throw new ClientError("http_total_timeout", "total request budget exceeded");
        }

        const ac = new AbortController();
        const linkedAbort = (): void => ac.abort();
        callerSignal?.addEventListener("abort", linkedAbort, { once: true });

        const connectBudget = Math.min(timeouts.connectMs, remainingTotal);
        const connectTimer = setTimeout(() => {
            (ac as AbortController & { __reason?: string }).__reason = "connect";
            ac.abort();
        }, connectBudget);

        try {
            const init: RequestInit = { ...opts, signal: ac.signal };
            delete (init as { timeouts?: unknown }).timeouts;
            delete (init as { fetchImpl?: unknown }).fetchImpl;
            delete (init as { sleep?: unknown }).sleep;
            delete (init as { retryOn429?: unknown }).retryOn429;
            const res = await f(url, init);

            if (res.status === 429 && opts.retryOn429 && !isRetry) {
                const wait = parseRetryAfter(res.headers.get("retry-after")) ?? 1000;
                await sleep(Math.min(wait, Math.max(0, totalDeadline - Date.now())), callerSignal);
                return attempt(true);
            }
            return res;
        } catch (e) {
            const err = e as Error & { name?: string };
            if (err?.name === "AbortError") {
                if (callerSignal?.aborted) {
                    throw new ClientError("http_aborted", "request aborted by caller", { cause: e });
                }
                if ((ac as AbortController & { __reason?: string }).__reason === "connect") {
                    throw new ClientError("http_connect_timeout", `connect timeout after ${connectBudget}ms`, {
                        cause: e,
                    });
                }
                throw new ClientError("http_aborted", "fetch aborted", { cause: e });
            }
            throw new ClientError("http_network", err?.message ?? "network error", { cause: e });
        } finally {
            clearTimeout(connectTimer);
            callerSignal?.removeEventListener("abort", linkedAbort);
        }
    };

    return attempt(false);
}

function parseRetryAfter(header: string | null): number | null {
    if (!header) return null;
    const asInt = Number.parseInt(header, 10);
    if (Number.isFinite(asInt) && String(asInt) === header.trim()) return asInt * 1000;
    const asDate = Date.parse(header);
    if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
    return null;
}

/**
 * Wrap a streaming body with first-byte + idle timeouts. Returns a new
 * ReadableStream that mirrors the input but errors with a typed ClientError on
 * either budget being exceeded. The stream is cancelled when either fires.
 */
export function withStreamTimeouts(
    body: ReadableStream<Uint8Array>,
    timeouts: Required<HttpTimeouts>,
): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    let firstByteSeen = false;
    let firstByteTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        controller?.error(
            new ClientError("http_first_byte_timeout", `no first byte within ${timeouts.firstByteMs}ms`),
        );
        reader.cancel().catch(() => undefined);
    }, timeouts.firstByteMs);
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

    const armIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            controller?.error(
                new ClientError("http_idle_timeout", `idle timeout after ${timeouts.idleMs}ms`),
            );
            reader.cancel().catch(() => undefined);
        }, timeouts.idleMs);
    };

    const clearAll = (): void => {
        if (firstByteTimer) clearTimeout(firstByteTimer);
        if (idleTimer) clearTimeout(idleTimer);
        firstByteTimer = null;
        idleTimer = null;
    };

    return new ReadableStream<Uint8Array>({
        start(c): void {
            controller = c;
        },
        async pull(c): Promise<void> {
            try {
                const { value, done } = await reader.read();
                if (done) {
                    clearAll();
                    c.close();
                    return;
                }
                if (!firstByteSeen) {
                    firstByteSeen = true;
                    if (firstByteTimer) clearTimeout(firstByteTimer);
                    firstByteTimer = null;
                }
                armIdle();
                c.enqueue(value);
            } catch (e) {
                clearAll();
                c.error(e);
            }
        },
        cancel(reason): Promise<void> {
            clearAll();
            return reader.cancel(reason);
        },
    });
}
