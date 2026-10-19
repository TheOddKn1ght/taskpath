import { test, expect, type Page } from '@playwright/test';

async function unlock(page: Page, userId: string) {
  await page.locator('#unlock-user').fill(userId);
  await page.locator('#unlock-password').fill('browser harness password 2026');
  await page.locator('#unlock-submit').click();
  await expect(page.locator('#main')).toBeVisible();
  await expect(page.locator('#save-status')).toContainText('All changes synced');
}

async function savedChange(page: Page, action: () => Promise<unknown>) {
  const before = page.url();
  await action();
  await expect.poll(() => page.url()).not.toBe(before);
}

test('a draft preserves the second occurrence of a repeated local reminder hour across devices', async ({ page, browser }) => {
  const response = await page.request.get('/test-account');
  const { userId } = await response.json() as { userId: string };
  const sourceDevice = await browser.newContext({ timezoneId: 'UTC', reducedMotion: 'reduce' });
  const receivingDevice = await browser.newContext({ timezoneId: 'America/New_York', reducedMotion: 'reduce' });
  try {
    const source = await sourceDevice.newPage();
    source.on('dialog', dialog => dialog.accept());
    await source.goto(new URL(response.url()).origin);
    await unlock(source, userId);
    await expect.poll(() => new URL(source.url()).hash).toMatch(/^#state=v1\./);
    await savedChange(source, () => source.locator('#new-task').click());
    const title = 'URL_REPEATED_HOUR_' + Date.now().toString(36);
    await savedChange(source, () => source.locator('#task-title').fill(title));
    await source.locator('#task-schedule summary').click();
    await source.getByRole('button', { name: 'Remind me: Choose date', exact: true }).click();
    const picker = source.locator('dialog.picker-surface');
    await picker.getByRole('textbox', { name: 'Date (YYYY-MM-DD)', exact: true }).fill('2026-11-01');
    await picker.getByRole('textbox', { name: 'Time (HH:mm)', exact: true }).fill('06:30');
    await savedChange(source, () => picker.getByRole('button', { name: 'Apply', exact: true }).click());

    const receiving = await receivingDevice.newPage();
    receiving.on('dialog', dialog => dialog.accept());
    await receiving.goto(source.url());
    await expect(receiving.locator('#task-dialog')).toHaveCount(0);
    await unlock(receiving, userId);
    await expect(receiving.locator('#task-title')).toHaveValue(title);
    await receiving.locator('#task-schedule summary').click();
    await expect(receiving.getByRole('button', { name: 'Remind me: 2026-11-01 · 01:30', exact: true })).toBeVisible();
    await receiving.locator('#save-task').click();
    await expect(receiving.locator('#task-dialog')).toHaveCount(0);
    await expect(receiving.locator('.task-card').filter({ hasText: title }).locator('time')).toHaveAttribute('datetime', '2026-11-01T06:30:00.000Z');
  } finally {
    await sourceDevice.close();
    await receivingDevice.close();
  }
});
