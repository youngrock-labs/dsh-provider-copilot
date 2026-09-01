/**
 * CopilotClient — thin transport for `/models` and `/chat/completions`.
 *
 * Responsibilities (PLAN.md Phase 2):
 *   - Compose the request URL from `endpoints.api` (never hardcoded).
 *   - Apply pinned Copilot headers on every call (see Phase -1 UA finding).
 *   - Cache `/models` for 5 minutes.
 *   - Stream `/chat/completions` with layered timeouts + typed errors.
 *   - Retry once on 429 (honoring Retry-After).
 *
 * The client does NOT own auth. Callers pass a `getBearer()` that returns a
 * `{ token, endpoints.api }` pair — this lets AuthManager (Phase 1) handle
 * refresh/dedup transparently.
 */

import { COMMON_HEADERS } from "../auth/headers.js";
import { ClientError } from "./errors.js";
import { fetchWithTimeouts, resolveTimeouts, withStreamTimeouts, type HttpTimeouts } from "./http.js";
import { parseSseChunks, type ChatCompletionChunk } from "./sse.js";

export interface BearerRef {
    token: string;
    endpoints: { api: string };
}

export interface CopilotClientOptions {
    getBearer: () => Promise<BearerRef>;
    fetchImpl?: typeof fetch;
    timeouts?: HttpTimeouts;
    /** Model-list cache TTL. Defaults to 5 minutes; set 0 to disable. */
    modelsTtlMs?: number;
    now?: () => number;
}

export interface CopilotModel {
    id: string;
    vendor?: string;
    version?: string;
    capabilities?: {
        family?: string;
        limits?: { max_context_window_tokens?: number; max_output_tokens?: number };
        supports?: { streaming?: boolean; tool_calls?: boolean; vision?: boolean };
    };
    [k: string]: unknown;
}

export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    name?: string;
}

export interface ChatCompletionsRequest {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    stream?: boolean;
    [k: string]: unknown;
}

export class CopilotClient {
    private readonly opts: Required<
        Pick<CopilotClientOptions, "getBearer" | "fetchImpl" | "modelsTtlMs" | "now">
    > & { timeouts?: HttpTimeouts };
    private modelsCache: { at: number; data: CopilotModel[] } | null = null;
    private modelsInflight: Promise<CopilotModel[]> | null = null;

    constructor(options: CopilotClientOptions) {
        this.opts = {
            getBearer: options.getBearer,
            fetchImpl: options.fetchImpl ?? fetch,
            modelsTtlMs: options.modelsTtlMs ?? 5 * 60 * 1000,
            now: options.now ?? Date.now,
            ...(options.timeouts ? { timeouts: options.timeouts } : {}),
        };
    }

    invalidateModels(): void {
        this.modelsCache = null;
    }

    async listModels(signal?: AbortSignal): Promise<CopilotModel[]> {
        const cached = this.modelsCache;
        if (cached && this.opts.now() - cached.at < this.opts.modelsTtlMs) return cached.data;
        if (this.modelsInflight) return this.modelsInflight;

        this.modelsInflight = (async () => {
            const bearer = await this.opts.getBearer();
            const res = await fetchWithTimeouts(joinUrl(bearer.endpoints.api, "/models"), {
                fetchImpl: this.opts.fetchImpl,
                ...(this.opts.timeouts ? { timeouts: this.opts.timeouts } : {}),
                ...(signal ? { signal } : {}),
                headers: {
                    ...COMMON_HEADERS,
                    accept: "application/json",
                    authorization: `Bearer ${bearer.token}`,
                },
                retryOn429: true,
            });
            if (!res.ok) {
                const snippet = await safeText(res);
                throw new ClientError("http_status", `GET /models failed: HTTP ${res.status}`, {
                    status: res.status,
                    cause: snippet,
                });
            }
            const body = (await res.json()) as { data?: CopilotModel[] };
            const data = body.data ?? [];
            this.modelsCache = { at: this.opts.now(), data };
            return data;
        })().finally(() => {
            this.modelsInflight = null;
        });
        return this.modelsInflight;
    }

    /**
     * Stream a chat completion. Yields parsed OpenAI-shape chunks. The caller
     * MUST fully consume the generator (or call `.return()`) so that the
     * underlying stream is cancelled and its timers cleared.
     */
    async *streamChatCompletions(
        req: ChatCompletionsRequest,
        signal?: AbortSignal,
    ): AsyncGenerator<ChatCompletionChunk, void, void> {
        const bearer = await this.opts.getBearer();
        const res = await fetchWithTimeouts(joinUrl(bearer.endpoints.api, "/chat/completions"), {
            method: "POST",
            fetchImpl: this.opts.fetchImpl,
            ...(this.opts.timeouts ? { timeouts: this.opts.timeouts } : {}),
            ...(signal ? { signal } : {}),
            headers: {
                ...COMMON_HEADERS,
                accept: "text/event-stream",
                "content-type": "application/json",
                authorization: `Bearer ${bearer.token}`,
            },
            body: JSON.stringify({ ...req, stream: true }),
            retryOn429: true,
        });
        if (!res.ok || !res.body) {
            const snippet = await safeText(res);
            throw new ClientError("http_status", `POST /chat/completions failed: HTTP ${res.status}`, {
                status: res.status,
                cause: snippet,
            });
        }
        const timeouts = resolveTimeouts(this.opts.timeouts);
        const wrapped = withStreamTimeouts(res.body, timeouts);
        try {
            for await (const chunk of parseSseChunks(wrapped)) yield chunk;
        } catch (e) {
            if (e instanceof ClientError) throw e;
            throw new ClientError("sse_stream_error", (e as Error)?.message ?? "stream error", { cause: e });
        }
    }
}

function joinUrl(base: string, pathname: string): string {
    const b = base.endsWith("/") ? base.slice(0, -1) : base;
    const p = pathname.startsWith("/") ? pathname : `/${pathname}`;
    return b + p;
}

async function safeText(res: Response): Promise<string> {
    try {
        return (await res.text()).slice(0, 500);
    } catch {
        return "";
    }
}
