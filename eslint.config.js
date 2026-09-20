import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
	// web/public/docs/ holds the Swagger UI bundles copied in by `npm run build` (gitignored,
	// vendor code) — linting them after a build produced thousands of errors, and CI, which
	// builds before it lints, failed on them.
	{ ignores: ["web/dist/", "web/public/docs/", "dist/", ".wrangler/", ".tsbuild/", "node_modules/", "worker-configuration.d.ts"] },
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
