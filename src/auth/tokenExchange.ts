/**
 * Exchange a GitHub OAuth token for a short-lived Copilot bearer token via
 * the internal endpoint `api.github.com/copilot_internal/v2/token`.
 *
 * The response also carries per-account `endpoints` (see Phase -1 findings):
 * production callers MUST use `endpoints.api` and never hardcode a base URL.
 */
import { COMMON_HEADERS } from "./headers.js";
import { AuthError } from "./errors.js";

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

export interface CopilotEndpoints {
    api: string;
    "origin-tracker"?: string;
    proxy?: string;
    telemetry?: string;
}

export interface CopilotSession {
    /** Bearer token to send as `Authorization: Bearer <token>` to endpoints.api. */
    token: string;
    /** Absolute epoch-seconds (matching upstream `expires_at`). */
    expiresAt: number;
    /** Server-suggested refresh-after seconds (relative). */
    refreshIn: number;
    /** Dynamically-resolved base URLs per subscription tier. */
    endpoints: CopilotEndpoints;
    /** Retained for observability; not used for logic. */
    sku?: string;
    chatEnabled?: boolean;
}

interface RawTokenResponse {
    token: string;
    expires_at: number;
    refresh_in: number;
    endpoints?: CopilotEndpoints;
    sku?: string;
    chat_enabled?: boolean;
    [k: string]: unknown;
}

export async function exchangeCopilotToken(
    githubToken: string,
    deps: { fetchImpl?: typeof fetch } = {},
): Promise<CopilotSession> {
    const f = deps.fetchImpl ?? fetch;
    const res = await f(COPILOT_TOKEN_URL, {
        headers: {
            authorization: `token ${githubToken}`,
            accept: "application/json",
            ...COMMON_HEADERS,
        },
    });
    if (!res.ok) {
        const bodySnippet = await safeText(res);
        if (res.status === 401) {
            throw new AuthError(
                "token_exchange_unauthorized",
                "GitHub token invalid or expired; run `login` again",
                { status: 401, cause: bodySnippet },
            );
        }
        if (res.status === 403) {
            throw new AuthError(
                "token_exchange_forbidden",
                "account has no Copilot entitlement (individual not subscribed, or org/enterprise seat not assigned)",
                { status: 403, cause: bodySnippet },
            );
        }
        throw new AuthError("token_exchange_http", `copilot token exchange failed: HTTP ${res.status}`, {
            status: res.status,
            cause: bodySnippet,
        });
    }
    const j = (await res.json()) as RawTokenResponse;
    if (!j.endpoints?.api) {
        throw new AuthError(
            "token_exchange_http",
            "copilot token response missing endpoints.api; refusing to hardcode a base URL",
        );
    }
    const session: CopilotSession = {
        token: j.token,
        expiresAt: j.expires_at,
        refreshIn: j.refresh_in,
        endpoints: j.endpoints,
    };
    if (j.sku !== undefined) session.sku = j.sku;
    if (j.chat_enabled !== undefined) session.chatEnabled = j.chat_enabled;
    return session;
}

async function safeText(res: Response): Promise<string> {
    try {
        return (await res.text()).slice(0, 500);
    } catch {
        return "";
    }
}
