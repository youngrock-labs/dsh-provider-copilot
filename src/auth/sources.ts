/**
 * Resolve a GitHub token or Copilot bearer from the documented priority chain:
 *
 *   1. BYOK (explicit constructor param — highest, wins even over env)
 *   2. env COPILOT_TOKEN         — a Copilot bearer (skip exchange)
 *   3. env COPILOT_GITHUB_TOKEN  — a GitHub OAuth token (needs exchange)
 *   4. OAuth cache (github_token.json from Device Flow)
 *   5. `gh` hosts.yml oauth_token (opt-in; likely rejected by copilot_internal,
 *      see Phase -1 findings — kept for completeness / diagnostics)
 *   6. GH_TOKEN / GITHUB_TOKEN   — opt-in (DSH_COPILOT_ALLOW_ENV_GH=1)
 *
 * Steps 5 and 6 are OFF by default because they leak "any GitHub token I
 * happen to have" into a Copilot-specific credential surface. Users must
 * opt in explicitly.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AuthStore } from "./store.js";

export type TokenKind = "bearer" | "github";

export type TokenSource =
    | "byok"
    | "env_copilot_token"
    | "env_copilot_github_token"
    | "cache"
    | "gh_hosts"
    | "env_gh_token";

export interface ResolvedToken {
    kind: TokenKind;
    token: string;
    source: TokenSource;
}

export interface ResolverOptions {
    byok?: { kind: TokenKind; token: string } | undefined;
    env?: NodeJS.ProcessEnv;
    store?: AuthStore;
    /** Read ~/.config/gh/hosts.yml (opt-in via DSH_COPILOT_ALLOW_GH_HOSTS=1). */
    ghHostsPath?: string;
    /** Injectable for tests. */
    readFile?: (p: string) => Promise<string>;
}

export async function resolveToken(opts: ResolverOptions = {}): Promise<ResolvedToken | null> {
    const env = opts.env ?? process.env;

    if (opts.byok) return { ...opts.byok, source: "byok" };

    const copilotToken = env.COPILOT_TOKEN;
    if (copilotToken) return { kind: "bearer", token: copilotToken, source: "env_copilot_token" };

    const copilotGh = env.COPILOT_GITHUB_TOKEN;
    if (copilotGh) return { kind: "github", token: copilotGh, source: "env_copilot_github_token" };

    if (opts.store) {
        const cached = await opts.store.readGithubToken();
        if (cached?.token) return { kind: "github", token: cached.token, source: "cache" };
    }

    if (env.DSH_COPILOT_ALLOW_GH_HOSTS === "1") {
        const p = opts.ghHostsPath ?? path.join(os.homedir(), ".config", "gh", "hosts.yml");
        const t = await readGhHostsToken(p, opts.readFile ?? ((f) => fs.readFile(f, "utf8")));
        if (t) return { kind: "github", token: t, source: "gh_hosts" };
    }

    if (env.DSH_COPILOT_ALLOW_ENV_GH === "1") {
        const t = env.GH_TOKEN ?? env.GITHUB_TOKEN;
        if (t) return { kind: "github", token: t, source: "env_gh_token" };
    }

    return null;
}

/**
 * Minimal parser for `gh` hosts.yml — we only need the top-level `github.com`
 * block's `oauth_token`. Full YAML parsing would drag in a dependency for one
 * line of value, so we walk lines instead: enter the `github.com:` section,
 * then read indented lines until we hit another top-level key.
 */
export async function readGhHostsToken(
    file: string,
    read: (p: string) => Promise<string>,
): Promise<string | null> {
    let text: string;
    try {
        text = await read(file);
    } catch {
        return null;
    }
    let inSection = false;
    for (const rawLine of text.split(/\r?\n/)) {
        if (!inSection) {
            if (/^github\.com:\s*$/.test(rawLine)) inSection = true;
            continue;
        }
        // Leaving the section when we hit another unindented, non-blank line.
        if (rawLine.length > 0 && !/^\s/.test(rawLine)) break;
        const m = rawLine.match(/^\s+oauth_token:\s*([^\s#]+)/);
        if (m) return m[1] ?? null;
    }
    return null;
}
