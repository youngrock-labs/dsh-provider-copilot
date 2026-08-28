/**
 * dsh LlmProvider adapter — Phase 3.
 *
 * Responsibilities (see PLAN.md Phase 3):
 *   - Implement dsh's LlmProvider interface: id / listModels / stream.
 *   - Forward `messages` structurally (no string concatenation).
 *   - Do NOT pass `tools` (out of scope for this provider).
 *   - Map delta.content -> text chunk; delta.reasoning_content -> reasoning chunk.
 *   - Wire AbortSignal straight through to fetch.
 *   - Expose remote /models ∩ local whitelist (whitelist carries context
 *     window, reasoning support, and other metadata).
 */

// Real implementation lands in Phase 3.
export {};
