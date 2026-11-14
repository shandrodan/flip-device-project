import { defineConfig } from "vite";

// The Device previews the dev server through the Flip server at /preview/.
export default defineConfig({ base: "/preview/", server: { host: "127.0.0.1" } });
