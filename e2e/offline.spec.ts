// 離線測試：Service Worker 快取網頁與模板資料後，斷網仍可開啟乘客端與站務端。
import { expect, test } from '@playwright/test';

test('PWA：斷網後仍可使用（含模板資料）', async ({ page, context }) => {
  await page.goto('/#/rx');
  await expect(page.getByTestId('start')).toBeVisible();
  // 等 Service Worker 安裝完成並接管頁面
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise((r) =>
        navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }),
      );
  });

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('start')).toBeVisible();

  // 站務端需要模板庫與站點資料：離線也要載入成功
  await page.goto('/#/station');
  await expect(page.getByTestId('template-select')).toBeVisible();
  await expect(page.getByTestId('template-select')).toContainText('列車延誤');
  await expect(page.getByRole('alert')).toHaveCount(0);
});
