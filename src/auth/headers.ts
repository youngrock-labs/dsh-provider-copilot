/**
 * Shared HTTP identity headers.
 *
 * Non-Copilot User-Agents are 403'd by api.github.com with an anti-scraping
 * response (see Phase -1 findings). Keep this pinned; do not accept overrides
 * from callers.
 */
export const COPILOT_UA = "GitHubCopilotChat/0.22.0";
export const EDITOR_VERSION = "vscode/1.95.0";
export const EDITOR_PLUGIN_VERSION = "copilot-chat/0.22.0";
export const COPILOT_INTEGRATION_ID = "vscode-chat";

export const COMMON_HEADERS: Readonly<Record<string, string>> = Object.freeze({
    "user-agent": COPILOT_UA,
    "editor-version": EDITOR_VERSION,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "copilot-integration-id": COPILOT_INTEGRATION_ID,
});
