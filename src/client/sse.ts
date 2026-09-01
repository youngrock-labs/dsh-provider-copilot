/**
 * Streaming SSE parser for OpenAI-shape chat completions.
 *
 * Handles (PLAN.md Phase 2):
 *   - Fragmented `data:` payloads split across TCP chunks.
 *   - CRLF or LF line endings.
 *   - Blank lines as event separators.
 *   - The `[DONE]` sentinel.
 *   - UTF-8 code points split across chunks (`TextDecoder({stream:true})`).
 *   - Non-JSON `data:` lines (keep-alives / comments / malformed) are skipped.
 *
 * Implemented as an async generator over a `ReadableStream<Uint8Array>` for
 * back-pressure and easy `AbortSignal` interplay via the underlying fetch.
 */

export interface ChatCompletionDelta {
    role?: "assistant" | "system" | "user" | "tool" | undefined;
    content?: string | undefined;
    // Copilot occasionally emits reasoning tokens on this field for thinking models.
    reasoning_content?: string | undefined;
}

export interface ChatCompletionChoice {
    index: number;
    delta?: ChatCompletionDelta;
    finish_reason?: string | null;
}

export interface ChatCompletionChunk {
    id?: string;
    object?: string;
    created?: number;
    model?: string;
    choices: ChatCompletionChoice[];
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
}

/** Yields parsed OpenAI-shape chunks; ignores keep-alives and malformed lines. */
export async function* parseSseChunks(
    body: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatCompletionChunk, void, void> {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";

    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) {
                buf += decoder.decode();
                for (const chunk of drainBuffer(buf, /* final */ true)) yield chunk;
                return;
            }
            buf += decoder.decode(value, { stream: true });
            // Emit lines up to the last complete newline; keep the tail for next round.
            const lastNl = Math.max(buf.lastIndexOf("\n"), buf.lastIndexOf("\r"));
            if (lastNl < 0) continue;
            const emit = buf.slice(0, lastNl + 1);
            buf = buf.slice(lastNl + 1);
            for (const chunk of drainBuffer(emit, /* final */ false)) yield chunk;
        }
    } finally {
        reader.releaseLock();
    }
}

function* drainBuffer(text: string, final: boolean): Generator<ChatCompletionChunk> {
    // Split on any line ending; blank lines act only as event separators, which
    // we do not need to track explicitly because each `data:` line is complete
    // JSON on its own (the OpenAI shape doesn't use multi-line `data:` frames).
    const lines = text.split(/\r\n|\r|\n/);
    // In non-final mode the last element is either "" (trailing NL) or a
    // partial line that we already left in `buf` upstream. Drop it either way.
    const upto = final ? lines.length : lines.length - 1;
    for (let i = 0; i < upto; i++) {
        const line = lines[i]!;
        if (!line || line.startsWith(":")) continue; // comments / keep-alives
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trimStart();
        if (payload === "[DONE]") return;
        try {
            yield JSON.parse(payload) as ChatCompletionChunk;
        } catch {
            // Malformed frame — skip. The higher layer decides whether to
            // surface this via metrics; the parser stays permissive.
        }
    }
}
