import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { mockApi } from "./mock-api";

export default defineConfig({
  plugins: [vue(), mockApi()],
});
