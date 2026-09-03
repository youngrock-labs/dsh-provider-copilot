/**
 * Plugin configuration: the `config` object a dsh profile supplies on the
 * `llm-copilot` composition row, validated into typed plugin defaults.
 *
 * Keep this a plain data shape (no functions) so it can come from YAML.
 * All knobs are optional; an absent section yields the defaults below.
 */

import type { HttpTimeouts } from "../client/http.js";

export interface CopilotPluginConfig {
    /**
     * Provider routes this plugin registers. One route is enough for one
     * subscription; more than one is legal only if no other adapter owns
     * those routes (dsh refuses duplicates at registration).
     */
    providers?: readonly string[];
    /** Copilot client connect/first-byte/idle/total timeouts in ms. */
    timeouts?: HttpTimeouts;
    /** `/models` listing cache TTL in ms (0 disables). */
    modelsTtlMs?: number;
    /** Context-window fallback for model ids absent from the whitelist. */
    defaultContextWindow?: number;
    /** Output-cap fallback for model ids absent from the whitelist. */
    defaultMaxTokens?: number;
    /** Register the `/copilot login|logout|status` command when dsh has a command service. */
    registerCommands?: boolean;
    /** Disable JSONL log writes entirely. */
    disableLog?: boolean;
}

export interface ResolvedPluginConfig {
    providers: readonly string[];
    timeouts?: HttpTimeouts;
    modelsTtlMs?: number;
    defaultContextWindow?: number;
    defaultMaxTokens?: number;
    registerCommands: boolean;
    disableLog: boolean;
}

const PROVIDER_NAME = /^[a-z][a-z0-9_-]*$/u;

function isPositiveInt(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) > 0;
}

/**
 * Validate a raw (untrusted) config object and return detached plugin
 * defaults. Throws a descriptive Error naming the offending field; the dsh
 * loader surfaces it at plugin activation.
 */
export function resolvePluginConfig(raw: unknown): ResolvedPluginConfig {
    const source = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;

    const rawProviders = source.providers;
    const providers = rawProviders === undefined
        ? ["copilot"]
        : Array.isArray(rawProviders) && rawProviders.length > 0
            ? rawProviders.map(String)
            : ["copilot"];

    const seen = new Set<string>();
    for (const provider of providers) {
        if (provider.length === 0 || !PROVIDER_NAME.test(provider)) {
            throw new Error(
                `llm-copilot: provider "${provider}" is not a valid route name (lowercase, hyphenated)`,
            );
        }
        if (seen.has(provider)) {
            throw new Error(`llm-copilot: duplicate provider route "${provider}"`);
        }
        seen.add(provider);
    }

    const timeouts = source.timeouts as HttpTimeouts | undefined;
    if (timeouts !== undefined) {
        if (typeof timeouts !== "object" || timeouts === null) {
            throw new Error("llm-copilot: timeouts must be an object");
        }
        for (const key of ["connectMs", "firstByteMs", "idleMs", "totalMs"] as const) {
            const value = timeouts[key];
            if (value !== undefined && !isPositiveInt(value)) {
                throw new Error(`llm-copilot: timeouts.${key} must be a positive integer`);
            }
        }
    }

    const modelsTtlMs = source.modelsTtlMs;
    if (modelsTtlMs !== undefined
        && (!Number.isFinite(modelsTtlMs) || (modelsTtlMs as number) < 0)) {
        throw new Error("llm-copilot: modelsTtlMs must be a non-negative number");
    }

    for (const key of ["defaultContextWindow", "defaultMaxTokens"] as const) {
        const value = source[key];
        if (value !== undefined && !isPositiveInt(value)) {
            throw new Error(`llm-copilot: ${key} must be a positive integer`);
        }
    }

    const registerCommands = source.registerCommands;
    const disableLog = source.disableLog;

    return {
        providers,
        ...(timeouts === undefined ? {} : { timeouts }),
        ...(modelsTtlMs !== undefined ? { modelsTtlMs: modelsTtlMs as number } : {}),
        ...(source.defaultContextWindow !== undefined
            ? { defaultContextWindow: source.defaultContextWindow as number }
            : {}),
        ...(source.defaultMaxTokens !== undefined
            ? { defaultMaxTokens: source.defaultMaxTokens as number }
            : {}),
        registerCommands: registerCommands === undefined ? true : Boolean(registerCommands),
        disableLog: disableLog === undefined
            ? process.env.DSH_COPILOT_NO_LOG === "1"
            : Boolean(disableLog),
    };
}
