import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { JsonlLogger, utcDayKey } from "../../src/observability/jsonlLogger.js";

async function tmp(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), "dsh-copilot-log-"));
}

describe("utcDayKey", () => {
    it("formats UTC YYYY-MM-DD", () => {
        expect(utcDayKey(Date.UTC(2026, 8, 1, 12))).toBe("2026-09-01");
        expect(utcDayKey(Date.UTC(2026, 0, 5))).toBe("2026-01-05");
    });
});

describe("JsonlLogger", () => {
    let dir: string;
    beforeEach(async () => {
        dir = await tmp();
    });

    it("appends one JSONL line per write with mode 0600 and dir 0700", async () => {
        const now = () => Date.UTC(2026, 8, 1, 12);
        const logger = new JsonlLogger({ dir, now });
        await logger.write({ ts: "", requestId: "r1", event: "stream_end", model: "m", latencyMs: 5 });
        await logger.write({ ts: "", requestId: "r2", event: "stream_end", model: "m", latencyMs: 6 });

        const file = path.join(dir, "copilot-2026-09-01.jsonl");
        const raw = await fs.readFile(file, "utf8");
        const lines = raw.trim().split("\n");
        expect(lines).toHaveLength(2);
        const j1 = JSON.parse(lines[0]!);
        expect(j1.requestId).toBe("r1");
        expect(j1.ts).toBe("2026-09-01T12:00:00.000Z");

        const st = await fs.stat(file);
        expect(st.mode & 0o777).toBe(0o600);
        const dirSt = await fs.stat(dir);
        expect(dirSt.mode & 0o777).toBe(0o700);
    });

    it("swallows I/O errors and exposes lastError", async () => {
        // Point at a path that cannot be created (child of a file).
        const badParent = path.join(dir, "not-a-dir");
        await fs.writeFile(badParent, "x");
        const badDir = path.join(badParent, "deeper");
        const logger = new JsonlLogger({ dir: badDir });
        await logger.write({ ts: "", requestId: "r", event: "stream_end" });
        expect(logger.lastError).not.toBeNull();
    });

    it("rejects records with disallowed fields (via assertLogSafe)", async () => {
        const logger = new JsonlLogger({ dir });
        await logger.write({
            ts: "",
            requestId: "r",
            event: "stream_end",
            // @ts-expect-error deliberate leak
            body: "hi",
        });
        // No file should be written.
        expect(await logger.files()).toEqual([]);
        expect(logger.lastError?.message).toMatch(/disallowed field/);
    });

    it("prunes files older than retentionDays on rotation", async () => {
        // Seed two old files and one current one.
        await fs.mkdir(dir, { recursive: true });
        const oldName = "copilot-2000-01-01.jsonl";
        const midName = "copilot-2020-01-01.jsonl";
        await fs.writeFile(path.join(dir, oldName), "x\n", { mode: 0o600 });
        await fs.writeFile(path.join(dir, midName), "x\n", { mode: 0o600 });

        const nowMs = Date.UTC(2026, 8, 2);
        const logger = new JsonlLogger({ dir, retentionDays: 7, now: () => nowMs });
        await logger.write({ ts: "", requestId: "r", event: "stream_end" });
        // give the fire-and-forget prune a tick to complete
        await new Promise((r) => setTimeout(r, 20));

        const names = await logger.files();
        expect(names).toContain("copilot-2026-09-02.jsonl");
        expect(names).not.toContain(oldName);
        expect(names).not.toContain(midName);
    });

    it("does nothing when disabled=true", async () => {
        const logger = new JsonlLogger({ dir, disabled: true });
        await logger.write({ ts: "", requestId: "r", event: "stream_end" });
        expect(await logger.files()).toEqual([]);
    });
});
