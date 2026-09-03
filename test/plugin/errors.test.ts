import { describe, it, expect } from "vitest";
import { LlmError, toLlmError, httpErrorCode, ERROR_CODES, errorCodeOf } from "../../src/plugin/errors.js";

describe("LlmError", () => {
    it("rejects empty message or code", () => {
        expect(() => new LlmError("", "AUTH")).toThrow(/message/);
        expect(() => new LlmError("boom", "")).toThrow(/code/);
    });

    it("rejects invalid status and providerRetryAfterMs", () => {
        expect(() => new LlmError("boom", "AUTH", { status: 42 })).toThrow(/status/);
        expect(() => new LlmError("boom", "AUTH", { providerRetryAfterMs: 0 })).toThrow(/providerRetryAfterMs/);
    });

    it("carries own data properties `code` and `failure` (dsh cross-package contract)", () => {
        const err = new LlmError("blocked", "AUTH", { status: 403, requestId: "req-1" });
        const codeDescriptor = Object.getOwnPropertyDescriptor(err, "code");
        const failureDescriptor = Object.getOwnPropertyDescriptor(err, "failure");
        expect(codeDescriptor?.value).toBe("AUTH");
        expect(failureDescriptor?.value).toEqual({
            message: "blocked",
            code: "AUTH",
            status: 403,
            requestId: "req-1",
        });
        expect(Object.isFrozen(failureDescriptor?.value)).toBe(true);
        expect(err.failure.code).toBe("AUTH");
    });
});

describe("httpErrorCode", () => {
    it("maps statuses onto the stable taxonomy", () => {
        expect(httpErrorCode(401)).toBe(ERROR_CODES.AUTH);
        expect(httpErrorCode(403)).toBe(ERROR_CODES.AUTH);
        expect(httpErrorCode(429)).toBe(ERROR_CODES.RATE_LIMIT);
        expect(httpErrorCode(400)).toBe(ERROR_CODES.INVALID_REQUEST);
        expect(httpErrorCode(404)).toBe(ERROR_CODES.INVALID_MODEL);
        expect(httpErrorCode(503)).toBe(ERROR_CODES.SERVER);
        expect(httpErrorCode(418)).toBe("HTTP_418");
    });
});

describe("toLlmError", () => {
    it("passes an LlmError through unchanged", () => {
        const original = new LlmError("same", ERROR_CODES.AUTH);
        expect(toLlmError(original)).toBe(original);
    });

    it("maps no_token_source to MISSING_CREDENTIAL", () => {
        const error = Object.assign(new Error("no source"), { code: "no_token_source" });
        const mapped = toLlmError(error);
        expect(mapped.failure.code).toBe(ERROR_CODES.MISSING_CREDENTIAL);
    });

    it("maps http_status by its status code", () => {
        const error = Object.assign(new Error("rate limited"), { code: "http_status", status: 429 });
        const mapped = toLlmError(error);
        expect(mapped.failure.code).toBe(ERROR_CODES.RATE_LIMIT);
        expect(mapped.failure.status).toBe(429);
    });

    it("maps timeout and network client errors", () => {
        const idle = Object.assign(new Error("idle"), { code: "http_idle_timeout" });
        expect(toLlmError(idle).failure.code).toBe(ERROR_CODES.STREAM_IDLE_TIMEOUT);
        const connect = Object.assign(new Error("connect"), { code: "http_connect_timeout" });
        expect(toLlmError(connect).failure.code).toBe(ERROR_CODES.TIMEOUT);
        const network = Object.assign(new Error("dns"), { code: "http_network" });
        expect(toLlmError(network).failure.code).toBe(ERROR_CODES.NETWORK);
    });

    it("handles non-Error throws", () => {
        expect(toLlmError("string throw").failure.code).toBe(ERROR_CODES.NETWORK);
        expect(toLlmError(undefined).failure.message.length).toBeGreaterThan(0);
    });
});

describe("errorCodeOf", () => {
    it("reads the stable code from any throw", () => {
        expect(errorCodeOf(new LlmError("x", "AUTH"))).toBe("AUTH");
        expect(errorCodeOf(Object.assign(new Error("y"), { code: "http_status" }))).toBe("http_status");
        expect(errorCodeOf(new Error("plain"))).toBe("Error");
        expect(errorCodeOf("z")).toBe("unknown");
    });
});
