import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { mockApi } from "./mock-api";

export default defineConfig({
  plugins: [react(), mockApi()],
});
