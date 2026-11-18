import { defineConfig, devices } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeE2eWav } from './scripts/make-e2e-wav.ts';

// 測試用 WAV 當作 Chrome 的假麥克風輸入（%noloop：播完不重複）
mkdirSync('e2e/fixtures', { recursive: true });
const wav = resolve('e2e/fixtures/broadcast.wav');
writeFileSync(wav, makeE2eWav());

const PORT = 4174;

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${PORT}`,
    permissions: ['microphone'],
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
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
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
