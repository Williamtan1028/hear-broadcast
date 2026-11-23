import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

// 測試用 WAV 當作 Chrome 的假麥克風輸入（%noloop：播完不重複）；由 e2e/global-setup.ts 在測試開始前產生
const wav = resolve('e2e/fixtures/broadcast.wav');

const PORT = 4174;
/** 正式建置（含 Service Worker）的預覽伺服器，用於離線測試 */
const PREVIEW_PORT = 4175;

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 90_000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${PORT}`,
    permissions: ['microphone'],
    // 乘客端依手機語言自動選字幕語言：模擬台灣手機
    locale: 'zh-TW',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /offline/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            `--use-file-for-fake-audio-capture=${wav}%noloop`,
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
    {
      name: 'pwa-offline',
      testMatch: /offline/,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PREVIEW_PORT}` },
    },
  ],
  webServer: [
    {
      command: `npx vite --port ${PORT} --strictPort`,
      port: PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: `npx vite build && npx vite preview --port ${PREVIEW_PORT} --strictPort`,
      port: PREVIEW_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
