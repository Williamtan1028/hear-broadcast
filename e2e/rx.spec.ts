// 測試 8：E2E。把產生的 WAV 當作麥克風輸入，驗證乘客端字幕、緊急畫面與月台篩選。
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { renderTemplate } from '../src/data/render.ts';
import type { StationsFile, TemplatePack } from '../src/data/schema.ts';
import { E2E_MESSAGES } from '../scripts/make-e2e-wav.ts';

const pack = JSON.parse(readFileSync('public/data/template-pack.json', 'utf8')) as TemplatePack;
const station = (JSON.parse(readFileSync('public/data/stations.json', 'utf8')) as StationsFile).stations[0];
const text = (i: number, lang: 'zh' | 'en' = 'zh') => {
  const m = E2E_MESSAGES[i].msg;
  if (m.type !== 'template') throw new Error('expected template');
  return renderTemplate(
    pack.templates.find((t) => t.id === m.templateId)!,
    m,
    station,
    lang,
  );
};

test('乘客端：收到廣播、月台篩選、緊急畫面', async ({ page }) => {
  await page.goto('/#/rx');
  await page.getByTestId('start').click();

  // 第 1 則（第 1 月台，強訊號）顯示在看板
  await expect(page.getByTestId('board-text')).toHaveText(text(0), { timeout: 30_000 });
  await expect(page.getByTestId('band')).toContainText('19.5 kHz');

  // 緊急廣播：全螢幕紅色、可被螢幕閱讀器立即讀出
  const emg = page.getByTestId('emergency');
  await expect(emg).toBeVisible({ timeout: 30_000 });
  await expect(emg).toContainText(text(2));
  await expect(emg).toHaveAttribute('aria-live', 'assertive');

  // 第 2 則（第 2 月台，弱訊號）有收到，但因月台判斷為第 1 月台而不顯示
  // 月台判斷顯示在主畫面（不能藏在折疊的「進階」裡）
  await expect(page.getByTestId('platform-status')).toBeVisible();
  await expect(page.getByTestId('platform-status')).toContainText('第 1 月台');
  const items = page.getByTestId('history-item');
  await expect(items).toHaveCount(3);
  await expect(page.locator('[data-testid="history-item"][data-shown="false"]')).toContainText(text(1));

  // 按「我知道了」才關閉
  await page.getByRole('button', { name: '我知道了' }).click();
  await expect(emg).toBeHidden();

  // 切換語言重新顯示
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByTestId('board-text')).toHaveText(text(2, 'en'));
});
