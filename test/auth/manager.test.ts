import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AuthManager } from "../../src/auth/manager.js";
import { AuthStore } from "../../src/auth/store.js";

function jsonFetch(map: (url: string) => { status: number; body: unknown }): typeof fetch {
    return (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        const { status, body } = map(url);
        return new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
        });
    }) as unknown as typeof fetch;
}

async function tmpStore(): Promise<AuthStore> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-copilot-mgr-"));
    return new AuthStore(path.join(dir, "cfg"));
}

describe("AuthManager", () => {
    let store: AuthStore;
    beforeEach(async () => {
        store = await tmpStore();
    });

    it("throws no_token_source when the chain is empty", async () => {
        const m = new AuthManager({ store, env: {}, fetchImpl: jsonFetch(() => ({ status: 500, body: {} })) });
        await expect(m.getBearer()).rejects.toMatchObject({ code: "no_token_source" });
    });

    it("uses a raw COPILOT_TOKEN (bearer) without calling the exchange endpoint", async () => {
        let calls = 0;
        const fetchImpl = jsonFetch(() => {
            calls++;
            return { status: 500, body: {} };
        });
        const m = new AuthManager({ store, env: { COPILOT_TOKEN: "bearer-x" }, fetchImpl });
        const b = await m.getBearer();
        expect(b.token).toBe("bearer-x");
        expect(calls).toBe(0);
    });

    it("exchanges COPILOT_GITHUB_TOKEN and caches the session", async () => {
        const now = () => 1_700_000_000_000;
        const fetchImpl = jsonFetch((url) => {
            if (url.endsWith("copilot_internal/v2/token")) {
                return {
                    status: 200,
                    body: {
                        token: "bearer-1",
                        expires_at: Math.floor(now() / 1000) + 1800,
                        refresh_in: 1500,
                        endpoints: { api: "https://api.individual.githubcopilot.com" },
                    },
                };
            }
            return { status: 500, body: {} };
        });
        const m = new AuthManager({
            store,
            env: { COPILOT_GITHUB_TOKEN: "ghu_x" },
            fetchImpl,
            now,
        });
        const s = await m.getSession();
        expect(s.token).toBe("bearer-1");
        expect(s.endpoints.api).toBe("https://api.individual.githubcopilot.com");
        // Second call is served from memory (no expected new fetch).
        const s2 = await m.getSession();
        expect(s2.token).toBe("bearer-1");
        // Cache was persisted.
        expect((await store.readSession())?.token).toBe("bearer-1");
    });

    it("deduplicates concurrent refreshes into a single in-flight call", async () => {
        const now = () => 1_700_000_000_000;
        let exchangeCalls = 0;
        const fetchImpl = (async (input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.endsWith("copilot_internal/v2/token")) {
                exchangeCalls++;
                await new Promise((r) => setTimeout(r, 20));
                return new Response(
                    JSON.stringify({
                        token: `bearer-${exchangeCalls}`,
                        expires_at: Math.floor(now() / 1000) + 1800,
                        refresh_in: 1500,
                        endpoints: { api: "https://api.individual.githubcopilot.com" },
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                );
            }
            return new Response("{}", { status: 500 });
        }) as unknown as typeof fetch;
        const m = new AuthManager({ store, env: { COPILOT_GITHUB_TOKEN: "ghu_x" }, fetchImpl, now });
        const [a, b, c] = await Promise.all([m.getBearer(), m.getBearer(), m.getBearer()]);
        expect(exchangeCalls).toBe(1);
        expect(a.token).toBe(b.token);
        expect(b.token).toBe(c.token);
    });

    it("blocks and refreshes when the cached session is near expiry", async () => {
        const clock = 1_700_000_000_000;
        const now = () => clock;
        // Pre-seed a session that is expiring in 30s (< HARD_REFRESH_MS = 2min).
        await store.writeSession({
            token: "old-bearer",
            expiresAt: Math.floor(clock / 1000) + 30,
            refreshIn: 60,
            endpoints: { api: "https://api.individual.githubcopilot.com" },
        });
        let exchangeCalls = 0;
        const fetchImpl = jsonFetch((url) => {
            if (url.endsWith("copilot_internal/v2/token")) {
                exchangeCalls++;
                return {
                    status: 200,
                    body: {
                        token: "new-bearer",
                        expires_at: Math.floor(clock / 1000) + 1800,
                        refresh_in: 1500,
                        endpoints: { api: "https://api.individual.githubcopilot.com" },
                    },
                };
            }
            return { status: 500, body: {} };
        });
        const m = new AuthManager({ store, env: { COPILOT_GITHUB_TOKEN: "ghu_x" }, fetchImpl, now });
        const s = await m.getSession();
        expect(s.token).toBe("new-bearer");
        expect(exchangeCalls).toBe(1);
    });

    it("logout clears memory and disk", async () => {
        const now = () => 1_700_000_000_000;
        const fetchImpl = jsonFetch(() => ({
            status: 200,
            body: {
                token: "bearer",
                expires_at: Math.floor(now() / 1000) + 1800,
                refresh_in: 1500,
                endpoints: { api: "https://api.individual.githubcopilot.com" },
            },
        }));
        const m = new AuthManager({ store, env: { COPILOT_GITHUB_TOKEN: "ghu_x" }, fetchImpl, now });
        await m.getSession();
        await m.logout();
        expect((await m.status()).hasSession).toBe(false);
        expect(await store.readSession()).toBeNull();
    });

    it("beginLogin returns the device code immediately and mints a session later", async () => {
        const now = () => 1_700_000_000_000;
        const noSleep = () => Promise.resolve();
        const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            if (url.includes("/login/device/code")) {
                return new Response(
                    JSON.stringify({
                        device_code: "dc-1",
                        user_code: "ABCD-1234",
                        verification_uri: "https://github.com/login/device",
                        expires_in: 900,
                        interval: 1,
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                );
            }
            if (url.includes("/login/oauth/access_token")) {
                void init;
                return new Response(
                    JSON.stringify({ access_token: "ghu_flow", token_type: "bearer" }),
                    { status: 200, headers: { "content-type": "application/json" } },
                );
            }
            if (url.includes("copilot_internal/v2/token")) {
                return new Response(
                    JSON.stringify({
                        token: "bearer-flow",
                        expires_at: Math.floor(now() / 1000) + 1800,
                        refresh_in: 1500,
                        endpoints: { api: "https://api.individual.githubcopilot.com" },
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                );
            }
            return new Response("{}", { status: 500 });
        }) as unknown as typeof fetch;
        const m = new AuthManager({ store, env: {}, fetchImpl, sleep: noSleep, now });
        const { code, done } = await m.beginLogin();
        expect(code.userCode).toBe("ABCD-1234");
        expect(code.verificationUri).toBe("https://github.com/login/device");
        const session = await done;
        expect(session.token).toBe("bearer-flow");
        expect((await m.status()).hasSession).toBe(true);
    });
});
