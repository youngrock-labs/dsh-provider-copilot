import { describe, it, expect } from "vitest";
import type { ChatCompletionChunk } from "../../src/client/sse.js";
import { ERROR_CODES } from "../../src/plugin/errors.js";
import { mapFinishReason, mapUsage, translate } from "../../src/plugin/translate.js";

function chunk(patch: Partial<ChatCompletionChunk> & { choices: ChatCompletionChunk["choices"] }): ChatCompletionChunk {
    return { id: "chatcmpl-test", object: "chat.completion.chunk", ...patch };
}

function choice(patch: Partial<ChatCompletionChunk["choices"][number]> = {}): ChatCompletionChunk["choices"][number] {
    return { index: 0, delta: {}, ...patch };
}

async function collect(chunks: ChatCompletionChunk[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const item of translate(chunks)) out.push(item);
    return out;
}

describe("translate", () => {
    it("maps content deltas to one text block and defers block-end/usage/finish", async () => {
        const out = await collect([
            chunk({ choices: [choice({ delta: { content: "Hel" } })] }),
            chunk({ choices: [choice({ delta: { content: "lo" } })] }),
            chunk({ choices: [choice({ delta: {}, finish_reason: "stop" })] }),
            chunk({
                choices: [],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }),
        ]);
        expect(out).toEqual([
            { type: "block-start", index: 0, blockType: "text" },
            { type: "text-delta", index: 0, text: "Hel" },
            { type: "text-delta", index: 0, text: "lo" },
            { type: "block-end", index: 0, block: { type: "text", text: "Hello" } },
            { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
            { type: "finish", reason: { kind: "stop" } },
        ]);
    });

    it("streams reasoning deltas into a distinct reasoning block before text", async () => {
        const out = await collect([
            chunk({ choices: [choice({ delta: { reasoning_content: "think " } })] }),
            chunk({ choices: [choice({ delta: { reasoning_content: "more", content: "Answer" } })] }),
            chunk({ choices: [choice({ delta: {}, finish_reason: "stop" })] }),
        ]);
        expect(out).toEqual([
            { type: "block-start", index: 0, blockType: "reasoning" },
            { type: "reasoning-delta", index: 0, text: "think " },
            { type: "reasoning-delta", index: 0, text: "more" },
            { type: "block-start", index: 1, blockType: "text" },
            { type: "text-delta", index: 1, text: "Answer" },
            { type: "block-end", index: 0, block: { type: "reasoning", text: "think more" } },
            { type: "block-end", index: 1, block: { type: "text", text: "Answer" } },
            { type: "finish", reason: { kind: "stop" } },
        ]);
    });

    it("does not open a block for empty-string deltas", async () => {
        const out = await collect([
            chunk({ choices: [choice({ delta: { content: "", reasoning_content: "" } })] }),
            chunk({ choices: [choice({ delta: {}, finish_reason: "stop" })] }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]).toEqual({
            type: "finish",
            reason: {
                kind: "error",
                failure: { message: expect.any(String), code: ERROR_CODES.EMPTY_RESPONSE },
            },
        });
    });

    it("maps length → max-tokens and unknown finish reasons → error finish", async () => {
        const lengthOut = await collect([
            chunk({ choices: [choice({ delta: { content: "x" }, finish_reason: "length" })] }),
        ]);
        expect(lengthOut.at(-1)).toEqual({ type: "finish", reason: { kind: "max-tokens" } });
        const filterOut = await collect([
            chunk({ choices: [choice({ delta: { content: "x" }, finish_reason: "content_filter" })] }),
        ]);
        expect(filterOut.at(-1)).toEqual({
            type: "finish",
            reason: { kind: "error", failure: { message: expect.any(String), code: "CONTENT_FILTER" } },
        });
    });

    it("finishes with stop when the chunk source ends without a finish_reason", async () => {
        const out = await collect([chunk({ choices: [choice({ delta: { content: "hi" } })] })]);
        expect(out.at(-1)).toEqual({ type: "finish", reason: { kind: "stop" } });
    });

    it("keeps the latest usage when usage arrives in multiple chunks", async () => {
        const out = await collect([
            chunk({ choices: [choice({ delta: { content: "a" } })] }),
            chunk({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
            chunk({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }),
            chunk({ choices: [choice({ delta: {}, finish_reason: "stop" })] }),
        ]);
        const usage = out.find((item) => (item as { type: string }).type === "usage");
        expect(usage).toEqual({ type: "usage", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } });
    });
});

describe("mapFinishReason", () => {
    it("maps the OpenAI vocabulary", () => {
        expect(mapFinishReason("stop")).toEqual({ kind: "stop" });
        expect(mapFinishReason("tool_calls")).toEqual({ kind: "tool-calls" });
        expect(mapFinishReason("length")).toEqual({ kind: "max-tokens" });
    });
});

describe("mapUsage", () => {
    it("keeps disjoint counts and an exact total", () => {
        expect(mapUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })).toEqual({
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
        });
    });

    it("subtracts cached tokens out of inputTokens and keeps the exact aggregate total", () => {
        const usage = mapUsage({
            prompt_tokens: 12,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 7 },
        });
        expect(usage.inputTokens).toBe(5);
        expect(usage.cacheReadTokens).toBe(7);
        expect(usage.totalTokens).toBe(17);
    });

    it("carries reasoning tokens when disclosed", () => {
        const usage = mapUsage({
            prompt_tokens: 4,
            completion_tokens: 9,
            completion_tokens_details: { reasoning_tokens: 6 },
        });
        expect(usage.reasoningTokens).toBe(6);
    });

    it("drops the total when counters disagree with the wire total", () => {
        const usage = mapUsage({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 99 });
        expect(usage.totalTokens).toBeUndefined();
        expect(usage.inputTokens).toBe(1);
    });
});
