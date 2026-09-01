import { describe, it, expect } from "vitest";
import { assertLogSafe, type LogRecord } from "../../src/observability/record.js";

describe("assertLogSafe", () => {
    it("accepts allowed fields", () => {
        const r: LogRecord = {
            ts: "2026-09-01T00:00:00Z",
            requestId: "abc",
            event: "stream_end",
            model: "gpt-4o-mini",
            latencyMs: 123,
            promptTokens: 5,
            completionTokens: 10,
            totalTokens: 15,
            errorCode: "http_status",
            source: "cache",
            sku: "individual",
        };
        expect(() => assertLogSafe(r)).not.toThrow();
    });

    it("throws when a disallowed field is present", () => {
        const bad = {
            ts: "x",
            requestId: "r",
            event: "stream_end",
            messages: [{ role: "user", content: "leak" }],
        } as unknown as LogRecord;
        expect(() => assertLogSafe(bad)).toThrow(/disallowed field/);
    });

    it("also blocks headers / body / token leakage", () => {
        for (const field of ["headers", "body", "token", "authorization"]) {
            const bad = { ts: "x", requestId: "r", event: "stream_end", [field]: "leak" } as unknown as LogRecord;
            expect(() => assertLogSafe(bad), field).toThrow();
        }
    });
});
