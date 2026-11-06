import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://127.0.0.1:8765",
    ...devices["Desktop Chrome"]
  },
  webServer: {
    command: "python -m tachie_motion.web.cli --port 8765",
    url: "http://127.0.0.1:8765/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 30000
  }
});
