import { describe, it, expect } from "vitest";
import { fetchWithTimeouts, withStreamTimeouts, resolveTimeouts } from "../../src/client/http.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
    });
}

describe("fetchWithTimeouts", () => {
    it("returns response as-is on 2xx", async () => {
        const fetchImpl = (async () => jsonResponse(200, { ok: true })) as unknown as typeof fetch;
        const res = await fetchWithTimeouts("https://x", { fetchImpl });
        expect(res.status).toBe(200);
    });

    it("retries once on 429 when retryOn429 is set (honors Retry-After seconds)", async () => {
        let calls = 0;
        const fetchImpl = (async () => {
            calls++;
            return calls === 1
                ? jsonResponse(429, { m: "slow" }, { "retry-after": "0" })
                : jsonResponse(200, { ok: true });
        }) as unknown as typeof fetch;
        const sleeps: number[] = [];
        const res = await fetchWithTimeouts("https://x", {
            fetchImpl,
            retryOn429: true,
            sleep: async (ms) => {
                sleeps.push(ms);
            },
        });
        expect(res.status).toBe(200);
        expect(calls).toBe(2);
        expect(sleeps).toEqual([0]);
    });

    it("does not retry twice on repeated 429", async () => {
        let calls = 0;
        const fetchImpl = (async () => {
            calls++;
            return jsonResponse(429, {}, { "retry-after": "0" });
        }) as unknown as typeof fetch;
        const res = await fetchWithTimeouts("https://x", {
            fetchImpl,
            retryOn429: true,
            sleep: async () => undefined,
        });
        expect(res.status).toBe(429);
        expect(calls).toBe(2);
    });

    it("maps connect timeout to http_connect_timeout", async () => {
        const fetchImpl = ((url: string, init?: RequestInit) =>
            new Promise((_, reject) => {
                init?.signal?.addEventListener("abort", () => {
                    const e = new Error("aborted") as Error & { name: string };
                    e.name = "AbortError";
                    reject(e);
                });
            })) as unknown as typeof fetch;
        await expect(
            fetchWithTimeouts("https://x", { fetchImpl, timeouts: { connectMs: 5 } }),
        ).rejects.toMatchObject({ code: "http_connect_timeout" });
    });

    it("maps caller abort to http_aborted", async () => {
        const ac = new AbortController();
        const fetchImpl = ((url: string, init?: RequestInit) =>
            new Promise((_, reject) => {
                init?.signal?.addEventListener("abort", () => {
                    const e = new Error("aborted") as Error & { name: string };
                    e.name = "AbortError";
                    reject(e);
                });
            })) as unknown as typeof fetch;
        setTimeout(() => ac.abort(), 5);
        await expect(
            fetchWithTimeouts("https://x", { fetchImpl, signal: ac.signal }),
        ).rejects.toMatchObject({ code: "http_aborted" });
    });

    it("wraps network errors as http_network", async () => {
        const fetchImpl = (async () => {
            throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch;
        await expect(fetchWithTimeouts("https://x", { fetchImpl })).rejects.toMatchObject({
            code: "http_network",
        });
    });
});

describe("withStreamTimeouts", () => {
    it("passes bytes through unchanged when timeouts are generous", async () => {
        const enc = new TextEncoder();
        const src = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(enc.encode("abc"));
                c.enqueue(enc.encode("def"));
                c.close();
            },
        });
        const wrapped = withStreamTimeouts(src, resolveTimeouts({ firstByteMs: 1000, idleMs: 1000 }));
        const reader = wrapped.getReader();
        const dec = new TextDecoder();
        let out = "";
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            out += dec.decode(value);
        }
        expect(out).toBe("abcdef");
    });

    it("errors with http_first_byte_timeout when no bytes arrive in time", async () => {
        const src = new ReadableStream<Uint8Array>({ pull() { /* never resolves */ } });
        const wrapped = withStreamTimeouts(src, resolveTimeouts({ firstByteMs: 5, idleMs: 1000 }));
        const reader = wrapped.getReader();
        await expect(reader.read()).rejects.toMatchObject({ code: "http_first_byte_timeout" });
    });

    it("errors with http_idle_timeout when a gap between bytes is too long", async () => {
        const enc = new TextEncoder();
        let sent = false;
        const src = new ReadableStream<Uint8Array>({
            pull(c) {
                if (!sent) {
                    sent = true;
                    c.enqueue(enc.encode("x"));
                }
                // second pull never resolves
            },
        });
        const wrapped = withStreamTimeouts(src, resolveTimeouts({ firstByteMs: 1000, idleMs: 10 }));
        const reader = wrapped.getReader();
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toBe("x");
        await expect(reader.read()).rejects.toMatchObject({ code: "http_idle_timeout" });
    });
});
