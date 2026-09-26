import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

// Browser specs end in .pw.ts: `bun test` claims every *.spec.ts and *.test.ts file.
const executablePath = process.env.CHROMIUM_PATH

export default defineConfig({
  testDir: '.',
  testMatch: '*.pw.ts',
  outputDir: join(tmpdir(), 'mamoru-playwright'),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: process.env.MAMORU_BASE_URL ?? 'https://app.mamoru.lol',
    browserName: 'chromium',
    trace: 'retain-on-failure',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  ],
})
