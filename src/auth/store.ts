/**
 * Secure on-disk cache for auth artifacts.
 *
 * Layout:
 *   ${XDG_CONFIG_HOME:-~/.config}/dsh/copilot/
 *     github_token.json   (persisted GitHub OAuth token from Device Flow)
 *     session.json        (last Copilot session; the bearer is short-lived
 *                         but caching lets us skip an exchange on cold start
 *                         when still valid.)
 *
 * Directory is created with 0700, files written atomically with 0600.
 */
import { promises as fs, constants as fsc } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AuthError } from "./errors.js";
import type { CopilotSession } from "./tokenExchange.js";

export interface StoredGithubToken {
    token: string;
    /** Free-form label ("device_flow", "byok", ...) for observability. */
    source: string;
    createdAt: number;
}

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
    const xdg = env.XDG_CONFIG_HOME;
    const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
    return path.join(base, "dsh", "copilot");
}

export class AuthStore {
    constructor(private readonly dir: string = defaultCacheDir()) {}

    get githubTokenPath(): string {
        return path.join(this.dir, "github_token.json");
    }
    get sessionPath(): string {
        return path.join(this.dir, "session.json");
    }

    private async ensureDir(): Promise<void> {
        try {
            await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
            // mkdir with `recursive:true` won't chmod an existing dir; enforce it.
            await fs.chmod(this.dir, 0o700).catch(() => {
                // best-effort on filesystems that reject chmod (e.g. certain FUSE mounts)
            });
        } catch (e) {
            throw new AuthError("cache_io", `failed to create ${this.dir}`, { cause: e });
        }
    }

    async readGithubToken(): Promise<StoredGithubToken | null> {
        return readJson<StoredGithubToken>(this.githubTokenPath);
    }

    async writeGithubToken(entry: StoredGithubToken): Promise<void> {
        await this.ensureDir();
        await writeAtomic(this.githubTokenPath, entry);
    }

    async readSession(): Promise<CopilotSession | null> {
        return readJson<CopilotSession>(this.sessionPath);
    }

    async writeSession(session: CopilotSession): Promise<void> {
        await this.ensureDir();
        await writeAtomic(this.sessionPath, session);
    }

    async clear(): Promise<void> {
        for (const p of [this.githubTokenPath, this.sessionPath]) {
            await fs.rm(p, { force: true }).catch(() => undefined);
        }
    }
}

async function readJson<T>(file: string): Promise<T | null> {
    try {
        const buf = await fs.readFile(file, "utf8");
        return JSON.parse(buf) as T;
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new AuthError("cache_io", `failed to read ${file}`, { cause: e });
    }
}

async function writeAtomic(file: string, value: unknown): Promise<void> {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const data = JSON.stringify(value, null, 2);
    try {
        // O_CREAT | O_WRONLY | O_EXCL, mode 0600 — no world/group access ever.
        const fh = await fs.open(tmp, fsc.O_CREAT | fsc.O_WRONLY | fsc.O_EXCL, 0o600);
        try {
            await fh.writeFile(data);
        } finally {
            await fh.close();
        }
        await fs.rename(tmp, file);
    } catch (e) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw new AuthError("cache_io", `failed to write ${file}`, { cause: e });
    }
}
