import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.PAGES_BASE_PATH || "/",
  plugins: [react()],
  build: {
    outDir: "dist-pages",
  },
});
