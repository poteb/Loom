import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  base: "/",
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": { target: "http://127.0.0.1:3000", ws: true } } },
});
