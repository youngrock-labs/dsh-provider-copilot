import { describe, it, expect } from "vitest";
import { resolveToken, readGhHostsToken } from "../../src/auth/sources.js";
import type { AuthStore } from "../../src/auth/store.js";

const fakeStore = (token: string | null): AuthStore =>
    ({
        readGithubToken: async () => (token ? { token, source: "cache", createdAt: 0 } : null),
    }) as unknown as AuthStore;

describe("resolveToken priority chain", () => {
    it("BYOK wins over every env source", async () => {
        const r = await resolveToken({
            byok: { kind: "bearer", token: "b" },
            env: { COPILOT_TOKEN: "c", COPILOT_GITHUB_TOKEN: "g" },
            store: fakeStore("cached"),
        });
        expect(r).toEqual({ kind: "bearer", token: "b", source: "byok" });
    });

    it("COPILOT_TOKEN (bearer) beats COPILOT_GITHUB_TOKEN and cache", async () => {
        const r = await resolveToken({
            env: { COPILOT_TOKEN: "c", COPILOT_GITHUB_TOKEN: "g" },
            store: fakeStore("cached"),
        });
        expect(r).toEqual({ kind: "bearer", token: "c", source: "env_copilot_token" });
    });

    it("COPILOT_GITHUB_TOKEN beats cache", async () => {
        const r = await resolveToken({
            env: { COPILOT_GITHUB_TOKEN: "g" },
            store: fakeStore("cached"),
        });
        expect(r).toEqual({ kind: "github", token: "g", source: "env_copilot_github_token" });
    });

    it("falls through to cache when no env set", async () => {
        const r = await resolveToken({ env: {}, store: fakeStore("cached") });
        expect(r).toEqual({ kind: "github", token: "cached", source: "cache" });
    });

    it("skips gh hosts and env GH_TOKEN unless opt-in flags set", async () => {
        const r = await resolveToken({
            env: { GH_TOKEN: "ghp_xxx" },
            store: fakeStore(null),
        });
        expect(r).toBeNull();
    });

    it("uses GH_TOKEN only when DSH_COPILOT_ALLOW_ENV_GH=1", async () => {
        const r = await resolveToken({
            env: { DSH_COPILOT_ALLOW_ENV_GH: "1", GH_TOKEN: "ghp_xxx" },
            store: fakeStore(null),
        });
        expect(r).toEqual({ kind: "github", token: "ghp_xxx", source: "env_gh_token" });
    });

    it("uses gh hosts.yml only when DSH_COPILOT_ALLOW_GH_HOSTS=1", async () => {
        const yaml = `github.com:
    user: alice
    oauth_token: gho_fromhosts
    git_protocol: https
enterprise.example.com:
    user: bob
    oauth_token: gho_ignored
`;
        const r = await resolveToken({
            env: { DSH_COPILOT_ALLOW_GH_HOSTS: "1" },
            store: fakeStore(null),
            ghHostsPath: "/fake/hosts.yml",
            readFile: async () => yaml,
        });
        expect(r).toEqual({ kind: "github", token: "gho_fromhosts", source: "gh_hosts" });
    });

    it("returns null when the whole chain is empty", async () => {
        const r = await resolveToken({ env: {}, store: fakeStore(null) });
        expect(r).toBeNull();
    });
});

describe("readGhHostsToken", () => {
    it("parses the github.com oauth_token", async () => {
        const yaml = "github.com:\n    user: a\n    oauth_token: gho_x\n";
        const t = await readGhHostsToken("x", async () => yaml);
        expect(t).toBe("gho_x");
    });
    it("returns null when file is missing", async () => {
        const t = await readGhHostsToken("x", async () => {
            throw new Error("ENOENT");
        });
        expect(t).toBeNull();
    });
    it("returns null when github.com section is absent", async () => {
        const t = await readGhHostsToken("x", async () => "example.com:\n    oauth_token: nope\n");
        expect(t).toBeNull();
    });
});
