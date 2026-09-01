import { describe, it, expect } from "vitest";
import { CopilotProvider } from "../../src/provider/copilotProvider.js";
import type { CopilotClient, CopilotModel } from "../../src/client/copilotClient.js";
import type { ChatCompletionChunk } from "../../src/client/sse.js";
import type { WhitelistEntry } from "../../src/provider/whitelist.js";

interface StreamCall {
    req: { model: string; messages: unknown[]; stream?: boolean; [k: string]: unknown };
    signal?: AbortSignal | undefined;
}

function makeClient(opts: {
    models?: CopilotModel[];
    chunks?: ChatCompletionChunk[];
    onStream?: (call: StreamCall) => void;
    throwOnStream?: unknown;
}): CopilotClient {
    return {
        listModels: async () => opts.models ?? [],
        streamChatCompletions: async function* (
            req: StreamCall["req"],
            signal?: AbortSignal,
        ): AsyncGenerator<ChatCompletionChunk> {
            opts.onStream?.({ req, signal });
            if (opts.throwOnStream) throw opts.throwOnStream;
            for (const c of opts.chunks ?? []) yield c;
        },
        invalidateModels: () => undefined,
    } as unknown as CopilotClient;
}

describe("CopilotProvider.listModels", () => {
    it("returns the whitelist ∩ remote with metadata", async () => {
        const client = makeClient({
            models: [
                { id: "gpt-4o-mini" },
                { id: "exec-agent-a" }, // filtered out
                { id: "gpt-4o-2024-11-20" }, // alias → gpt-4o
            ],
        });
        const p = new CopilotProvider({ client });
        const listed = await p.listModels();
        expect(listed.map((m) => m.id).sort()).toEqual(["gpt-4o", "gpt-4o-mini"]);
        const mini = listed.find((m) => m.id === "gpt-4o-mini")!;
        expect(mini).toMatchObject({
            id: "gpt-4o-mini",
            family: "openai",
            contextWindow: 128_000,
            reasoning: false,
        });
    });

    it("falls back to remote ids when intersection is empty (default)", async () => {
        const client = makeClient({ models: [{ id: "exec-agent-a" }, { id: "trajectory-compaction" }] });
        const p = new CopilotProvider({ client });
        const listed = await p.listModels();
        expect(listed.map((m) => m.id).sort()).toEqual(["exec-agent-a", "trajectory-compaction"]);
    });

    it("returns [] on empty intersection when fallbackToRemoteOnEmpty=false", async () => {
        const client = makeClient({ models: [{ id: "exec-agent-a" }] });
        const p = new CopilotProvider({ client, fallbackToRemoteOnEmpty: false });
        expect(await p.listModels()).toEqual([]);
    });

    it("supports a custom whitelist", async () => {
        const wl: WhitelistEntry[] = [
            {
                id: "my-model",
                aliases: ["my-model", "my-model-v2"],
                family: "other",
                contextWindow: 4096,
                maxOutputTokens: 1024,
                reasoning: true,
            },
        ];
        const client = makeClient({ models: [{ id: "my-model-v2" }, { id: "gpt-4o" }] });
        const p = new CopilotProvider({ client, whitelist: wl });
        const listed = await p.listModels();
        expect(listed).toEqual([
            {
                id: "my-model",
                family: "other",
                contextWindow: 4096,
                maxOutputTokens: 1024,
                reasoning: true,
            },
        ]);
    });
});

describe("CopilotProvider.stream", () => {
    it("forwards messages structurally (no string concat) and forces stream:true is handled by the client", async () => {
        let seen: StreamCall | null = null;
        const client = makeClient({
            chunks: [
                { choices: [{ index: 0, delta: { content: "Hi" } }] },
                { choices: [{ index: 0, delta: { content: "!" }, finish_reason: "stop" }] },
            ],
            onStream: (c) => {
                seen = c;
            },
        });
        const p = new CopilotProvider({ client });
        const out: string[] = [];
        for await (const chunk of p.stream({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "S" },
                { role: "user", content: "U" },
            ],
            temperature: 0.5,
        })) {
            if (chunk.type === "text") out.push(chunk.text);
        }
        expect(out.join("")).toBe("Hi!");
        expect(seen!.req.messages).toEqual([
            { role: "system", content: "S" },
            { role: "user", content: "U" },
        ]);
        expect(seen!.req.temperature).toBe(0.5);
        // Must never send tools.
        expect(seen!.req).not.toHaveProperty("tools");
        expect(seen!.req).not.toHaveProperty("tool_choice");
    });

    it("maps delta.reasoning_content to reasoning chunks", async () => {
        const client = makeClient({
            chunks: [
                { choices: [{ index: 0, delta: { reasoning_content: "think..." } }] },
                { choices: [{ index: 0, delta: { content: "answer" } }] },
                { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
            ],
        });
        const p = new CopilotProvider({ client });
        const kinds: string[] = [];
        for await (const chunk of p.stream({ model: "gpt-4o-mini", messages: [{ role: "user", content: "" }] })) {
            kinds.push(chunk.type);
        }
        expect(kinds).toEqual(["reasoning", "text", "finish"]);
    });

    it("passes AbortSignal through to the client", async () => {
        const ac = new AbortController();
        let sawSignal: AbortSignal | undefined;
        const client = makeClient({
            chunks: [],
            onStream: (c) => {
                sawSignal = c.signal;
            },
        });
        const p = new CopilotProvider({ client });
        const gen = p.stream({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "hi" }],
            signal: ac.signal,
        });
        // Drain to trigger onStream.
        for await (const _ of gen);
        expect(sawSignal).toBe(ac.signal);
    });

    it("resolves an alias to the canonical model id when calling the client", async () => {
        let sentModel = "";
        const client = makeClient({
            chunks: [{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }],
            onStream: (c) => {
                sentModel = c.req.model;
            },
        });
        const p = new CopilotProvider({ client });
        for await (const _ of p.stream({
            model: "gpt-4o-2024-05-13",
            messages: [{ role: "user", content: "x" }],
        }));
        expect(sentModel).toBe("gpt-4o");
    });

    it("yields a final finish chunk with usage when the client reports it", async () => {
        const client = makeClient({
            chunks: [
                { choices: [{ index: 0, delta: { content: "a" } }] },
                {
                    choices: [{ index: 0, delta: {}, finish_reason: "length" }],
                    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
                },
            ],
        });
        const p = new CopilotProvider({ client });
        const chunks = [];
        for await (const c of p.stream({ model: "gpt-4o-mini", messages: [{ role: "user", content: "" }] })) {
            chunks.push(c);
        }
        const finish = chunks.at(-1);
        expect(finish).toEqual({
            type: "finish",
            reason: "length",
            usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
        });
    });

    it("propagates client errors to the caller", async () => {
        const client = makeClient({ throwOnStream: new Error("boom") });
        const p = new CopilotProvider({ client });
        const gen = p.stream({ model: "gpt-4o-mini", messages: [{ role: "user", content: "" }] });
        await expect(gen.next()).rejects.toThrow("boom");
    });
});
