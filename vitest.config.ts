import { defineConfig } from "vitest/config"

// Its own file, so Vitest does not pick up vite.config.ts: the Cloudflare plugin there builds
// the Worker, and the suite runs the handler under plain Node with fetch and KV stubbed.
export default defineConfig({ test: {} })
