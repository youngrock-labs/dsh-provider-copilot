/**
 * In-memory ring buffer of recent call latencies + outcomes.
 *
 * Phase 4 uses this to render `/copilot status` (p50 / p95 over the last N
 * calls). Phase 5 will add JSONL persistence on top; the ring buffer stays
 * in-memory because it's for a single dsh process's introspection.
 */

export interface CallRecord {
    at: number; // epoch ms
    model: string;
    latencyMs: number;
    ok: boolean;
    errorCode?: string | undefined;
    promptTokens?: number | undefined;
    completionTokens?: number | undefined;
}

export class MetricsRing {
    private readonly buf: CallRecord[] = [];
    constructor(private readonly capacity: number = 10) {}

    record(entry: CallRecord): void {
        this.buf.push(entry);
        while (this.buf.length > this.capacity) this.buf.shift();
    }

    snapshot(): readonly CallRecord[] {
        return this.buf.slice();
    }

    size(): number {
        return this.buf.length;
    }

    /** Return p50 and p95 latency of successful calls; null if no data. */
    percentiles(): { p50: number; p95: number; n: number } | null {
        const ok = this.buf.filter((r) => r.ok).map((r) => r.latencyMs);
        if (ok.length === 0) return null;
        const sorted = ok.slice().sort((a, b) => a - b);
        return {
            p50: percentile(sorted, 0.5),
            p95: percentile(sorted, 0.95),
            n: sorted.length,
        };
    }

    clear(): void {
        this.buf.length = 0;
    }
}

function percentile(sortedAsc: number[], p: number): number {
    if (sortedAsc.length === 0) return 0;
    // Nearest-rank; small N so exact interpolation isn't worth it.
    const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
    return sortedAsc[idx]!;
}
