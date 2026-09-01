/**
 * JSONL logger with daily-rotated files under `~/.config/dsh/copilot/log/`.
 *
 * Design:
 *   - One file per UTC day: `copilot-YYYY-MM-DD.jsonl`.
 *   - Files created with mode 0600; directory 0700 (matches auth cache).
 *   - Retention: files older than N days (default 7) pruned lazily on
 *     each rotation boundary. Pruning failures are swallowed — logging
 *     must never take down the caller.
 *   - Writes are line-buffered and awaited; a single write flush is enough
 *     because Node's fs.appendFile does a single syscall for a small line.
 *   - `flush()` is a no-op today; kept for a future batching version.
 *
 * The logger is fault-tolerant by design: any I/O error is captured and
 * exposed via `lastError` for tests, but never thrown to callers. The
 * plugin must never crash because logs can't be written.
 */

import { promises as fs, constants as fsc } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { defaultCacheDir } from "../auth/store.js";
import { assertLogSafe, type LogRecord } from "./record.js";

export interface JsonlLoggerOptions {
    /** Directory for the log files. Defaults to `<cacheDir>/log`. */
    dir?: string;
    /** Retention in days (files older than this are pruned). Default 7. */
    retentionDays?: number;
    /** Injectable clock for tests. */
    now?: () => number;
    /** Disable all I/O (useful in tests / BYOK scenarios). */
    disabled?: boolean;
}

export class JsonlLogger {
    private readonly dir: string;
    private readonly retentionDays: number;
    private readonly now: () => number;
    private readonly disabled: boolean;
    private ensured = false;
    private lastPruneDay = "";
    /** Last I/O error, exposed only for tests / diagnostics. */
    lastError: Error | null = null;

    constructor(options: JsonlLoggerOptions = {}) {
        this.dir = options.dir ?? path.join(defaultCacheDir(), "log");
        this.retentionDays = options.retentionDays ?? 7;
        this.now = options.now ?? Date.now;
        this.disabled = options.disabled ?? false;
    }

    /** Write one JSONL line. Never throws. */
    async write(record: LogRecord): Promise<void> {
        if (this.disabled) return;
        try {
            assertLogSafe(record);
            const nowMs = this.now();
            await this.ensureDir();
            const day = utcDayKey(nowMs);
            const file = path.join(this.dir, `copilot-${day}.jsonl`);
            const line = JSON.stringify({ ...record, ts: new Date(nowMs).toISOString() }) + "\n";
            // append with restrictive mode; O_CREAT ensures perms on first write.
            const fh = await fs.open(file, fsc.O_CREAT | fsc.O_WRONLY | fsc.O_APPEND, 0o600);
            try {
                await fh.writeFile(line);
            } finally {
                await fh.close();
            }
            if (day !== this.lastPruneDay) {
                this.lastPruneDay = day;
                // Fire-and-forget: prune failures never surface.
                this.prune(nowMs).catch(() => undefined);
            }
        } catch (e) {
            this.lastError = e as Error;
        }
    }

    /** No-op today; reserved for a batching implementation. */
    async flush(): Promise<void> {
        return;
    }

    /** Return files currently in the log dir, for tests / status. */
    async files(): Promise<string[]> {
        try {
            const names = await fs.readdir(this.dir);
            return names.filter((n) => /^copilot-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw e;
        }
    }

    private async ensureDir(): Promise<void> {
        if (this.ensured) return;
        await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
        await fs.chmod(this.dir, 0o700).catch(() => undefined);
        this.ensured = true;
    }

    private async prune(nowMs: number): Promise<void> {
        const cutoff = nowMs - this.retentionDays * 86_400_000;
        const names = await this.files().catch(() => [] as string[]);
        for (const name of names) {
            const m = name.match(/^copilot-(\d{4})-(\d{2})-(\d{2})\.jsonl$/);
            if (!m) continue;
            const fileMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
            if (fileMs < cutoff) {
                await fs.rm(path.join(this.dir, name), { force: true }).catch(() => undefined);
            }
        }
    }
}

/** UTC day key `YYYY-MM-DD` used for the file name. */
export function utcDayKey(ms: number): string {
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

/** Convenience: default log directory alongside auth cache. */
export function defaultLogDir(): string {
    return path.join(defaultCacheDir(), "log");
}

// Referenced only to keep `os` import used across platforms; avoids a lint drop.
void os;
