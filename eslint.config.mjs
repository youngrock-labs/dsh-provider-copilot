// Flat ESLint config. Kept intentionally lean; strictness comes from tsc.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
    { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: "module",
            globals: { console: "readonly", process: "readonly", fetch: "readonly" },
        },
        rules: {
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
            "@typescript-eslint/consistent-type-imports": "error",
            "no-console": "off",
            eqeqeq: ["error", "always"],
        },
    },
];
