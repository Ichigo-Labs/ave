import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"test/tui/**", // TUI tests use Node.js test runner (node:test), not vitest
		],
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@ichigo\.moe\/ave\/ai\/oauth$/, replacement: resolve(__dirname, "src/ai/oauth.ts") },
			{ find: /^@ichigo\.moe\/ave\/ai$/, replacement: resolve(__dirname, "src/ai/index.ts") },
			{ find: /^@ichigo\.moe\/ave\/agent$/, replacement: resolve(__dirname, "src/agent/index.ts") },
			{ find: /^@ichigo\.moe\/ave\/tui$/, replacement: resolve(__dirname, "src/tui/index.ts") },
		],
	},
});
