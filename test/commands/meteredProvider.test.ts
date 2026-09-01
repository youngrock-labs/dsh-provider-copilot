import { describe, it, expect } from "vitest";
import { MeteredProvider } from "../../src/commands/meteredProvider.js";
import { MetricsRing } from "../../src/commands/metrics.js";
import type { CopilotProvider } from "../../src/provider/copilotProvider.js";
import type { LlmStreamChunk, LlmStreamRequest } from "../../src/provider/dshInterface.js";

function fakeProvider(opts: {
    chunks?: LlmStreamChunk[];
    throwAt?: number; // throw after N chunks
    error?: Error & { code?: string };
}): CopilotProvider {
    return {
        id: "copilot",
        listModels: async () => [],
        stream: async function* (_req: LlmStreamRequest) {
            let i = 0;
            for (const c of opts.chunks ?? []) {
                if (opts.throwAt !== undefined && i === opts.throwAt) throw opts.error;
                i++;
                yield c;
            }
            if (opts.throwAt === (opts.chunks?.length ?? 0) && opts.error) throw opts.error;
        },
    } as unknown as CopilotProvider;
}

describe("MeteredProvider", () => {
    it("records latency and ok=true on successful stream", async () => {
        const ring = new MetricsRing();
        let t = 1000;
        const p = new MeteredProvider(
            fakeProvider({
                chunks: [
                    { type: "text", text: "hi" },
                    {
                        type: "finish",
                        reason: "stop",
                        usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
                    },
                ],
            }),
            ring,
            () => {
                t += 25;
                return t;
            },
        );
        for await (const _ of p.stream({ model: "gpt-4o-mini", messages: [] }));
        const [rec] = ring.snapshot();
        expect(rec).toMatchObject({
            model: "gpt-4o-mini",
            ok: true,
            promptTokens: 2,
            completionTokens: 1,
        });
        expect(rec!.latencyMs).toBeGreaterThan(0);
    });

    it("records ok=false with errorCode from thrown ClientError-like objects", async () => {
        const ring = new MetricsRing();
        const err = Object.assign(new Error("boom"), { code: "http_status" });
        const p = new MeteredProvider(
            fakeProvider({ chunks: [{ type: "text", text: "a" }], throwAt: 1, error: err }),
            ring,
        );
        await expect(async () => {
            for await (const _ of p.stream({ model: "m", messages: [] }));
        }).rejects.toBe(err);
        const [rec] = ring.snapshot();
        expect(rec).toMatchObject({ model: "m", ok: false, errorCode: "http_status" });
    });

    it("delegates listModels", async () => {
        const inner = fakeProvider({});
        const p = new MeteredProvider(inner, new MetricsRing());
        expect(await p.listModels()).toEqual([]);
    });
});
