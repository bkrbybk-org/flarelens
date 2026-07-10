import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
	{ ignores: ["web/dist/", "dist/", ".wrangler/", ".tsbuild/", "node_modules/", "worker-configuration.d.ts"] },
	...tseslint.configs.recommended,
	{
		files: ["web/src/**/*.{ts,tsx}"],
		plugins: { "react-hooks": reactHooks },
		rules: reactHooks.configs.recommended.rules,
	},
	{
		rules: {
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", ignoreRestSiblings: true }],
			"@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
		},
	},
);
