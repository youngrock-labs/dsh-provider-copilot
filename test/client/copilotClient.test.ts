import { describe, it, expect } from "vitest";
import { CopilotClient, type BearerRef } from "../../src/client/copilotClient.js";

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function sseResponse(chunks: string[]): Response {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(c) {
            for (const s of chunks) c.enqueue(enc.encode(s));
            c.close();
        },
    });
    return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
    });
}

const bearer: BearerRef = {
    token: "bearer-x",
    endpoints: { api: "https://api.individual.githubcopilot.com" },
};

describe("CopilotClient.listModels", () => {
    it("calls endpoints.api/models with Bearer auth and pinned UA", async () => {
        let seenUrl = "";
        let seenAuth: string | null = null;
        let seenUa: string | null = null;
        const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
            seenUrl = input.toString();
            const h = new Headers(init?.headers);
            seenAuth = h.get("authorization");
            seenUa = h.get("user-agent");
            return jsonResponse(200, { data: [{ id: "gpt-4o-mini" }] });
        }) as unknown as typeof fetch;
        const client = new CopilotClient({ getBearer: async () => bearer, fetchImpl });
        const models = await client.listModels();
        expect(seenUrl).toBe("https://api.individual.githubcopilot.com/models");
        expect(seenAuth).toBe("Bearer bearer-x");
        expect(seenUa).toMatch(/^GitHubCopilot/);
        expect(models).toEqual([{ id: "gpt-4o-mini" }]);
    });

    it("caches results within the TTL", async () => {
        let calls = 0;
        const fetchImpl = (async () => {
            calls++;
            return jsonResponse(200, { data: [{ id: "m" }] });
        }) as unknown as typeof fetch;
        const client = new CopilotClient({ getBearer: async () => bearer, fetchImpl, modelsTtlMs: 10_000 });
        await client.listModels();
        await client.listModels();
        expect(calls).toBe(1);
    });

    it("refetches after invalidateModels()", async () => {
        let calls = 0;
        const fetchImpl = (async () => {
            calls++;
            return jsonResponse(200, { data: [{ id: "m" }] });
        }) as unknown as typeof fetch;
        const client = new CopilotClient({ getBearer: async () => bearer, fetchImpl });
        await client.listModels();
        client.invalidateModels();
        await client.listModels();
        expect(calls).toBe(2);
    });

    it("throws typed http_status on non-2xx", async () => {
        const fetchImpl = (async () =>
            new Response("bad", { status: 500 })) as unknown as typeof fetch;
        const client = new CopilotClient({ getBearer: async () => bearer, fetchImpl });
        await expect(client.listModels()).rejects.toMatchObject({ code: "http_status", status: 500 });
    });
});

describe("CopilotClient.streamChatCompletions", () => {
    it("streams parsed chunks from SSE body", async () => {
        const chunks = [
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hello" } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: ", world" } }] })}\n\n`,
            "data: [DONE]\n\n",
        ];
        const fetchImpl = (async () => sseResponse(chunks)) as unknown as typeof fetch;
        const client = new CopilotClient({ getBearer: async () => bearer, fetchImpl });
        const out: string[] = [];
        for await (const c of client.streamChatCompletions({
            model: "m",
            messages: [{ role: "user", content: "hi" }],
        })) {
            out.push(c.choices[0]?.delta?.content ?? "");
        }
        expect(out.join("")).toBe("Hello, world");
    });

    it("forces stream:true on the request body", async () => {
        let bodySent: string | null = null;
        const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
            bodySent = init?.body as string;
            return sseResponse(["data: [DONE]\n\n"]);
        }) as unknown as typeof fetch;
        const client = new CopilotClient({ getBearer: async () => bearer, fetchImpl });
        for await (const _ of client.streamChatCompletions({
            model: "m",
            messages: [{ role: "user", content: "hi" }],
            stream: false,
        }));
        expect(JSON.parse(bodySent!)).toMatchObject({ stream: true, model: "m" });
    });

    it("propagates http_status on 4xx before streaming starts", async () => {
        const fetchImpl = (async () =>
            new Response("nope", { status: 401 })) as unknown as typeof fetch;
        const client = new CopilotClient({ getBearer: async () => bearer, fetchImpl });
        const gen = client.streamChatCompletions({
            model: "m",
            messages: [{ role: "user", content: "hi" }],
        });
        await expect(gen.next()).rejects.toMatchObject({ code: "http_status", status: 401 });
    });
});
