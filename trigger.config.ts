import { defineConfig } from '@trigger.dev/sdk/v3'

// Project ref is read from env so the same config works across Model A
// (managed) and Model B (self-hosted) deployments without hardcoding.
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_ID ?? '',
  dirs: ['./src/trigger'],
  maxDuration: 60,
})