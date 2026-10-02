import { test, expect } from '@playwright/test';
for (const [path, success] of [
  ['/checks', /ALL \d+ CHECKS PASSED/],
  ['/react-checks', /ALL \d+ REACT CHECKS PASSED/],
  ['/picker-checks', /ALL .*PASSED/],
] as const) {
  test(`built browser harness ${path}`, async ({ page }) => {
    await page.goto(path);
    await page.waitForFunction(() => /ALL .*PASSED|\bFAIL\b/.test(document.querySelector('#result')?.textContent || ''), null, { timeout: 150_000 });
    const output = await page.locator('#result').innerText();
    expect(output).not.toContain('FAIL');
    expect(output).toMatch(success);
  });
}

test('automatic lock expires in the background and prevents remembered reopening', async ({page}) => {
  test.setTimeout(30_000);
  const response = await page.request.get('/test-account');
  const {userId} = await response.json();
  await page.goto('/');
  await page.locator('#unlock-user').fill(userId);
  await page.locator('#unlock-password').fill('browser harness password 2026');
  await page.locator('[name="remember"]').check();
  await page.locator('#unlock-submit').click();
  await expect(page.locator('#main')).toBeVisible();
  await expect(page.locator('#save-status')).toContainText('All changes synced');
  await page.evaluate(() => {
    document.addEventListener('scroll', e => console.log('SCROLL', (e.target as Element)?.nodeName, window.scrollY), true);
    window.addEventListener('resize', () => console.log('RESIZE'));
  });
  page.on('console', msg => console.log(msg.text()));
  await page.locator('.app-menu').click();
  await page.getByRole('menuitem', {name:'Automatic locking…', exact:true}).click();
  await page.locator('#auto-lock-interval').selectOption('1');
  await page.getByRole('button', {name:'Save locking preference'}).click();
  await page.clock.install();
  await page.clock.fastForward(61_000);
  await expect(page.locator('#unlock-form')).toBeVisible();
  await page.reload();
  await expect(page.locator('#unlock-form')).toBeVisible();
  await expect(page.locator('#main')).toHaveCount(0);
  // A remembered browser closed before its timer fired must also expire on reopening.
  await page.locator('#unlock-password').fill('browser harness password 2026');
  await page.locator('[name="remember"]').check();
  await page.locator('#unlock-submit').click();
  await expect(page.locator('#main')).toBeVisible();
  await page.evaluate(() => localStorage.setItem('taskpath-last-activity', String(Date.now() - 120_000)));
  await page.reload();
  await expect(page.locator('#unlock-form')).toBeVisible();
  await expect(page.locator('#main')).toHaveCount(0);
});
