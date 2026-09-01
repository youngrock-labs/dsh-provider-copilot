import { describe, it, expect } from "vitest";
import { MeteredProvider } from "../../src/commands/meteredProvider.js";
import { MetricsRing } from "../../src/commands/metrics.js";
import { JsonlLogger } from "../../src/observability/jsonlLogger.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { CopilotProvider } from "../../src/provider/copilotProvider.js";
import type { LlmStreamChunk, LlmStreamRequest } from "../../src/provider/dshInterface.js";

function fakeProvider(chunks: LlmStreamChunk[]): CopilotProvider {
    return {
        id: "copilot",
        listModels: async () => [],
        stream: async function* (_req: LlmStreamRequest) {
            for (const c of chunks) yield c;
        },
    } as unknown as CopilotProvider;
}

async function tmp(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), "dsh-copilot-lp-"));
}

describe("MeteredProvider + JsonlLogger integration", () => {
    it("writes stream_start then stream_end with usage on success", async () => {
        const dir = await tmp();
        const nowMs = Date.UTC(2026, 8, 1, 10);
        const logger = new JsonlLogger({ dir, now: () => nowMs });
        const ring = new MetricsRing();
        const p = new MeteredProvider(
            fakeProvider([
                { type: "text", text: "hi" },
                { type: "finish", reason: "stop", usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } },
            ]),
            ring,
            { now: () => nowMs, logger },
        );
        for await (const _ of p.stream({ model: "gpt-4o-mini", messages: [] }));

        const file = path.join(dir, "copilot-2026-09-01.jsonl");
        const lines = (await fs.readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
        expect(lines.map((l) => l.event)).toEqual(["stream_start", "stream_end"]);
        expect(lines[1].totalTokens).toBe(5);
        expect(lines[1].model).toBe("gpt-4o-mini");
        // Never leaks payload fields.
        expect(lines[1]).not.toHaveProperty("messages");
        expect(lines[1]).not.toHaveProperty("body");
    });

    it("writes stream_error with errorCode when the inner stream throws", async () => {
        const dir = await tmp();
        const nowMs = Date.UTC(2026, 8, 1, 10);
        const logger = new JsonlLogger({ dir, now: () => nowMs });
        const ring = new MetricsRing();
        const err = Object.assign(new Error("boom"), { code: "http_status" });
        const bad = {
            id: "copilot",
            listModels: async () => [],
            stream: async function* () {
                throw err;
                yield undefined as unknown as LlmStreamChunk; // unreachable
            },
        } as unknown as CopilotProvider;
        const p = new MeteredProvider(bad, ring, { now: () => nowMs, logger });
        await expect(async () => {
            for await (const _ of p.stream({ model: "m", messages: [] }));
        }).rejects.toBe(err);
        const file = path.join(dir, "copilot-2026-09-01.jsonl");
        const lines = (await fs.readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
        expect(lines.at(-1).event).toBe("stream_error");
        expect(lines.at(-1).errorCode).toBe("http_status");
    });
});
