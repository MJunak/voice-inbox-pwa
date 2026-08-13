import { defineConfig, devices } from "@playwright/test";

// E2E-Setup für die Voice Inbox.
// - Startet bei Bedarf den Dev-Server (bzw. nutzt einen laufenden weiter).
// - Screenshots landen unter e2e/screens/ (via screenshots.spec.ts), damit man
//   das visuelle Ergebnis vor dem Commit selbst prüfen kann.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e/report" }]],
  outputDir: "e2e/artifacts",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 900 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
