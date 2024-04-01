// @ts-check

import prettierConfig from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config({
    files: ["**/*.ts"],
    extends: [...tseslint.configs.stylisticTypeChecked, ...tseslint.configs.strictTypeChecked],
    rules: {
        ...prettierConfig.rules,
        "@typescript-eslint/naming-convention": "error",
        "@typescript-eslint/switch-exhaustiveness-check": "error",
        eqeqeq: "error",
        "no-throw-literal": "off",
        "@typescript-eslint/only-throw-error": "error",
        "no-shadow": "off",
        "@typescript-eslint/no-shadow": "error",
        "no-duplicate-imports": "error",
        "sort-imports": ["error", { allowSeparatedGroups: true }],
    },
    languageOptions: {
        parserOptions: {
            project: true,
            tsconfigRootDir: "__dirname",
        },
    },
});
