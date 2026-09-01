import { describe, it, expect } from "vitest";
import { MetricsRing } from "../../src/commands/metrics.js";

describe("MetricsRing", () => {
    it("stores up to capacity, oldest evicted first", () => {
        const r = new MetricsRing(3);
        for (let i = 0; i < 5; i++) {
            r.record({ at: i, model: "m", latencyMs: i, ok: true });
        }
        const snap = r.snapshot();
        expect(snap.map((s) => s.at)).toEqual([2, 3, 4]);
        expect(r.size()).toBe(3);
    });

    it("computes p50 / p95 over successful calls only", () => {
        const r = new MetricsRing(10);
        // successes: 10, 20, 30, 40, 50
        for (const lat of [10, 20, 30, 40, 50]) r.record({ at: 0, model: "m", latencyMs: lat, ok: true });
        r.record({ at: 0, model: "m", latencyMs: 9999, ok: false, errorCode: "http_status" });
        const p = r.percentiles();
        expect(p).not.toBeNull();
        expect(p!.n).toBe(5);
        expect(p!.p50).toBe(30);
        expect(p!.p95).toBe(50);
    });

    it("returns null when no successful data", () => {
        const r = new MetricsRing();
        expect(r.percentiles()).toBeNull();
        r.record({ at: 0, model: "m", latencyMs: 5, ok: false });
        expect(r.percentiles()).toBeNull();
    });

    it("clear() empties the buffer", () => {
        const r = new MetricsRing();
        r.record({ at: 0, model: "m", latencyMs: 1, ok: true });
        r.clear();
        expect(r.size()).toBe(0);
        expect(r.percentiles()).toBeNull();
    });
});
