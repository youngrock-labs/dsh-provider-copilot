/**
 * dsh LlmProvider interface (subset we implement).
 *
 * Kept as local type declarations to avoid a runtime dependency on dsh from
 * this package: dsh loads the provider at runtime and only cares about shape.
 * If dsh evolves its interface we bump the version here and re-map.
 *
 * A "chunk" is the smallest streamed unit dsh renders. We yield either
 * `{ type: "text", text }` or `{ type: "reasoning", text }`; other kinds
 * (tool calls, images) are explicitly out of scope for MVP.
 */

export interface LlmModelInfo {
    id: string;
    label?: string;
    family?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    reasoning?: boolean;
    vision?: boolean;
}

export interface LlmMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    name?: string;
}

export interface LlmStreamRequest {
    model: string;
    messages: LlmMessage[];
    temperature?: number;
    top_p?: number;
    maxTokens?: number;
    signal?: AbortSignal;
}

export type LlmStreamChunk =
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string }
    | { type: "finish"; reason?: string | undefined; usage?: LlmUsage | undefined };

export interface LlmUsage {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
}

export interface LlmProvider {
    readonly id: string;
    listModels(signal?: AbortSignal): Promise<LlmModelInfo[]>;
    stream(req: LlmStreamRequest): AsyncGenerator<LlmStreamChunk, void, void>;
}
