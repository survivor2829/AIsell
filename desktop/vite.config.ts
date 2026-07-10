import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: process.env.VITE_XIAOXI_EDITION === "development" ? "dist-development" : "dist"
  },
  server: {
    host: "127.0.0.1",
    port: 5173
  }
});
