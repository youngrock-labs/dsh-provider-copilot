/**
 * Wraps a `CopilotProvider` so that every `stream()` call records a metrics
 * entry (latency, ok/err, error code, usage). Optionally emits JSONL log
 * lines via a `JsonlLogger` (Phase 5). The provider adapter itself stays
 * pure; instrumentation is opt-in via this wrapper so tests / BYOK users
 * can skip it.
 *
 * Log-write ordering: `stream_start` is dispatched at generator entry, then
 * awaited before `stream_end` / `stream_error` is written, so consumers
 * always see the two lines in event order. The logger swallows I/O errors
 * internally; neither write can propagate.
 */

import type { CopilotProvider } from "../provider/copilotProvider.js";
import type {
    LlmModelInfo,
    LlmStreamChunk,
    LlmStreamRequest,
} from "../provider/dshInterface.js";
import type { MetricsRing } from "./metrics.js";
import { newRequestId, type JsonlLogger } from "../observability/index.js";

export interface MeteredProviderOptions {
    now?: () => number;
    logger?: JsonlLogger;
}

export class MeteredProvider {
    readonly id: string;
    private readonly now: () => number;
    private readonly logger?: JsonlLogger;

    constructor(
        private readonly inner: CopilotProvider,
        private readonly metrics: MetricsRing,
        opts: MeteredProviderOptions | (() => number) = {},
    ) {
        this.id = inner.id;
        // Backwards-compat: previous signature accepted `now` as positional arg 3.
        if (typeof opts === "function") {
            this.now = opts;
        } else {
            this.now = opts.now ?? Date.now;
            if (opts.logger) this.logger = opts.logger;
        }
    }

    listModels(signal?: AbortSignal): Promise<LlmModelInfo[]> {
        return this.inner.listModels(signal);
    }

    async *stream(req: LlmStreamRequest): AsyncGenerator<LlmStreamChunk, void, void> {
        const requestId = newRequestId();
        const start = this.now();
        let ok = false;
        let errorCode: string | undefined;
        let promptTokens: number | undefined;
        let completionTokens: number | undefined;
        let totalTokens: number | undefined;

        // Start the start-event write; we await it in finally so end-event
        // lands after it deterministically.
        const startWrite = this.logger
            ? this.logger.write({ ts: "", requestId, event: "stream_start", model: req.model })
            : Promise.resolve();

        try {
            for await (const chunk of this.inner.stream(req)) {
                if (chunk.type === "finish" && chunk.usage) {
                    promptTokens = chunk.usage.promptTokens;
                    completionTokens = chunk.usage.completionTokens;
                    totalTokens = chunk.usage.totalTokens;
                }
                yield chunk;
            }
            ok = true;
        } catch (e) {
            errorCode = (e as { code?: string })?.code ?? (e as Error)?.name ?? "unknown";
            throw e;
        } finally {
            const latencyMs = this.now() - start;
            this.metrics.record({
                at: this.now(),
                model: req.model,
                latencyMs,
                ok,
                errorCode,
                promptTokens,
                completionTokens,
            });
            await startWrite;
            if (this.logger) {
                await this.logger.write({
                    ts: "",
                    requestId,
                    event: ok ? "stream_end" : "stream_error",
                    model: req.model,
                    latencyMs,
                    ...(errorCode !== undefined ? { errorCode } : {}),
                    ...(promptTokens !== undefined ? { promptTokens } : {}),
                    ...(completionTokens !== undefined ? { completionTokens } : {}),
                    ...(totalTokens !== undefined ? { totalTokens } : {}),
                });
            }
        }
    }
}
