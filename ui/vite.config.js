import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Lets the dev server read ckb-dex/deployment/*.json (one level up), the same
    // deployment records the backend and offchain scripts use.
    fs: { allow: [".."] },
  },
});
