/**
 * Local mirror of the dsh LLM wire contract consumed by this plugin.
 *
 * dsh (deepseek-harness) drives every provider through an `LlmAdapter`
 * registered on `ctx.llm` (see `packages/llm/llm/src/types.ts` and
 * `index.ts` in the dsh repository). Keeping a local, dependency-free copy
 * of the shapes we implement lets this package typecheck and test without a
 * runtime dependency on `@deepseek-ai/dsh-llm`; the plugin binds to dsh by
 * shape at runtime, exactly like the legacy entry binds to `ctx` by shape.
 *
 * If dsh evolves these contracts, bump this file and re-map in the adapter.
 */

/** Merge-extensible provider model modality vocabulary (dsh `ModelModalityMap`). */
export type ModelModality = "text" | "image";

/** Display metadata for one registered provider route (dsh `LlmProviderInfo`). */
export interface LlmProviderInfo {
    /** Provider route key used by `GenerateOptions.provider`. */
    id: string;
    /** Human-readable provider name for selectors and diagnostics. */
    name: string;
}

/** One model an adapter advertises for one owned provider route (dsh `LlmModelInfo`). */
export interface LlmModelInfo {
    /** Provider route that owns this model entry. */
    provider: string;
    /** Model id passed to `GenerateOptions.model`. */
    id: string;
    /** Human-readable model name for selectors. */
    name: string;
    /** Optional user-facing distinction from otherwise similar models. */
    description?: string;
    /** Accepted request modalities; absent means unknown, an explicit omission is negative capability. */
    inputModalities?: readonly ModelModality[];
}

/** Provider-owned context capacity for one exact provider/model route (dsh `LlmModelContext`). */
export interface LlmModelContext {
    /** Maximum combined request and response context in tokens. */
    contextWindow: number;
}

/** Exact-route model metadata resolved by its owning adapter (dsh `LlmResolvedModelInfo`). */
export interface LlmResolvedModelInfo extends LlmModelInfo {
    /** Provider-owned context capacity when known. */
    context?: LlmModelContext;
    /** Adapter-configured per-request output cap materialized when callers omit one. */
    defaultMaxTokens?: number;
}

/** Serializable provider or transport failure facts (dsh `LlmFailure`). */
export interface LlmFailure {
    /** Human-readable provider or transport failure. */
    readonly message: string;
    /** Stable provider-neutral machine-routing code. */
    readonly code: string;
    /** HTTP status returned by the provider, when available. */
    readonly status?: number;
    /** Provider-requested delay in milliseconds, when valid and available. */
    readonly providerRetryAfterMs?: number;
    /** Opaque provider-issued request identifier for diagnostics. */
    readonly requestId?: string;
}

/** Plain text visible to the end user. */
export interface TextBlock {
    type: "text";
    text: string;
}

/** Reasoning / thinking content, distinct from visible text. */
export interface ReasoningBlock {
    type: "reasoning";
    text: string;
}

/** Content blocks a text-only adapter produces or consumes. */
export type ContentBlock = TextBlock | ReasoningBlock;

/** Why a model response stopped (dsh `FinishReason`, core kinds only). */
export type FinishReason =
    | { kind: "stop" }
    | { kind: "tool-calls" }
    | { kind: "max-tokens" }
    | { kind: "aborted"; failure: LlmFailure }
    | { kind: "error"; failure: LlmFailure };

/**
 * Token accounting for one model call. Counts are DISJOINT: `inputTokens` is
 * uncached input only; cache hits travel in `cacheReadTokens` (dsh
 * `TokenUsage`).
 */
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    /** Exact full-call total when the provider disclosed a consistent one. */
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
}

/** The raw streaming protocol adapters emit (dsh `StreamChunk`). */
export type StreamChunk =
    | { type: "block-start"; index: number; blockType: "text" | "reasoning" }
    | { type: "text-delta"; index: number; text: string }
    | { type: "reasoning-delta"; index: number; text: string }
    | { type: "block-end"; index: number; block: ContentBlock }
    | { type: "usage"; usage: TokenUsage }
    | { type: "finish"; reason: FinishReason };

/** JSON-schema description of a tool, as sent to the model (dsh `ToolSchema`). */
export interface ToolSchema {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

/** One conversation message as the harness hands it to adapters (dsh `Message`, subset). */
export interface Message {
    role: "system" | "user" | "assistant";
    content: ContentBlock[];
}

/** A single model request, fully assembled (dsh `GenerateOptions`, subset). */
export interface GenerateOptions {
    /** Registered provider route selecting the adapter instance. */
    provider: string;
    model: string;
    /** Ordered conversation messages, exactly as the provider sees them. */
    messages: Message[];
    /** System prompt text (adapters map to the provider's system slot). */
    system?: string;
    /** Tool schemas; this adapter never forwards them (plain chat only). */
    tools?: readonly ToolSchema[];
    temperature?: number;
    top_p?: number;
    maxTokens?: number;
    /** Stop sequences: generation halts as soon as the model produces any one. */
    stop?: readonly string[];
    signal?: AbortSignal;
}

/** One adapter-owned model-resolution generation bound to its eventual stream call. */
export interface PreparedAdapterCall {
    /** Exact model metadata for the same provider/model route. */
    readonly model: LlmResolvedModelInfo;
    /** Dispatch through that generation. */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
