/**
 * Wraps a `CopilotProvider` so that every `stream()` call records a metrics
 * entry (latency, ok/err, error code, usage). The provider adapter itself
 * stays pure; instrumentation is opt-in via this wrapper so tests / BYOK
 * users can skip it.
 */

import type { CopilotProvider } from "../provider/copilotProvider.js";
import type {
    LlmModelInfo,
    LlmStreamChunk,
    LlmStreamRequest,
} from "../provider/dshInterface.js";
import type { MetricsRing } from "./metrics.js";

export class MeteredProvider {
    readonly id: string;
    constructor(
        private readonly inner: CopilotProvider,
        private readonly metrics: MetricsRing,
        private readonly now: () => number = Date.now,
    ) {
        this.id = inner.id;
    }

    listModels(signal?: AbortSignal): Promise<LlmModelInfo[]> {
        return this.inner.listModels(signal);
    }

    async *stream(req: LlmStreamRequest): AsyncGenerator<LlmStreamChunk, void, void> {
        const start = this.now();
        let ok = false;
        let errorCode: string | undefined;
        let promptTokens: number | undefined;
        let completionTokens: number | undefined;
        try {
            for await (const chunk of this.inner.stream(req)) {
                if (chunk.type === "finish" && chunk.usage) {
                    promptTokens = chunk.usage.promptTokens;
                    completionTokens = chunk.usage.completionTokens;
                }
                yield chunk;
            }
            ok = true;
        } catch (e) {
            errorCode = (e as { code?: string })?.code ?? (e as Error)?.name ?? "unknown";
            throw e;
        } finally {
            this.metrics.record({
                at: this.now(),
                model: req.model,
                latencyMs: this.now() - start,
                ok,
                errorCode,
                promptTokens,
                completionTokens,
            });
        }
    }
}
