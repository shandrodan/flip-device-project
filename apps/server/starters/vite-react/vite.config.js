import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Device previews the dev server through the Flip server at /preview/.
export default defineConfig({ plugins: [react()], base: "/preview/", server: { host: "127.0.0.1" } });
