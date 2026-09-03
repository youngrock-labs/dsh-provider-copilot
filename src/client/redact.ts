/**
 * Redact secrets in strings that may be logged.
 *
 * Covers:
 *   - `Authorization: Bearer <t>` and bare `Bearer <t>`
 *   - GitHub tokens: `ghp_*`, `gho_*`, `ghu_*`, `ghs_*`, `ghr_*`, legacy 40-hex PATs
 *   - Copilot semicolon-tokens: sequences containing `tid=` / `exp=` / `sig=` keys
 *   - `Authorization: token <t>` header form
 *
 * This is a display/logging helper — it MUST NOT be used to sanitize inputs
 * for security decisions. It is intentionally aggressive: false-positives
 * (over-redaction) are preferred over leakage.
 */

const RE_BEARER = /(Bearer\s+)[A-Za-z0-9._-]+/g;
const RE_TOKEN_HEADER = /(token\s+)[A-Za-z0-9._-]+/gi;
const RE_GH_TOKEN = /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g;
const RE_LEGACY_PAT = /\b[a-f0-9]{40}\b/g;
// Copilot bearer bodies look like: tid=...;exp=...;sku=...;proxy-ep=...;st=...;sig=...
const RE_COPILOT_SEMI = /\b(?:tid|exp|sku|proxy-ep|st|sig|chat|8kp|ol|rt|mcp|ccr|malfil|mu|mp|mai|edp|ip)=([^;\s"]+)/g;

export function redactSecrets(input: string): string {
    if (!input) return input;
    return input
        .replace(RE_BEARER, "$1<redacted>")
        .replace(RE_TOKEN_HEADER, "$1<redacted>")
        .replace(RE_GH_TOKEN, "<redacted-gh-token>")
        .replace(RE_LEGACY_PAT, "<redacted-pat>")
        .replace(RE_COPILOT_SEMI, (_m, _v, offset: number, whole: string) => {
            const key = whole.slice(offset, whole.indexOf("=", offset));
            return `${key}=<redacted>`;
        });
}
