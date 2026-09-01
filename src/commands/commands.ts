/**
 * `/copilot login | logout | status` command handlers.
 *
 * Handlers are shell-independent: each returns a plain result the entry
 * layer renders. The `login` handler pushes progress via a callback so a
 * CLI can print the user code without blocking the manager on I/O.
 */

import type { AuthManager, DeviceCode, AuthStatus } from "../auth/index.js";
import type { CopilotClient } from "../client/copilotClient.js";
import type { MetricsRing } from "./metrics.js";

export interface CommandDeps {
    auth: AuthManager;
    client: CopilotClient;
    metrics: MetricsRing;
    now?: () => number;
}

export interface LoginResult {
    ok: true;
    expiresAt: number;
    endpoints: { api: string };
}

export interface LogoutResult {
    ok: true;
}

export interface StatusResult {
    hasSession: boolean;
    source: AuthStatus["source"];
    expiresAt: number | null;
    expiresInSeconds: number | null;
    endpoints: AuthStatus["endpoints"];
    sku?: string | undefined;
    modelCount: number | null;
    latency: { p50: number; p95: number; n: number } | null;
    recent: {
        at: number;
        model: string;
        latencyMs: number;
        ok: boolean;
        errorCode?: string | undefined;
    }[];
}

/**
 * Drive Device Flow to obtain a Copilot session. `onCode` is called once
 * with the user code + verification URI so the shell can display it.
 */
export async function login(
    deps: CommandDeps,
    onCode: (code: DeviceCode) => void,
    signal?: AbortSignal,
): Promise<LoginResult> {
    const session = await deps.auth.login(onCode, signal);
    // Warm the models cache so /copilot status can render count immediately.
    await deps.client.listModels(signal).catch(() => undefined);
    return { ok: true, expiresAt: session.expiresAt, endpoints: { api: session.endpoints.api } };
}

export async function logout(deps: CommandDeps): Promise<LogoutResult> {
    await deps.auth.logout();
    deps.client.invalidateModels();
    deps.metrics.clear();
    return { ok: true };
}

export async function status(deps: CommandDeps): Promise<StatusResult> {
    const now = (deps.now ?? Date.now)();
    const authStatus = await deps.auth.status();
    let modelCount: number | null = null;
    if (authStatus.hasSession) {
        // Non-throwing: /copilot status must render even when the network is down.
        modelCount = await deps.client
            .listModels()
            .then((m) => m.length)
            .catch(() => null);
    }
    const percentiles = deps.metrics.percentiles();
    return {
        hasSession: authStatus.hasSession,
        source: authStatus.source,
        expiresAt: authStatus.expiresAt,
        expiresInSeconds:
            authStatus.expiresAt !== null ? Math.max(0, authStatus.expiresAt - Math.floor(now / 1000)) : null,
        endpoints: authStatus.endpoints,
        sku: authStatus.sku,
        modelCount,
        latency: percentiles,
        recent: deps.metrics.snapshot().map((r) => {
            const entry: StatusResult["recent"][number] = {
                at: r.at,
                model: r.model,
                latencyMs: r.latencyMs,
                ok: r.ok,
            };
            if (r.errorCode !== undefined) entry.errorCode = r.errorCode;
            return entry;
        }),
    };
}

/** Human-readable one-liner for shells that don't want to format the object. */
export function formatStatus(s: StatusResult): string {
    if (!s.hasSession) return "copilot: not logged in — run `/copilot login`";
    const src = s.source ?? "unknown";
    const exp =
        s.expiresInSeconds === null
            ? "?"
            : s.expiresInSeconds > 3600
            ? `${Math.floor(s.expiresInSeconds / 3600)}h`
            : `${Math.floor(s.expiresInSeconds / 60)}m`;
    const models = s.modelCount === null ? "?" : String(s.modelCount);
    const lat = s.latency ? ` p50=${s.latency.p50}ms p95=${s.latency.p95}ms (n=${s.latency.n})` : "";
    const sku = s.sku ? ` sku=${s.sku}` : "";
    return `copilot: ok (${src}${sku}) expires_in=${exp} models=${models}${lat}`;
}
