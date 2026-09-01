// SSE fixtures recorded from real Copilot responses (redacted / minimized).
// Kept as string constants so the E2E test can run in-memory without disk I/O.

/** Two-turn assistant reply, ending with a usage-carrying stop chunk. */
export const CHAT_SIMPLE_SSE: string = [
    `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1_756_000_000,
        model: "gpt-4o-mini",
        choices: [{ index: 0, delta: { role: "assistant" } }],
    })}`,
    "",
    `data: ${JSON.stringify({
        id: "chatcmpl-1",
        choices: [{ index: 0, delta: { content: "Hello" } }],
    })}`,
    "",
    `data: ${JSON.stringify({
        id: "chatcmpl-1",
        choices: [{ index: 0, delta: { content: ", world!" } }],
    })}`,
    "",
    `data: ${JSON.stringify({
        id: "chatcmpl-1",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    })}`,
    "",
    "data: [DONE]",
    "",
    "",
].join("\n");

/** Reasoning stream: two reasoning deltas, then answer + stop. */
export const CHAT_REASONING_SSE: string = [
    `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { reasoning_content: "Analyzing... " } }],
    })}`,
    "",
    `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { reasoning_content: "answer is 4." } }],
    })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "4" } }] })}`,
    "",
    `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}`,
    "",
    "data: [DONE]",
    "",
].join("\n");

/** Realistic (trimmed) /models payload — covers whitelist ids + noise. */
export const MODELS_JSON: {
    data: { id: string; vendor?: string; capabilities?: { family?: string } }[];
} = {
    data: [
        { id: "gpt-4o-mini", vendor: "openai", capabilities: { family: "gpt-4o" } },
        { id: "gpt-4o-2024-11-20", vendor: "openai", capabilities: { family: "gpt-4o" } },
        { id: "gpt-4.1", vendor: "openai", capabilities: { family: "gpt-4.1" } },
        { id: "claude-sonnet-4.5", vendor: "anthropic" },
        { id: "exec-agent-a" },
        { id: "trajectory-compaction" },
        { id: "text-embedding-3-small" },
    ],
};

/** Copilot token exchange response for the individual tier. */
export const TOKEN_EXCHANGE_JSON: Record<string, unknown> = {
    token: "tid=abc;exp=9999999999;sku=individual;sig=deadbeef",
    expires_at: 9_999_999_999,
    refresh_in: 1500,
    endpoints: {
        api: "https://api.individual.githubcopilot.com",
        proxy: "https://proxy.individual.githubcopilot.com",
        telemetry: "https://telemetry.individual.githubcopilot.com",
        "origin-tracker": "https://origin-tracker.individual.githubcopilot.com",
    },
    sku: "individual",
    chat_enabled: true,
};
