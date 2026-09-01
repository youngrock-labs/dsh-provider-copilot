/**
 * GitHub Device Flow client for the official VSCode Copilot OAuth App.
 *
 * PLAN.md Phase 1 requires full state machine coverage:
 *   authorization_pending | slow_down | expired_token | access_denied
 *
 * The polling loop is testable via injected `fetchImpl` and `sleep`; production
 * callers pass real `fetch` and `setTimeout`-based sleep.
 */
import { COMMON_HEADERS } from "./headers.js";
import { AuthError } from "./errors.js";

/** Official VSCode GitHub Copilot Chat OAuth App client_id (public value). */
export const COPILOT_OAUTH_CLIENT_ID = "Iv1.b507a08c87ecfe98";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

export interface DeviceCode {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    /** Server-suggested poll interval in milliseconds. */
    intervalMs: number;
    /** Absolute epoch-ms deadline after which the device_code is invalid. */
    expiresAtMs: number;
}

export interface DeviceFlowDeps {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    now?: () => number;
}

interface AccessTokenResponse {
    access_token?: string;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(t);
            reject(new DOMException("aborted", "AbortError"));
        };
        if (signal) {
            if (signal.aborted) {
                clearTimeout(t);
                reject(new DOMException("aborted", "AbortError"));
                return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
        }
    });

/** Kick off Device Flow: request a user code the user must enter in a browser. */
export async function startDeviceFlow(deps: DeviceFlowDeps = {}): Promise<DeviceCode> {
    const f = deps.fetchImpl ?? fetch;
    const now = deps.now ?? Date.now;
    const res = await f(DEVICE_CODE_URL, {
        method: "POST",
        headers: {
            accept: "application/json",
            "content-type": "application/json",
            ...COMMON_HEADERS,
        },
        body: JSON.stringify({ client_id: COPILOT_OAUTH_CLIENT_ID, scope: "read:user" }),
    });
    if (!res.ok) {
        const body = await safeText(res);
        throw new AuthError("device_flow_http", `device/code failed: HTTP ${res.status}`, {
            status: res.status,
            cause: body,
        });
    }
    const j = (await res.json()) as {
        device_code: string;
        user_code: string;
        verification_uri: string;
        interval?: number;
        expires_in: number;
    };
    return {
        deviceCode: j.device_code,
        userCode: j.user_code,
        verificationUri: j.verification_uri,
        intervalMs: Math.max(1, j.interval ?? 5) * 1000,
        expiresAtMs: now() + j.expires_in * 1000,
    };
}

/**
 * Poll the access_token endpoint until the user authorizes, denies, or the
 * device_code expires. Honors `slow_down` by growing the interval per GitHub's
 * spec (+5s).
 */
export async function pollForToken(
    device: DeviceCode,
    deps: DeviceFlowDeps & { signal?: AbortSignal } = {},
): Promise<string> {
    const f = deps.fetchImpl ?? fetch;
    const sleep = deps.sleep ?? defaultSleep;
    const now = deps.now ?? Date.now;
    let interval = device.intervalMs;

    while (now() < device.expiresAtMs) {
        await sleep(interval, deps.signal);
        if (now() >= device.expiresAtMs) break;
        const res = await f(ACCESS_TOKEN_URL, {
            method: "POST",
            headers: {
                accept: "application/json",
                "content-type": "application/json",
                ...COMMON_HEADERS,
            },
            body: JSON.stringify({
                client_id: COPILOT_OAUTH_CLIENT_ID,
                device_code: device.deviceCode,
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }),
        });
        if (!res.ok) {
            const body = await safeText(res);
            throw new AuthError("device_flow_http", `access_token failed: HTTP ${res.status}`, {
                status: res.status,
                cause: body,
            });
        }
        const j = (await res.json()) as AccessTokenResponse;
        if (j.access_token) return j.access_token;
        switch (j.error) {
            case "authorization_pending":
                continue;
            case "slow_down":
                interval += 5000;
                continue;
            case "expired_token":
                throw new AuthError("device_flow_expired", "device code expired before authorization");
            case "access_denied":
                throw new AuthError("device_flow_denied", "user denied authorization");
            default:
                throw new AuthError(
                    "device_flow_http",
                    `unexpected device flow response: ${j.error ?? "unknown"} ${j.error_description ?? ""}`.trim(),
                );
        }
    }
    throw new AuthError("device_flow_timeout", "device flow polling deadline exceeded");
}

async function safeText(res: Response): Promise<string> {
    try {
        return (await res.text()).slice(0, 500);
    } catch {
        return "";
    }
}
