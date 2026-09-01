import { describe, it, expect } from "vitest";
import { parseSseChunks, type ChatCompletionChunk } from "../../src/client/sse.js";

function streamFromChunks(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream({
        pull(c) {
            if (i >= chunks.length) {
                c.close();
                return;
            }
            const item = chunks[i++]!;
            c.enqueue(typeof item === "string" ? enc.encode(item) : item);
        },
    });
}

async function collect(gen: AsyncGenerator<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
    const out: ChatCompletionChunk[] = [];
    for await (const c of gen) out.push(c);
    return out;
}

const frame = (delta: string): string =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: delta } }] })}\n\n`;

describe("parseSseChunks", () => {
    it("parses a simple stream terminated by [DONE]", async () => {
        const stream = streamFromChunks([frame("Hello, "), frame("world!"), "data: [DONE]\n\n"]);
        const out = await collect(parseSseChunks(stream));
        expect(out.map((c) => c.choices[0]?.delta?.content).join("")).toBe("Hello, world!");
    });

    it("handles CRLF line endings", async () => {
        const stream = streamFromChunks([frame("a").replace(/\n/g, "\r\n"), "data: [DONE]\r\n\r\n"]);
        const out = await collect(parseSseChunks(stream));
        expect(out[0]?.choices[0]?.delta?.content).toBe("a");
    });

    it("reassembles a data: line split across chunks", async () => {
        const full = frame("split-content-token");
        const split = [full.slice(0, 20), full.slice(20), "data: [DONE]\n\n"];
        const out = await collect(parseSseChunks(streamFromChunks(split)));
        expect(out[0]?.choices[0]?.delta?.content).toBe("split-content-token");
    });

    it("skips comment/keep-alive lines starting with :", async () => {
        const stream = streamFromChunks([": keep-alive\n\n", frame("x"), "data: [DONE]\n\n"]);
        const out = await collect(parseSseChunks(stream));
        expect(out).toHaveLength(1);
        expect(out[0]?.choices[0]?.delta?.content).toBe("x");
    });

    it("skips non-JSON data: lines without crashing", async () => {
        const stream = streamFromChunks(["data: not-json\n\n", frame("ok"), "data: [DONE]\n\n"]);
        const out = await collect(parseSseChunks(stream));
        expect(out).toHaveLength(1);
        expect(out[0]?.choices[0]?.delta?.content).toBe("ok");
    });

    it("handles UTF-8 code points split across chunks", async () => {
        // "🚀" is 4 UTF-8 bytes: F0 9F 9A 80. Split between bytes 2 and 3.
        const jsonBefore = 'data: {"choices":[{"index":0,"delta":{"content":"';
        const jsonAfter = '"}}]}\n\n';
        const rocketBytes = new Uint8Array([0xf0, 0x9f, 0x9a, 0x80]);
        const enc = new TextEncoder();
        const stream = streamFromChunks([
            new Uint8Array([...enc.encode(jsonBefore), rocketBytes[0]!, rocketBytes[1]!]),
            new Uint8Array([rocketBytes[2]!, rocketBytes[3]!, ...enc.encode(jsonAfter)]),
            "data: [DONE]\n\n",
        ]);
        const out = await collect(parseSseChunks(stream));
        expect(out[0]?.choices[0]?.delta?.content).toBe("🚀");
    });

    it("terminates cleanly when stream ends without [DONE]", async () => {
        const stream = streamFromChunks([frame("a"), frame("b")]);
        const out = await collect(parseSseChunks(stream));
        expect(out.map((c) => c.choices[0]?.delta?.content).join("")).toBe("ab");
    });

    it("handles empty stream", async () => {
        const stream = streamFromChunks([]);
        const out = await collect(parseSseChunks(stream));
        expect(out).toEqual([]);
    });
});
