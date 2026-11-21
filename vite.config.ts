import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("./ui", import.meta.url)),
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    target: "safari15",
    chunkSizeWarningLimit: 2000,
  },
});
