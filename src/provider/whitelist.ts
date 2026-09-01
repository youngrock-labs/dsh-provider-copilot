/**
 * Local model whitelist.
 *
 * The upstream `/models` endpoint returns ~57 entries, most of which are
 * internal / experimental (see Phase -1 findings). We expose only the models
 * we've validated with dsh and attach the metadata dsh needs to route
 * prompts sensibly (context window, output cap, reasoning support).
 *
 * Adding a model:
 *   1. Append an entry below.
 *   2. Set `reasoning: true` if the model streams `delta.reasoning_content`.
 *   3. Ship a matching E2E fixture in Phase 6.
 */

export interface WhitelistEntry {
    /** Canonical id used by dsh & shown in the picker. */
    id: string;
    /** Upstream ids to match against (accepts aliases like dated snapshots). */
    aliases: readonly string[];
    /** Display label; falls back to `id`. */
    label?: string;
    family: "openai" | "anthropic" | "google" | "xai" | "other";
    contextWindow: number;
    maxOutputTokens: number;
    /** True if the model emits `delta.reasoning_content`. */
    reasoning: boolean;
    /** True if the model accepts image inputs (not used yet; documented for Phase 6). */
    vision?: boolean;
}

export const DEFAULT_WHITELIST: readonly WhitelistEntry[] = [
    {
        id: "gpt-4o-mini",
        aliases: ["gpt-4o-mini", "gpt-4o-mini-2024-07-18"],
        family: "openai",
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        reasoning: false,
    },
    {
        id: "gpt-4o",
        aliases: ["gpt-4o", "gpt-4o-2024-11-20", "gpt-4o-2024-08-06", "gpt-4o-2024-05-13"],
        family: "openai",
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        reasoning: false,
        vision: true,
    },
    {
        id: "gpt-4.1",
        aliases: ["gpt-4.1", "gpt-4.1-2025-04-14"],
        family: "openai",
        contextWindow: 1_000_000,
        maxOutputTokens: 32_768,
        reasoning: false,
    },
    {
        id: "claude-sonnet-4.5",
        aliases: ["claude-sonnet-4.5"],
        family: "anthropic",
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        reasoning: false,
    },
    {
        id: "claude-opus-4.5",
        aliases: ["claude-opus-4.5"],
        family: "anthropic",
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        reasoning: false,
    },
];

/**
 * Intersect a list of upstream model ids with the whitelist.
 * Returns whitelist entries whose canonical id or any alias appears in `remote`.
 * The returned entries carry the canonical id (aliases are collapsed).
 */
export function intersectWithRemote(
    remoteIds: readonly string[],
    whitelist: readonly WhitelistEntry[] = DEFAULT_WHITELIST,
): WhitelistEntry[] {
    const seen = new Set(remoteIds);
    const out: WhitelistEntry[] = [];
    for (const entry of whitelist) {
        if (entry.aliases.some((a) => seen.has(a)) || seen.has(entry.id)) out.push(entry);
    }
    return out;
}

/** Given a canonical or alias id, return the whitelist entry (or null). */
export function resolveEntry(
    id: string,
    whitelist: readonly WhitelistEntry[] = DEFAULT_WHITELIST,
): WhitelistEntry | null {
    for (const entry of whitelist) {
        if (entry.id === id || entry.aliases.includes(id)) return entry;
    }
    return null;
}
