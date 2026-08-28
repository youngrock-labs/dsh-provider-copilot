/**
 * Auth module — Phase 1.
 *
 * Responsibilities (see PLAN.md Phase 1):
 *   - Device Flow against the official VSCode Copilot OAuth App
 *     (client_id = Iv1.b507a08c87ecfe98) with full state machine.
 *   - Exchange the GitHub token for a Copilot bearer token via
 *     https://api.github.com/copilot_internal/v2/token.
 *   - Cache tokens under ~/.config/dsh/copilot/ (dir 0700, file 0600).
 *   - Source priority: BYOK → COPILOT_TOKEN → COPILOT_GITHUB_TOKEN →
 *     OAuth cache → `gh` hosts.yml → GH_TOKEN/GITHUB_TOKEN (opt-in).
 *   - Refresh: blocking when <2 min left; background pre-refresh 5 min out;
 *     deduplicate concurrent refreshes.
 */

export const COPILOT_OAUTH_CLIENT_ID = "Iv1.b507a08c87ecfe98";

// Real implementation lands in Phase 1.
