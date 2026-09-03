/**
 * Translate parsed Copilot (OpenAI-compatible) chat-completion chunks into
 * the dsh `StreamChunk` protocol.
 *
 * Mirrors the dsh `llm-deepseek` translator's shape
 * (`packages/llm/llm-deepseek/src/translate.ts` in the dsh repository): one
 * stateful block per content/reasoning stream, `index` increasing per opened
 * block, `block-end`/`usage`/`finish` deferred until the chunk source ends so
 * nothing follows `finish`.
 *
 * The caller owns transport: chunks arrive here already parsed (and with the
 * `[DONE]` sentinel already consumed) from `CopilotClient`.
 */

import type { ChatCompletionChunk } from "../client/sse.js";
import { ERROR_CODES } from "./errors.js";
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from "./protocol.js";

/** One open block under assembly. */
interface OpenBlock {
    index: number;
    kind: "text" | "reasoning";
    text: string;
}

/** Wire usage fields as Copilot actually sends them (superset of the client type). */
interface WireUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
}

/**
 * Map the wire `finish_reason` vocabulary to the harness `FinishReason`.
 * Unrecognized values (`content_filter`, …) become an error finish with the
 * uppercased value as `code`, mirroring the DeepSeek adapter.
 */
export function mapFinishReason(reason: string): FinishReason {
    switch (reason) {
        case "stop": return { kind: "stop" };
        case "tool_calls": return { kind: "tool-calls" };
        case "length": return { kind: "max-tokens" };
        default:
            return {
                kind: "error",
                failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
            };
    }
}

/**
 * Map wire usage onto the disjoint harness counts: cache reads are subtracted
 * out of `inputTokens`, and an exact total is kept only when the aggregate
 * counters are valid and agree with any wire total.
 */
export function mapUsage(usage: WireUsage): TokenUsage {
    const cacheRead = usage.prompt_tokens_details?.cached_tokens;
    const reasoning = usage.completion_tokens_details?.reasoning_tokens;
    const prompt = usage.prompt_tokens ?? 0;
    const completion = usage.completion_tokens ?? 0;
    const combined = prompt + completion;
    const hasExactTotal = Number.isSafeInteger(prompt)
        && Number.isSafeInteger(completion)
        && Number.isSafeInteger(combined)
        && (usage.total_tokens === undefined || usage.total_tokens === combined);
    return {
        inputTokens: prompt - (cacheRead ?? 0),
        outputTokens: completion,
        ...(hasExactTotal ? { totalTokens: combined } : {}),
        ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
        ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    };
}

/** Assemble the final content block for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
    return block.kind === "text"
        ? { type: "text", text: block.text }
        : { type: "reasoning", text: block.text };
}

/**
 * Consume parsed chat-completion chunks and yield `StreamChunk`s. `finish`
 * reasons and usage are deferred to the end of the chunk source so a
 * `finish` chunk is always terminal. A `stop` (or absent) finish with no
 * opened blocks is a degenerate provider completion and maps to an
 * `EMPTY_RESPONSE` error finish.
 */
export async function* translate(
    chunks: AsyncIterable<ChatCompletionChunk>,
): AsyncGenerator<StreamChunk> {
    let nextIndex = 0;
    let textBlock: OpenBlock | undefined;
    let reasoningBlock: OpenBlock | undefined;
    const order: OpenBlock[] = [];
    let pendingFinish: FinishReason | undefined;
    let pendingUsage: TokenUsage | undefined;

    const open = (kind: OpenBlock["kind"]): OpenBlock => {
        const block: OpenBlock = { index: nextIndex++, kind, text: "" };
        order.push(block);
        return block;
    };

    for await (const chunk of chunks) {
        for (const choice of chunk.choices ?? []) {
            const delta = choice.delta;

            // Reasoning first: thinking models interleave it before text. An
            // empty-string first chunk must not open a block.
            const reasoning = delta?.reasoning_content;
            if (typeof reasoning === "string" && reasoning.length > 0) {
                if (!reasoningBlock) {
                    reasoningBlock = open("reasoning");
                    yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
                }
                reasoningBlock.text += reasoning;
                yield { type: "reasoning-delta", index: reasoningBlock.index, text: reasoning };
            }

            const content = delta?.content;
            if (typeof content === "string" && content.length > 0) {
                if (!textBlock) {
                    textBlock = open("text");
                    yield { type: "block-start", index: textBlock.index, blockType: "text" };
                }
                textBlock.text += content;
                yield { type: "text-delta", index: textBlock.index, text: content };
            }

            if (typeof choice.finish_reason === "string") {
                pendingFinish = mapFinishReason(choice.finish_reason);
            }
        }

        // Usage may arrive attached to the finish chunk or as a trailing
        // usage-only chunk — keep the latest.
        const usage = chunk.usage as WireUsage | undefined;
        if (usage !== undefined
            && (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined)) {
            pendingUsage = mapUsage(usage);
        }
    }

    for (const block of order) {
        yield { type: "block-end", index: block.index, block: closeBlock(block) };
    }
    if (pendingUsage) yield { type: "usage", usage: pendingUsage };
    const reason = pendingFinish ?? { kind: "stop" as const };
    yield {
        type: "finish",
        reason: reason.kind === "stop" && order.length === 0
            ? {
                kind: "error",
                failure: {
                    message: "model returned a completed response with no content",
                    code: ERROR_CODES.EMPTY_RESPONSE,
                },
            }
            : reason,
    };
}
