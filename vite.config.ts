import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `bun run dev:ui` serves the UI with hot reload against a local server (`bun entry/server.ts` on 8796, or LOGBOOK_API).
const server = process.env.LOGBOOK_API ?? "http://localhost:8796";

export default defineConfig({
  plugins: [react()],
  server: { proxy: Object.fromEntries(["/api", "/mcp", "/files", "/openapi.json"].map((p) => [p, server])) },
});
