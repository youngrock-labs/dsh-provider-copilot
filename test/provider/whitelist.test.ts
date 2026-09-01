import { describe, it, expect } from "vitest";
import {
    DEFAULT_WHITELIST,
    intersectWithRemote,
    resolveEntry,
    type WhitelistEntry,
} from "../../src/provider/whitelist.js";

describe("intersectWithRemote", () => {
    it("matches canonical ids", () => {
        const out = intersectWithRemote(["gpt-4o-mini", "unrelated"]);
        expect(out.map((e) => e.id)).toEqual(["gpt-4o-mini"]);
    });

    it("matches dated snapshot aliases (gpt-4o → gpt-4o-2024-11-20)", () => {
        const out = intersectWithRemote(["gpt-4o-2024-11-20"]);
        expect(out.map((e) => e.id)).toEqual(["gpt-4o"]);
    });

    it("returns [] when nothing matches", () => {
        const out = intersectWithRemote(["exec-agent-a", "trajectory-compaction"]);
        expect(out).toEqual([]);
    });

    it("does not duplicate an entry when both canonical + alias present", () => {
        const out = intersectWithRemote(["gpt-4o", "gpt-4o-2024-08-06"]);
        expect(out.map((e) => e.id)).toEqual(["gpt-4o"]);
    });

    it("honors a custom whitelist", () => {
        const wl: WhitelistEntry[] = [
            {
                id: "custom",
                aliases: ["custom", "custom-2025"],
                family: "other",
                contextWindow: 1000,
                maxOutputTokens: 100,
                reasoning: false,
            },
        ];
        expect(intersectWithRemote(["custom-2025"], wl).map((e) => e.id)).toEqual(["custom"]);
        expect(intersectWithRemote(["gpt-4o"], wl)).toEqual([]);
    });
});

describe("resolveEntry", () => {
    it("resolves canonical id", () => {
        expect(resolveEntry("gpt-4o-mini")?.id).toBe("gpt-4o-mini");
    });
    it("resolves an alias", () => {
        expect(resolveEntry("gpt-4o-2024-05-13")?.id).toBe("gpt-4o");
    });
    it("returns null for unknown ids", () => {
        expect(resolveEntry("nope")).toBeNull();
    });
});

describe("DEFAULT_WHITELIST", () => {
    it("has stable canonical ids and matching aliases", () => {
        for (const e of DEFAULT_WHITELIST) {
            expect(e.aliases).toContain(e.id);
            expect(e.contextWindow).toBeGreaterThan(0);
            expect(e.maxOutputTokens).toBeGreaterThan(0);
        }
    });
});
