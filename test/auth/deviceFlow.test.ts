import { describe, it, expect } from "vitest";
import { pollForToken, startDeviceFlow, type DeviceCode } from "../../src/auth/deviceFlow.js";
import { AuthError } from "../../src/auth/errors.js";

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function makeFetch(sequence: Response[]): typeof fetch {
    let i = 0;
    return (async () => {
        const r = sequence[i++];
        if (!r) throw new Error("unexpected fetch call");
        return r;
    }) as unknown as typeof fetch;
}

describe("startDeviceFlow", () => {
    it("returns the device code with normalized fields", async () => {
        const now = () => 1_000_000;
        const fetchImpl = makeFetch([
            jsonResponse(200, {
                device_code: "dev",
                user_code: "ABCD-1234",
                verification_uri: "https://github.com/login/device",
                interval: 3,
                expires_in: 900,
            }),
        ]);
        const d = await startDeviceFlow({ fetchImpl, now });
        expect(d.deviceCode).toBe("dev");
        expect(d.userCode).toBe("ABCD-1234");
        expect(d.intervalMs).toBe(3000);
        expect(d.expiresAtMs).toBe(1_000_000 + 900_000);
    });

    it("throws AuthError on non-2xx", async () => {
        const fetchImpl = makeFetch([new Response("nope", { status: 500 })]);
        await expect(startDeviceFlow({ fetchImpl })).rejects.toBeInstanceOf(AuthError);
    });
});

describe("pollForToken state machine", () => {
    const device: DeviceCode = {
        deviceCode: "dev",
        userCode: "X",
        verificationUri: "u",
        intervalMs: 1000,
        expiresAtMs: Number.MAX_SAFE_INTEGER,
    };

    it("succeeds after authorization_pending", async () => {
        const fetchImpl = makeFetch([
            jsonResponse(200, { error: "authorization_pending" }),
            jsonResponse(200, { error: "authorization_pending" }),
            jsonResponse(200, { access_token: "ghu_ok" }),
        ]);
        const sleeps: number[] = [];
        const token = await pollForToken(device, {
            fetchImpl,
            sleep: async (ms) => {
                sleeps.push(ms);
            },
            now: () => 0,
        });
        expect(token).toBe("ghu_ok");
        expect(sleeps).toEqual([1000, 1000, 1000]);
    });

    it("grows the interval by +5s on slow_down", async () => {
        const fetchImpl = makeFetch([
            jsonResponse(200, { error: "slow_down" }),
            jsonResponse(200, { error: "slow_down" }),
            jsonResponse(200, { access_token: "ghu_ok" }),
        ]);
        const sleeps: number[] = [];
        await pollForToken(device, {
            fetchImpl,
            sleep: async (ms) => {
                sleeps.push(ms);
            },
            now: () => 0,
        });
        // 1000 → 6000 → 11000 (the last one before the successful call)
        expect(sleeps).toEqual([1000, 6000, 11000]);
    });

    it("maps expired_token to a typed error", async () => {
        const fetchImpl = makeFetch([jsonResponse(200, { error: "expired_token" })]);
        await expect(
            pollForToken(device, { fetchImpl, sleep: async () => undefined, now: () => 0 }),
        ).rejects.toMatchObject({ code: "device_flow_expired" });
    });

    it("maps access_denied to a typed error", async () => {
        const fetchImpl = makeFetch([jsonResponse(200, { error: "access_denied" })]);
        await expect(
            pollForToken(device, { fetchImpl, sleep: async () => undefined, now: () => 0 }),
        ).rejects.toMatchObject({ code: "device_flow_denied" });
    });

    it("times out when the deadline passes", async () => {
        let t = 0;
        const past: DeviceCode = { ...device, expiresAtMs: 500 };
        const fetchImpl = makeFetch([]);
        await expect(
            pollForToken(past, {
                fetchImpl,
                sleep: async () => {
                    t = 1000;
                },
                now: () => t,
            }),
        ).rejects.toMatchObject({ code: "device_flow_timeout" });
    });
});
