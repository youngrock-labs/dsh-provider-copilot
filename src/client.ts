/**
 * HTTP client — Phase 2.
 *
 * Responsibilities (see PLAN.md Phase 2):
 *   - listModels() with a 5 min TTL cache.
 *   - chatCompletionsStream(req, signal) yielding parsed SSE deltas.
 *   - SSE parser covers: fragmented data, CRLF, blank lines, [DONE],
 *     UTF-8 split across chunks, non-JSON lines, disconnects.
 *   - Layered timeouts (connect / first-byte / idle / total) with
 *     distinguishable error codes.
 *   - Single retry with backoff on 429 + Retry-After.
 *   - redactSecrets() for Bearer, GitHub PATs, Copilot semicolon-token
 *     (tid=/exp=/...), and Authorization values.
 *   - Fixed Copilot-style User-Agent (non-Copilot UAs are 403'd by api.github.com).
 *   - Base URL is ALWAYS taken from the token response's endpoints.api.
 */

// Real implementation lands in Phase 2.
export {};
