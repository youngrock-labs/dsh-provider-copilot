/**
 * Route-driven in-memory fetch mock. Callers register handlers per (method, url)
 * and get a `fetch`-shaped function back. Handlers receive parsed init and
 * return either a Response, a body+status object, or throw.
 *
 * Keeps E2E tests independent of real network / Copilot service. Not a general
 * purpose mock — scoped to the endpoints this plugin actually calls.
 */

export type MockHandler = (
    url: string,
    init: RequestInit,
) => Promise<Response> | Response;

export interface RouteKey {
    method: string;
    url: string; // exact match; use `matches` for prefix/regex
}

export class MockFetch {
    private readonly routes = new Map<string, MockHandler>();
    private readonly calls: { method: string; url: string; body?: string }[] = [];

    on(method: string, url: string, handler: MockHandler): this {
        this.routes.set(`${method.toUpperCase()} ${url}`, handler);
        return this;
    }

    get callLog(): readonly { method: string; url: string; body?: string }[] {
        return this.calls;
    }

    get fetch(): typeof fetch {
        return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
            const url = typeof input === "string" ? input : input.toString();
            const method = (init.method ?? "GET").toUpperCase();
            const body = typeof init.body === "string" ? init.body : undefined;
            const entry: { method: string; url: string; body?: string } = { method, url };
            if (body !== undefined) entry.body = body;
            this.calls.push(entry);
            const handler = this.routes.get(`${method} ${url}`);
            if (!handler) throw new Error(`unmocked ${method} ${url}`);
            return handler(url, init);
        }) as unknown as typeof fetch;
    }
}

/** Wrap a plain string body as an SSE `Response` (chunked one line at a time). */
export function sseResponse(body: string, chunkSize = 32): Response {
    const enc = new TextEncoder();
    const bytes = enc.encode(body);
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
        pull(c) {
            if (i >= bytes.length) {
                c.close();
                return;
            }
            const end = Math.min(bytes.length, i + chunkSize);
            c.enqueue(bytes.slice(i, end));
            i = end;
        },
    });
    return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
    });
}

export function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}
