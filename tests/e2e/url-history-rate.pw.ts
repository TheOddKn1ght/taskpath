import { test, expect } from '@playwright/test';

test('rapid typing keeps the latest encrypted draft within browser history limits', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('dialog', dialog => dialog.accept());
  const { userId } = await (await page.request.get('/test-account')).json() as { userId: string };
  await page.goto('/');
  await page.locator('#unlock-user').fill(userId);
  await page.locator('#unlock-password').fill('browser harness password 2026');
  await page.locator('[name="remember"]').check();
  await page.locator('#unlock-submit').click();
  await expect(page.locator('#main')).toBeVisible();
  await expect(page.locator('#save-status')).toContainText('All changes synced');
  await page.locator('#new-task').click();

  const title = 'URL_PRIVATE_RAPID_DRAFT_' + 'abcdefghij'.repeat(13);
  await page.locator('#task-title').pressSequentially(title, { delay: 50 });
  await expect(page.locator('#task-title')).toHaveValue(title);
  await expect(page.locator('#error-banner')).toHaveCount(0);

  // One final edit gives the latest draft its own encrypted URL before reload.
  await page.locator('#task-notes').focus();
  const before = new URL(page.url()).hash;
  const notes = 'URL_PRIVATE_FINAL_DRAFT_BARRIER';
  await page.locator('#task-notes').fill(notes);
  await expect.poll(() => new URL(page.url()).hash).not.toBe(before);
  await expect.poll(() => new URL(page.url()).hash).toMatch(/^#state=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  await expect(page.locator('#error-banner')).toHaveCount(0);
  expect(page.url()).not.toContain(title);
  expect(page.url()).not.toContain(notes);

  await page.reload();
  await expect(page.locator('#task-title')).toHaveValue(title);
  await expect(page.locator('#task-notes')).toHaveValue(notes);
  await expect(page.locator('#save-task')).toHaveText('Add task');
  await expect(page.locator('#error-banner')).toHaveCount(0);
});
