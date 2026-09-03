/**
 * `CopilotAdapter` — the dsh-facing adapter for the Copilot subscription.
 *
 * Structurally implements the dsh `LlmAdapter` surface
 * (`packages/llm/llm/src/index.ts` in the dsh repository) without importing
 * it: dsh registers by shape and only ever calls the methods implemented
 * here. When this package is built inside the dsh monorepo (or with
 * `@deepseek-ai/dsh-llm` as a resolvable peer), switching to
 * `class CopilotAdapter extends LlmAdapter` is a one-line change.
 *
 * Design rules (ported from the provider layer):
 *  - Plain chat only: `tools` from `GenerateOptions` are never forwarded.
 *  - Model advertising is a curated whitelist; the upstream `/models` list is
 *    intersected only when a usable session exists, so selectors stay usable
 *    before login.
 *  - Every request honors `options.signal` and goes through `CopilotClient`
 *    (layered timeouts, single 429 retry, dynamic `endpoints.api`).
 *  - Observability hooks fire around each stream call; failures are thrown
 *    as {@link LlmError} with stable codes dsh can route on.
 */

import type { AuthStatus } from "../auth/index.js";
import type { ChatCompletionChunk, ChatCompletionsRequest } from "../client/index.js";
import { newRequestId } from "../observability/index.js";
import { DEFAULT_WHITELIST, intersectWithRemote, resolveEntry } from "../provider/whitelist.js";
import type { WhitelistEntry } from "../provider/whitelist.js";
import { toLlmError } from "./errors.js";
import type {
    GenerateOptions,
    LlmModelInfo,
    LlmProviderInfo,
    LlmResolvedModelInfo,
    PreparedAdapterCall,
    StreamChunk,
} from "./protocol.js";
import { translate } from "./translate.js";

/** The minimal `CopilotClient` surface the adapter needs (tests inject fakes). */
export interface CopilotClientLike {
    listModels(signal?: AbortSignal): Promise<readonly { id: string }[]>;
    streamChatCompletions(
        req: ChatCompletionsRequest,
        signal?: AbortSignal,
    ): AsyncGenerator<ChatCompletionChunk, void, void>;
    invalidateModels(): void;
}

/** Token usage summarized for observability (never a wire body). */
export interface UsageSummary {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
}

/** Per-call observability hooks; both are awaited so log lines stay ordered. */
export interface CopilotCallObserver {
    /** Fired once before the upstream request is dispatched. */
    onStart?(info: { model: string; requestId: string }): void | Promise<void>;
    /** Fired exactly once when the call settles (success or failure). */
    onEnd?(info: {
        model: string;
        requestId: string;
        latencyMs: number;
        ok: boolean;
        errorCode?: string;
        usage?: UsageSummary;
    }): void | Promise<void>;
}

export interface CopilotAdapterOptions {
    /** The client that talks to the Copilot endpoints. */
    client: CopilotClientLike;
    /** Peek at the current auth state WITHOUT forcing a network refresh. */
    peekSession: () => Promise<AuthStatus>;
    /** Curated model whitelist; defaults to `DEFAULT_WHITELIST`. */
    whitelist?: readonly WhitelistEntry[];
    /** Context window fallback for model ids absent from the whitelist. */
    defaultContextWindow?: number;
    /** Output-cap fallback for model ids absent from the whitelist. */
    defaultMaxTokens?: number;
    /** Optional per-call observability hooks (metrics ring / JSONL logger). */
    observer?: CopilotCallObserver;
    /** Injectable clock for tests. */
    now?: () => number;
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

/** One whitelist entry rendered as an advertised model. */
function toModelInfo(provider: string, entry: WhitelistEntry): LlmModelInfo {
    return {
        provider,
        id: entry.id,
        name: entry.label ?? entry.id,
        description: entry.reasoning
            ? `${entry.family} · reasoning · ${entry.contextWindow} context`
            : `${entry.family} · ${entry.contextWindow} context`,
        inputModalities: ["text"],
    };
}

export class CopilotAdapter {
    private readonly client: CopilotClientLike;
    private readonly peekSession: () => Promise<AuthStatus>;
    private readonly whitelist: readonly WhitelistEntry[];
    private readonly defaultContextWindow: number;
    private readonly defaultMaxTokens: number;
    private readonly observer?: CopilotCallObserver;
    private readonly now: () => number;

    constructor(options: CopilotAdapterOptions) {
        this.client = options.client;
        this.peekSession = options.peekSession;
        this.whitelist = options.whitelist ?? DEFAULT_WHITELIST;
        this.defaultContextWindow = options.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW;
        this.defaultMaxTokens = options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
        if (options.observer !== undefined) this.observer = options.observer;
        this.now = options.now ?? Date.now;
    }

    /** Describe one provider route this adapter serves (dsh `providerInfo`). */
    providerInfo(provider: string): LlmProviderInfo {
        return { id: provider, name: "Copilot (GitHub)" };
    }

    /**
     * Advertise models for one owned provider route. The whitelist is always
     * advertised (selectors stay usable before login); when a session exists,
     * entries are intersected with the upstream `/models` list so stale or
     * revoked models disappear. Failures fall back to the whitelist — the
     * catalog is advisory and never a request gate.
     */
    async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
        const session = await this.peekSession().catch(() => null);
        if (session?.hasSession === true && session.expiresAt !== null
            && session.expiresAt * 1000 > this.now()) {
            const remote = await this.client.listModels().catch(() => null);
            const served = remote === null || remote.length === 0
                ? this.whitelist
                : intersectWithRemote(remote.map((m) => m.id), this.whitelist);
            return served.map((entry) => toModelInfo(provider, entry));
        }
        return this.whitelist.map((entry) => toModelInfo(provider, entry));
    }

    /**
     * Resolve exact metadata for one model route (dsh `resolveModel`). The
     * requested id is preserved — the harness model name IS the wire model
     * name. Uncatalogued ids degrade to text-only with configured defaults
     * rather than being rejected, matching the provider layer's posture.
     */
    async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        const entry = resolveEntry(model, this.whitelist);
        const base: LlmModelInfo = entry === null
            ? { provider, id: model, name: model, inputModalities: ["text"] }
            : toModelInfo(provider, entry);
        return {
            ...base,
            context: { contextWindow: entry?.contextWindow ?? this.defaultContextWindow },
            defaultMaxTokens: entry?.maxOutputTokens ?? this.defaultMaxTokens,
        };
    }

    /** Bind exact model metadata to one generation (dsh `prepareCall`). */
    async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
        const resolved = await this.resolveModel(provider, model);
        return {
            model: resolved,
            stream: (options) => this.stream(options),
        };
    }

    /** Stream one chat completion as dsh `StreamChunk`s. */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        return this.streamWithRequest(options);
    }

    private async *streamWithRequest(options: GenerateOptions): AsyncGenerator<StreamChunk> {
        const requestId = newRequestId();
        const start = this.now();
        let ok = false;
        let errorCode: string | undefined;
        let usage: UsageSummary | undefined;

        if (this.observer?.onStart !== undefined) {
            await this.observer.onStart({ model: options.model, requestId });
        }

        try {
            const entry = resolveEntry(options.model, this.whitelist);
            const upstreamModel = entry === null ? options.model : entry.id;
            const request = buildChatRequest(options, upstreamModel);
            for await (const chunk of translate(this.client.streamChatCompletions(request, options.signal))) {
                if (chunk.type === "usage") {
                    usage = {
                        ...(chunk.usage.inputTokens !== undefined
                            ? { promptTokens: chunk.usage.inputTokens }
                            : {}),
                        ...(chunk.usage.outputTokens !== undefined
                            ? { completionTokens: chunk.usage.outputTokens }
                            : {}),
                        ...(chunk.usage.totalTokens !== undefined
                            ? { totalTokens: chunk.usage.totalTokens }
                            : {}),
                    };
                }
                yield chunk;
            }
            ok = true;
        } catch (error: unknown) {
            // Map BEFORE observing so the reported code is the stable one.
            const mapped = toLlmError(error);
            errorCode = mapped.failure.code;
            throw mapped;
        } finally {
            const latencyMs = this.now() - start;
            if (this.observer?.onEnd !== undefined) {
                await this.observer.onEnd({
                    model: options.model,
                    requestId,
                    latencyMs,
                    ok,
                    ...(errorCode === undefined ? {} : { errorCode }),
                    ...(usage === undefined ? {} : { usage }),
                });
            }
        }
    }
}

/** One content block on the wire, tolerating blocks our local types do not model. */
interface WireBlock {
    type: string;
    text?: string;
    content?: readonly WireBlock[];
}

/** Flatten harness content blocks to one plain-text string for the wire. */
function flattenBlocks(blocks: readonly unknown[] | undefined): string {
    if (blocks === undefined) return "";
    const out: string[] = [];
    for (const raw of blocks) {
        const block = raw as WireBlock;
        if ((block.type === "text" || block.type === "reasoning") && typeof block.text === "string") {
            out.push(block.text);
        } else if (block.type === "tool-result" && Array.isArray(block.content)) {
            // Tool results may appear only when a session previously ran with
            // a tool-capable provider; keep their visible text for context.
            out.push(flattenBlocks(block.content));
        }
        // image / tool-call / unknown blocks have no plain-text rendering.
    }
    return out.join("\n");
}

/** Flatten one harness message to its wire `{ role, content }` pair. */
function flattenMessage(message: GenerateOptions["messages"][number]): string {
    return flattenBlocks(message.content);
}

/**
 * Assemble the OpenAI-compatible request body for one harness request.
 * Never forwards `tools` (plain chat only). Empty frames (assistant turns
 * whose only content is tool calls) are dropped because the Copilot chat
 * endpoint cannot make sense of them.
 */
export function buildChatRequest(options: GenerateOptions, upstreamModel: string): ChatCompletionsRequest {
    const messages: ChatCompletionsRequest["messages"] = [];
    if (options.system !== undefined && options.system.trim() !== "") {
        messages.push({ role: "system", content: options.system });
    }
    for (const message of options.messages) {
        const content = flattenMessage(message);
        if (content.trim() === "") continue;
        messages.push({ role: message.role, content });
    }
    const request: ChatCompletionsRequest = {
        model: upstreamModel,
        messages,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.top_p !== undefined ? { top_p: options.top_p } : {}),
        ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
        ...(options.stop !== undefined && options.stop.length > 0 ? { stop: [...options.stop] } : {}),
    };
    return request;
}
