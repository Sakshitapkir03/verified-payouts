import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Tests run outside React Server Components, where the real
      // server-only entry throws on import.
      "server-only": fileURLToPath(
        new URL("./node_modules/server-only/empty.js", import.meta.url),
      ),
    },
  },
  test: {
    // Database tests take table locks (ALTER TABLE) and the audit advisory
    // lock inside their transactions; running files in parallel could
    // deadlock them.
    fileParallelism: false,
  },
});
