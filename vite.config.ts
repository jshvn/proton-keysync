import { cloudflare } from "@cloudflare/vite-plugin"
import { defineConfig } from "vite"

// cf builds and serves the Worker through Vite; the plugin reads cloudflare.config.ts.
export default defineConfig({ plugins: [cloudflare()] })
