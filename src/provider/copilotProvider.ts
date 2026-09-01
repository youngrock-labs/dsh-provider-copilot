/**
 * CopilotProvider — implements the dsh `LlmProvider` interface on top of
 * `CopilotClient` (Phase 2) and, indirectly, `AuthManager` (Phase 1).
 *
 * PLAN.md Phase 3 hard rules:
 *   - Forward `messages` STRUCTURALLY. Never concatenate them into a single
 *     string; the upstream endpoint expects the array shape.
 *   - Never send `tools` / `tool_choice`; tool calling is out of scope.
 *   - Map `delta.content` → `text` chunk; `delta.reasoning_content` → `reasoning`.
 *   - Wire the caller's `AbortSignal` straight through to the client.
 *   - `listModels()` = remote `/models` ∩ local whitelist. If the intersection
 *     is empty (e.g. brand-new account with only experimental models), fall
 *     back to remote ids so dsh isn't hard-locked.
 */

import type { CopilotClient } from "../client/copilotClient.js";
import { DEFAULT_WHITELIST, intersectWithRemote, resolveEntry, type WhitelistEntry } from "./whitelist.js";
import type {
    LlmModelInfo,
    LlmProvider,
    LlmStreamChunk,
    LlmStreamRequest,
    LlmUsage,
} from "./dshInterface.js";

export interface CopilotProviderOptions {
    id?: string;
    client: CopilotClient;
    whitelist?: readonly WhitelistEntry[];
    /**
     * If true (default), an empty intersection falls back to exposing remote
     * ids as bare `{ id }` entries. Set false to hard-fail dsh listing so the
     * user is forced to update the whitelist.
     */
    fallbackToRemoteOnEmpty?: boolean;
}

export class CopilotProvider implements LlmProvider {
    readonly id: string;
    private readonly client: CopilotClient;
    private readonly whitelist: readonly WhitelistEntry[];
    private readonly fallback: boolean;

    constructor(opts: CopilotProviderOptions) {
        this.id = opts.id ?? "copilot";
        this.client = opts.client;
        this.whitelist = opts.whitelist ?? DEFAULT_WHITELIST;
        this.fallback = opts.fallbackToRemoteOnEmpty ?? true;
    }

    async listModels(signal?: AbortSignal): Promise<LlmModelInfo[]> {
        const remote = await this.client.listModels(signal);
        const ids = remote.map((m) => m.id);
        const intersected = intersectWithRemote(ids, this.whitelist);
        if (intersected.length > 0) return intersected.map(entryToModelInfo);
        if (!this.fallback) return [];
        return ids.map((id) => ({ id }));
    }

    async *stream(req: LlmStreamRequest): AsyncGenerator<LlmStreamChunk, void, void> {
        const entry = resolveEntry(req.model, this.whitelist);
        const upstreamModel = entry ? entry.id : req.model;

        const clientReq = {
            model: upstreamModel,
            messages: req.messages.map((m) => {
                const out: { role: typeof m.role; content: string; name?: string } = {
                    role: m.role,
                    content: m.content,
                };
                if (m.name !== undefined) out.name = m.name;
                return out;
            }),
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
            ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        };

        let finishReason: string | undefined;
        let usage: LlmUsage | undefined;

        for await (const chunk of this.client.streamChatCompletions(clientReq, req.signal)) {
            const choice = chunk.choices?.[0];
            if (choice?.delta?.content) yield { type: "text", text: choice.delta.content };
            if (choice?.delta?.reasoning_content) {
                yield { type: "reasoning", text: choice.delta.reasoning_content };
            }
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            if (chunk.usage) {
                usage = {
                    ...(chunk.usage.prompt_tokens !== undefined
                        ? { promptTokens: chunk.usage.prompt_tokens }
                        : {}),
                    ...(chunk.usage.completion_tokens !== undefined
                        ? { completionTokens: chunk.usage.completion_tokens }
                        : {}),
                    ...(chunk.usage.total_tokens !== undefined
                        ? { totalTokens: chunk.usage.total_tokens }
                        : {}),
                };
            }
        }

        yield { type: "finish", reason: finishReason, usage };
    }
}

function entryToModelInfo(e: WhitelistEntry): LlmModelInfo {
    const info: LlmModelInfo = {
        id: e.id,
        family: e.family,
        contextWindow: e.contextWindow,
        maxOutputTokens: e.maxOutputTokens,
        reasoning: e.reasoning,
    };
    if (e.label !== undefined) info.label = e.label;
    if (e.vision !== undefined) info.vision = e.vision;
    return info;
}
