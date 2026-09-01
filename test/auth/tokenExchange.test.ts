import { describe, it, expect } from "vitest";
import { exchangeCopilotToken } from "../../src/auth/tokenExchange.js";

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

describe("exchangeCopilotToken", () => {
    it("maps 401 to token_exchange_unauthorized", async () => {
        const fetchImpl = (async () => new Response("bad", { status: 401 })) as unknown as typeof fetch;
        await expect(exchangeCopilotToken("ghu_x", { fetchImpl })).rejects.toMatchObject({
            code: "token_exchange_unauthorized",
        });
    });

    it("maps 403 to token_exchange_forbidden (no entitlement)", async () => {
        const fetchImpl = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
        await expect(exchangeCopilotToken("ghu_x", { fetchImpl })).rejects.toMatchObject({
            code: "token_exchange_forbidden",
        });
    });

    it("refuses to accept a response without endpoints.api", async () => {
        const fetchImpl = (async () =>
            json(200, { token: "t", expires_at: 1, refresh_in: 60 })) as unknown as typeof fetch;
        await expect(exchangeCopilotToken("ghu_x", { fetchImpl })).rejects.toMatchObject({
            code: "token_exchange_http",
        });
    });

    it("returns a normalized session on success", async () => {
        const fetchImpl = (async () =>
            json(200, {
                token: "bearer",
                expires_at: 12345,
                refresh_in: 1500,
                endpoints: { api: "https://api.individual.githubcopilot.com" },
                sku: "individual",
                chat_enabled: true,
            })) as unknown as typeof fetch;
        const s = await exchangeCopilotToken("ghu_x", { fetchImpl });
        expect(s).toEqual({
            token: "bearer",
            expiresAt: 12345,
            refreshIn: 1500,
            endpoints: { api: "https://api.individual.githubcopilot.com" },
            sku: "individual",
            chatEnabled: true,
        });
    });
});
