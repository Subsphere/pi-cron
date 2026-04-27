import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["cron.test.ts"],
		environment: "node",
	},
});
