import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/_/",
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("monaco-editor")) return "monaco";
          if (id.includes("quill")) return "quill";
          if (id.includes("primereact") || id.includes("@primereact") || id.includes("primeicons")) return "primereact";
          if (id.includes("react-router") || id.includes("@remix-run")) return "router";
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/scheduler/")
          ) return "react-vendor";
          if (id.includes("jsonpath-plus")) return "jsonpath";
          if (id.includes("cron-parser") || id.includes("cronstrue") || id.includes("luxon")) return "cron";
          if (id.includes("zustand")) return "zustand";
          return "vendor";
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:8090",
    },
  },
});
