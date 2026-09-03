import { describe, it, expect, vi } from "vitest";
import type { AuthStatus } from "../../src/auth/index.js";
import type { ChatCompletionChunk } from "../../src/client/sse.js";
import { ClientError } from "../../src/client/index.js";
import { CopilotAdapter, buildChatRequest } from "../../src/plugin/copilotAdapter.js";
import type { CopilotClientLike } from "../../src/plugin/copilotAdapter.js";
import { ERROR_CODES, LlmError } from "../../src/plugin/errors.js";
import type { GenerateOptions, Message, StreamChunk } from "../../src/plugin/protocol.js";

const NOW = 1_800_000_000_000;

function textMessage(role: "user" | "assistant" | "system", text: string): Message {
    return { role, content: [{ type: "text", text }] };
}

function chunk(patch: Partial<ChatCompletionChunk>): ChatCompletionChunk {
    return {
        id: "chatcmpl-t",
        choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        ...patch,
    };
}

function session(hasSession: boolean): AuthStatus {
    return hasSession
        ? {
            hasSession: true,
            source: "env_copilot_token",
            expiresAt: Math.floor(NOW / 1000) + 3600,
            endpoints: { api: "https://api.individual.githubcopilot.com" },
        }
        : { hasSession: false, source: null, expiresAt: null, endpoints: null };
}

interface FakeClientState {
    requests: Array<{ req: Parameters<CopilotClientLike["streamChatCompletions"]>[0]; signal?: AbortSignal }>;
    remoteModels: string[];
    streamChunks: ChatCompletionChunk[];
    streamError?: unknown;
}

function fakeClient(state: FakeClientState): CopilotClientLike {
    return {
        async listModels() {
            return state.remoteModels.map((id) => ({ id }));
        },
        async *streamChatCompletions(req, signal) {
            state.requests.push({ req, signal });
            if (state.streamError !== undefined) throw state.streamError;
            for (const item of state.streamChunks) yield item;
        },
        invalidateModels() {
            // no-op for tests
        },
    };
}

function makeAdapter(overrides?: { state?: FakeClientState; session?: AuthStatus }) {
    const state: FakeClientState = overrides?.state ?? { requests: [], remoteModels: [], streamChunks: [] };
    const adapter = new CopilotAdapter({
        client: fakeClient(state),
        peekSession: async () => overrides?.session ?? session(false),
        now: () => NOW,
    });
    return { adapter, state };
}

const request: GenerateOptions = {
    provider: "copilot",
    model: "gpt-4o-mini",
    messages: [textMessage("user", "hi")],
};

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
    const out: StreamChunk[] = [];
    for await (const item of stream) out.push(item);
    return out;
}

describe("CopilotAdapter.providerInfo / listModels / resolveModel", () => {
    it("describes the provider route", () => {
        const { adapter } = makeAdapter();
        expect(adapter.providerInfo("copilot")).toEqual({ id: "copilot", name: "Copilot (GitHub)" });
    });

    it("implements the full LlmAdapter surface dsh calls during registration", async () => {
        const { adapter } = makeAdapter();
        // dsh's registry invokes these (the LlmAdapter base supplies them); a
        // shape-bound adapter must provide them too or registration throws.
        expect(adapter.providerRetryPolicy("copilot")).toBeUndefined();
        expect(adapter.imageRequestPricing("copilot", "gpt-4o-mini")).toBeUndefined();
        expect(typeof adapter.prepareCall).toBe("function");
        expect(typeof adapter.resolveModel).toBe("function");
        expect(typeof adapter.stream).toBe("function");
    });

    it("advertises the whitelist before login so the picker group is visible", async () => {
        const { adapter } = makeAdapter();
        const models = await adapter.listModels("copilot");
        expect(models.length).toBeGreaterThan(0);
        for (const model of models) {
            expect(model.provider).toBe("copilot");
            expect(model.id.length).toBeGreaterThan(0);
            expect(model.name.length).toBeGreaterThan(0);
            expect(model.inputModalities).toEqual(["text"]);
        }
        expect(new Set(models.map((m) => m.id)).size).toBe(models.length);
    });

    it("intersects the remote model list when a session exists", async () => {
        const state: FakeClientState = {
            requests: [],
            remoteModels: ["gpt-4o-mini", "exec-agent-internal", "trajectory-compaction"],
            streamChunks: [],
        };
        const adapter = new CopilotAdapter({
            client: fakeClient(state),
            peekSession: async () => session(true),
            now: () => NOW,
        });
        const models = await adapter.listModels("copilot");
        expect(models.map((m) => m.id)).toContain("gpt-4o-mini");
        expect(models.map((m) => m.id)).not.toContain("exec-agent-internal");
    });

    it("falls back to the whitelist when the remote listing fails", async () => {
        const failing: CopilotClientLike = {
            listModels: async () => {
                throw new Error("network down");
            },
            streamChatCompletions: async function* () { /* no chunks */ },
            invalidateModels() {
                // no-op
            },
        };
        const adapter = new CopilotAdapter({
            client: failing,
            peekSession: async () => session(true),
            now: () => NOW,
        });
        const models = await adapter.listModels("copilot");
        expect(models.length).toBeGreaterThan(0);
    });

    it("resolves known models with whitelist metadata and unknown ids with defaults", async () => {
        const { adapter } = makeAdapter();
        const known = await adapter.resolveModel("copilot", "gpt-4o-mini");
        expect(known.id).toBe("gpt-4o-mini");
        expect(known.provider).toBe("copilot");
        expect(known.context?.contextWindow).toBeGreaterThan(0);
        expect(known.defaultMaxTokens).toBeGreaterThan(0);
        expect(known.inputModalities).toEqual(["text"]);
        const unknown = await adapter.resolveModel("copilot", "brand-new-model");
        expect(unknown.id).toBe("brand-new-model");
        expect(unknown.name).toBe("brand-new-model");
        expect(unknown.defaultMaxTokens).toBeGreaterThan(0);
    });
});

describe("CopilotAdapter.stream", () => {
    it("yields translated chunks and reports usage to the observer", async () => {
        const state: FakeClientState = {
            requests: [],
            remoteModels: [],
            streamChunks: [
                chunk({ choices: [{ index: 0, delta: { content: "Hello" } }] }),
                chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
            ],
        };
        const onStart = vi.fn();
        const onEnd = vi.fn();
        const adapter = new CopilotAdapter({
            client: fakeClient(state),
            peekSession: async () => session(false),
            now: () => NOW,
            observer: { onStart, onEnd },
        });
        const out = await drain(adapter.stream(request));
        expect(out.some((item) => item.type === "text-delta")).toBe(true);
        expect(out.at(-1)).toEqual({ type: "finish", reason: { kind: "stop" } });
        expect(onStart).toHaveBeenCalledWith({ model: "gpt-4o-mini", requestId: expect.any(String) });
        expect(onEnd).toHaveBeenCalledWith(
            expect.objectContaining({
                model: "gpt-4o-mini",
                ok: true,
                latencyMs: 0,
                usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
            }),
        );
        expect(state.requests[0]?.req.model).toBe("gpt-4o-mini");
    });

    it("collapses dated aliases to the canonical model on the wire", async () => {
        const state: FakeClientState = { requests: [], remoteModels: [], streamChunks: [] };
        const { adapter } = makeAdapter({ state });
        await drain(adapter.stream({ ...request, model: "gpt-4o-2024-11-20" }));
        expect(state.requests[0]?.req.model).toBe("gpt-4o");
    });

    it("forwards system, parameters, stop, and never tools", async () => {
        const state: FakeClientState = { requests: [], remoteModels: [], streamChunks: [] };
        const { adapter } = makeAdapter({ state });
        const options: GenerateOptions = {
            ...request,
            system: "You are helpful.",
            temperature: 0.2,
            top_p: 0.9,
            maxTokens: 512,
            stop: ["\n"],
            tools: [{ name: "echo", description: "x", parameters: {} }],
        };
        await drain(adapter.stream(options));
        const sent = state.requests[0]?.req;
        expect(sent?.messages[0]).toEqual({ role: "system", content: "You are helpful." });
        expect(sent?.messages.at(-1)).toEqual({ role: "user", content: "hi" });
        expect(sent?.max_tokens).toBe(512);
        expect(sent?.temperature).toBe(0.2);
        expect(sent?.top_p).toBe(0.9);
        expect(sent?.stop).toEqual(["\n"]);
        expect("tools" in (sent as Record<string, unknown>)).toBe(false);
    });

    it("forwards the caller's AbortSignal identity to the client", async () => {
        const state: FakeClientState = { requests: [], remoteModels: [], streamChunks: [] };
        const { adapter } = makeAdapter({ state });
        const controller = new AbortController();
        await drain(adapter.stream({ ...request, signal: controller.signal }));
        expect(state.requests[0]?.signal).toBe(controller.signal);
    });

    it("maps client failures to stable codes and reports them to the observer", async () => {
        const state: FakeClientState = {
            requests: [],
            remoteModels: [],
            streamChunks: [],
            streamError: new ClientError("http_status", "429 rate limited", { status: 429 }),
        };
        const onEnd = vi.fn();
        const adapter = new CopilotAdapter({
            client: fakeClient(state),
            peekSession: async () => session(false),
            now: () => NOW,
            observer: { onEnd },
        });
        let caught: unknown;
        try {
            await drain(adapter.stream(request));
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(LlmError);
        expect((caught as LlmError).failure.code).toBe(ERROR_CODES.RATE_LIMIT);
        expect(onEnd).toHaveBeenCalledWith(
            expect.objectContaining({ ok: false, errorCode: ERROR_CODES.RATE_LIMIT }),
        );
    });

    it("maps an auth failure to MISSING_CREDENTIAL", async () => {
        const state: FakeClientState = {
            requests: [],
            remoteModels: [],
            streamChunks: [],
            streamError: Object.assign(new Error("no source"), { code: "no_token_source" }),
        };
        const { adapter } = makeAdapter({ state });
        let caught: unknown;
        try {
            await drain(adapter.stream(request));
        } catch (error) {
            caught = error;
        }
        expect((caught as LlmError).failure.code).toBe(ERROR_CODES.MISSING_CREDENTIAL);
    });
});

describe("buildChatRequest", () => {
    it("flattens multi-block assistant content and drops tool-only frames", () => {
        const options: GenerateOptions = {
            provider: "copilot",
            model: "gpt-4o",
            messages: [
                textMessage("user", "question"),
                {
                    role: "assistant",
                    content: [
                        { type: "reasoning", text: "hidden chain" },
                        { type: "text", text: "visible answer" },
                    ],
                },
                {
                    role: "assistant",
                    content: [{ type: "tool-call" } as unknown as Message["content"][number]],
                },
            ],
        };
        const sent = buildChatRequest(options, "gpt-4o");
        expect(sent.messages).toEqual([
            { role: "user", content: "question" },
            { role: "assistant", content: "hidden chain\nvisible answer" },
        ]);
    });

    it("prepends the system prompt when provided", () => {
        const sent = buildChatRequest({ ...request, system: "sys" }, "gpt-4o-mini");
        expect(sent.messages[0]).toEqual({ role: "system", content: "sys" });
    });
});
