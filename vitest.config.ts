import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Two projects, not one flipped-environment suite: the Worker route tests need
// `environment: "node"` and Workers-shaped globals (see tests/compat-upstream-shapes.test.ts),
// while component tests need a DOM. `test.projects` (the workspace replacement as of Vitest 3)
// isolates environment and setupFiles per glob so neither suite leaks into the other — a global
// `setupFiles` would otherwise run the jsdom setup (jest-dom matchers, RTL cleanup) against the
// node project too, where `document` doesn't exist.
export default defineConfig({
	test: {
		projects: [
			{
				extends: true,
				test: {
					name: "node",
					environment: "node",
					include: ["tests/**/*.test.ts"],
				},
			},
			{
				extends: true,
				plugins: [react()],
				test: {
					name: "component",
					environment: "jsdom",
					include: ["tests/components/**/*.test.tsx"],
					setupFiles: ["tests/components/setup.ts"],
				},
			},
		],
	},
});
