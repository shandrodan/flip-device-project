import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Device talks to the server through /ws on its own origin, so one port works
// everywhere (LAN, Tailscale, tunnels). Point SERVER_URL elsewhere if the server isn't local.
const target = process.env.SERVER_URL || "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/ws": { target, ws: true }, "/setup": target, "/health": target },
  },
  preview: { port: 5173, proxy: { "/ws": { target, ws: true } } },
});
