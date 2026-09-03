/**
 * AuthManager — orchestrates token acquisition, caching, and refresh.
 *
 * Refresh policy (PLAN.md Phase 1):
 *   - Blocking refresh if remaining lifetime < HARD_REFRESH_MS.
 *   - Opportunistic background refresh if < SOFT_REFRESH_MS.
 *   - Concurrent refreshes are deduplicated to a single in-flight promise.
 *
 * A "session" here is the Copilot bearer + its endpoints + expiry. To mint one
 * we need a GitHub token (obtained via the priority chain or Device Flow).
 */
import { AuthError } from "./errors.js";
import { AuthStore } from "./store.js";
import { resolveToken, type ResolvedToken, type TokenSource } from "./sources.js";
import { exchangeCopilotToken, type CopilotSession } from "./tokenExchange.js";
import { pollForToken, startDeviceFlow, type DeviceCode } from "./deviceFlow.js";

const HARD_REFRESH_MS = 2 * 60 * 1000; // <2 min left → block until refreshed
const SOFT_REFRESH_MS = 5 * 60 * 1000; // <5 min left → refresh in background

export interface AuthManagerOptions {
    store?: AuthStore;
    /** Explicit token override (BYOK), skipping all env/cache lookups. */
    byok?: { kind: "bearer" | "github"; token: string };
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    /** Injectable sleep for the Device Flow poll loop (tests). */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    now?: () => number;
}

export interface AuthStatus {
    hasSession: boolean;
    source: TokenSource | "device_flow" | null;
    expiresAt: number | null;
    endpoints: CopilotSession["endpoints"] | null;
    sku?: string | undefined;
}

export class AuthManager {
    private readonly store: AuthStore;
    private readonly opts: Required<Pick<AuthManagerOptions, "env" | "fetchImpl" | "now">> & {
        byok?: AuthManagerOptions["byok"];
        sleep?: AuthManagerOptions["sleep"];
    };
    private session: CopilotSession | null = null;
    private sessionSource: AuthStatus["source"] = null;
    private inflightRefresh: Promise<CopilotSession> | null = null;

    constructor(options: AuthManagerOptions = {}) {
        this.store = options.store ?? new AuthStore();
        this.opts = {
            env: options.env ?? process.env,
            fetchImpl: options.fetchImpl ?? fetch,
            now: options.now ?? Date.now,
            ...(options.byok ? { byok: options.byok } : {}),
            ...(options.sleep ? { sleep: options.sleep } : {}),
        };
    }

    /**
     * Return a currently-valid Copilot bearer, refreshing if needed.
     * If nothing is cached and no source is available, throws `no_token_source`.
     * Callers wanting interactive login should catch that and drive `login()`.
     */
    async getBearer(): Promise<{ token: string; endpoints: CopilotSession["endpoints"] }> {
        const s = await this.getSession();
        return { token: s.token, endpoints: s.endpoints };
    }

    async getSession(): Promise<CopilotSession> {
        // Warm from disk on first call.
        if (!this.session) {
            const cached = await this.store.readSession().catch(() => null);
            if (cached && this.remainingMs(cached) > HARD_REFRESH_MS) {
                this.session = cached;
                this.sessionSource = "cache";
            }
        }

        if (this.session && this.remainingMs(this.session) > HARD_REFRESH_MS) {
            // Fresh enough; maybe kick a background refresh.
            if (this.remainingMs(this.session) < SOFT_REFRESH_MS) void this.refresh().catch(() => undefined);
            return this.session;
        }

        // Need a blocking refresh — either no session or expiring soon.
        return this.refresh();
    }

    /**
     * Interactive login. Callers pass a callback to display the user code /
     * verification URI. Returns after the resulting Copilot session is minted
     * and persisted.
     */
    async login(display: (code: DeviceCode) => void, signal?: AbortSignal): Promise<CopilotSession> {
        const { code, done } = await this.beginLogin(signal);
        display(code);
        return done;
    }

    /**
     * Split interactive login: returns immediately with the device code and
     * a `done` promise that settles once authorization completes. Lets a
     * caller (e.g. an interactive command surface) print the code first and
     * continue polling in the background without blocking its own turn.
     */
    async beginLogin(signal?: AbortSignal): Promise<{ code: DeviceCode; done: Promise<CopilotSession> }> {
        const flowDeps: Parameters<typeof startDeviceFlow>[0] = {
            fetchImpl: this.opts.fetchImpl,
            now: this.opts.now,
        };
        if (this.opts.sleep !== undefined) flowDeps.sleep = this.opts.sleep;
        const code = await startDeviceFlow(flowDeps);
        const pollDeps: Parameters<typeof pollForToken>[1] = {
            fetchImpl: this.opts.fetchImpl,
            now: this.opts.now,
        };
        if (this.opts.sleep !== undefined) pollDeps.sleep = this.opts.sleep;
        if (signal) pollDeps.signal = signal;
        const done = this.finishDeviceLogin(code, pollDeps);
        return { code, done };
    }

    /** Exchange, persist, and adopt the session once the user authorizes. */
    private async finishDeviceLogin(
        code: DeviceCode,
        deps: Parameters<typeof pollForToken>[1],
    ): Promise<CopilotSession> {
        const gh = await pollForToken(code, deps);
        await this.store.writeGithubToken({ token: gh, source: "device_flow", createdAt: this.opts.now() });
        const session = await exchangeCopilotToken(gh, { fetchImpl: this.opts.fetchImpl });
        this.session = session;
        this.sessionSource = "device_flow";
        await this.store.writeSession(session);
        return session;
    }

    async logout(): Promise<void> {
        this.session = null;
        this.sessionSource = null;
        await this.store.clear();
    }

    async status(): Promise<AuthStatus> {
        // Report from memory; do not force a refresh here.
        const s = this.session ?? (await this.store.readSession().catch(() => null));
        if (!s) return { hasSession: false, source: null, expiresAt: null, endpoints: null };
        const st: AuthStatus = {
            hasSession: true,
            source: this.sessionSource,
            expiresAt: s.expiresAt,
            endpoints: s.endpoints,
        };
        if (s.sku !== undefined) st.sku = s.sku;
        return st;
    }

    /** Force-refresh path; deduplicated across concurrent callers. */
    private refresh(): Promise<CopilotSession> {
        if (this.inflightRefresh) return this.inflightRefresh;
        this.inflightRefresh = this.doRefresh().finally(() => {
            this.inflightRefresh = null;
        });
        return this.inflightRefresh;
    }

    private async doRefresh(): Promise<CopilotSession> {
        const resolved = await this.resolveGithubOrBearer();
        if (!resolved) {
            throw new AuthError(
                "no_token_source",
                "no auth source available; run `login` or set COPILOT_TOKEN / COPILOT_GITHUB_TOKEN",
            );
        }

        if (resolved.kind === "bearer") {
            // A raw bearer bypasses the exchange. Expiry is unknown, so we
            // synthesize a short window and let callers refresh on 401.
            const session: CopilotSession = {
                token: resolved.token,
                expiresAt: Math.floor(this.opts.now() / 1000) + 25 * 60,
                refreshIn: 25 * 60,
                endpoints: this.session?.endpoints ?? {
                    api: "https://api.individual.githubcopilot.com",
                },
            };
            this.session = session;
            this.sessionSource = resolved.source;
            return session;
        }

        const session = await exchangeCopilotToken(resolved.token, { fetchImpl: this.opts.fetchImpl });
        this.session = session;
        this.sessionSource = resolved.source;
        await this.store.writeSession(session).catch(() => undefined);
        return session;
    }

    private async resolveGithubOrBearer(): Promise<ResolvedToken | null> {
        const resolverOpts: Parameters<typeof resolveToken>[0] = {
            env: this.opts.env,
            store: this.store,
        };
        if (this.opts.byok) resolverOpts.byok = this.opts.byok;
        return resolveToken(resolverOpts);
    }

    private remainingMs(s: CopilotSession): number {
        return s.expiresAt * 1000 - this.opts.now();
    }
}
