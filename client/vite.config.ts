import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative, so the built files load from anywhere: an unpacked folder, a
  // file:// URL inside the Mac shell, or a plain static host. Absolute paths
  // would pin every asset to the server root, which the desktop app has none
  // of.
  base: "./",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // 5173 is taken on this machine.
    port: 5174,
    strictPort: true,
  },
  test: {
    // Component tests render a route and read what is on screen; the seam is
    // storage, never a component's internals.
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
