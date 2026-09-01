import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AuthStore } from "../../src/auth/store.js";

async function tmpdir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), "dsh-copilot-auth-"));
}

describe("AuthStore", () => {
    let dir: string;
    let store: AuthStore;

    beforeEach(async () => {
        dir = await tmpdir();
        store = new AuthStore(path.join(dir, "cfg"));
    });

    it("returns null when files don't exist", async () => {
        expect(await store.readGithubToken()).toBeNull();
        expect(await store.readSession()).toBeNull();
    });

    it("persists and re-reads the GitHub token entry", async () => {
        await store.writeGithubToken({ token: "ghu_x", source: "device_flow", createdAt: 42 });
        expect(await store.readGithubToken()).toEqual({
            token: "ghu_x",
            source: "device_flow",
            createdAt: 42,
        });
    });

    it("writes files with mode 0600 and dir with mode 0700", async () => {
        await store.writeGithubToken({ token: "t", source: "s", createdAt: 0 });
        const st = await fs.stat(store.githubTokenPath);
        const dirSt = await fs.stat(path.dirname(store.githubTokenPath));
        expect(st.mode & 0o777).toBe(0o600);
        expect(dirSt.mode & 0o777).toBe(0o700);
    });

    it("clear() removes both files idempotently", async () => {
        await store.writeGithubToken({ token: "t", source: "s", createdAt: 0 });
        await store.clear();
        await store.clear();
        expect(await store.readGithubToken()).toBeNull();
    });
});
