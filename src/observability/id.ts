/** RFC 4122 v4 UUID. Uses `crypto.randomUUID` when available, falls back otherwise. */
import { randomUUID } from "node:crypto";

export function newRequestId(): string {
    return randomUUID();
}
