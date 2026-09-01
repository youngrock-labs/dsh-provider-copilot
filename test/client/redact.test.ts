import { describe, it, expect } from "vitest";
import { redactSecrets } from "../../src/client/redact.js";

describe("redactSecrets", () => {
    it("redacts Authorization Bearer values", () => {
        const out = redactSecrets("Authorization: Bearer abc.def_123-XYZ");
        expect(out).toBe("Authorization: Bearer <redacted>");
    });

    it("redacts `token <t>` header form (case-insensitive)", () => {
        const out = redactSecrets("authorization: token ghs_deadbeef");
        expect(out).toContain("token <redacted>");
        expect(out).not.toContain("ghs_deadbeef");
    });

    it("redacts GitHub token prefixes", () => {
        const raw = "ghp_AAAAAAAAAAAAAAAAAAAA ghu_BBBBBBBBBBBBBBBBBBBB gho_CCCCCCCCCCCCCCCCCCCC";
        const out = redactSecrets(raw);
        expect(out).not.toMatch(/gh[pou]_[A-Z]/);
        expect(out.match(/<redacted-gh-token>/g)?.length).toBe(3);
    });

    it("redacts legacy 40-hex PATs", () => {
        const out = redactSecrets("token=0123456789abcdef0123456789abcdef01234567");
        expect(out).toContain("<redacted-pat>");
    });

    it("redacts Copilot semicolon-token keys (tid=/exp=/sig=/...)", () => {
        const raw = "tid=abc;exp=999;sku=individual;sig=deadbeef";
        const out = redactSecrets(raw);
        expect(out).toBe("tid=<redacted>;exp=<redacted>;sku=<redacted>;sig=<redacted>");
    });

    it("leaves normal text alone", () => {
        expect(redactSecrets("hello world")).toBe("hello world");
    });

    it("handles empty input", () => {
        expect(redactSecrets("")).toBe("");
    });
});
