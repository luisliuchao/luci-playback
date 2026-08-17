import { defineConfig } from "vite";

function previewAllowedHosts(): true | string[] {
  const hosts = (process.env.LUCI_PLAYBACK_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  if (hosts.includes("*")) {
    return true;
  }
  return hosts;
}

const bindHost = process.env.LUCI_PLAYBACK_BIND ?? "127.0.0.1";
const allowedHosts = previewAllowedHosts();

export default defineConfig({
  server: {
    host: bindHost,
    port: 5175,
    strictPort: true,
    open: process.env.CODER !== "true",
    allowedHosts,
  },
  preview: {
    host: bindHost,
    port: 5175,
    strictPort: true,
    allowedHosts,
  },
});
