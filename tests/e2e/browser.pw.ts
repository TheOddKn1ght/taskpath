import { test, expect } from '@playwright/test';
for (const [path, success] of [
  ['/checks', /ALL \d+ CHECKS PASSED/],
  ['/react-checks', /ALL \d+ REACT CHECKS PASSED/],
  ['/picker-checks', /ALL .*PASSED/],
] as const) {
  test(`built browser harness ${path}`, async ({ page }) => {
    // The harnesses assert dialog state synchronously; reduced motion keeps closes immediate.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(path);
    await page.waitForFunction(() => /ALL .*PASSED|\bFAIL\b/.test(document.querySelector('#result')?.textContent || ''), null, { timeout: 150_000 });
    const output = await page.locator('#result').innerText();
    expect(output).not.toContain('FAIL');
    expect(output).toMatch(success);
  });
}

test('dismissed dialogs animate out before unmounting', async ({page}) => {
  await page.goto('/');
  const dialog = page.locator('#theme-dialog');
  for (const dismiss of [
    () => page.getByRole('button', {name:'Close Choose theme'}).click(),
    () => page.keyboard.press('Escape'),
  ]) {
    await page.locator('#unlock-theme').click();
    await expect(dialog).toBeVisible();
    await dialog.evaluate(d => Promise.all(d.getAnimations().map(a => a.finished)));
    await dismiss();
    await expect(dialog).toHaveClass(/\bclosing\b/);
    await expect(dialog).toHaveCount(0);
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.locator('#unlock-theme').click();
  await page.getByRole('button', {name:'Close Choose theme'}).click();
  await expect(dialog).toHaveCount(0, {timeout: 50});
});

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

test('phone layout fits five tabs and both new views without horizontal scroll', async ({page}) => {
  test.setTimeout(30_000);
  await page.setViewportSize({width: 390, height: 844});
  const {userId} = await (await page.request.get('/test-account')).json();
  await page.goto('/');
  await page.locator('#unlock-user').fill(userId);
  await page.locator('#unlock-password').fill('browser harness password 2026');
  await page.locator('#unlock-submit').click();
  await expect(page.locator('#main')).toBeVisible();
  const tabs = page.locator('#sidebar nav button');
  await expect(tabs).toHaveCount(5);
  for (const tab of await tabs.all()) {
    const box = (await tab.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  const noHorizontalScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  await page.locator('[data-view="calendar"]').click();
  await expect(page.locator('.month-grid')).toBeVisible();
  await expect(page.locator('.month-chips').first()).toBeHidden();
  expect(await noHorizontalScroll()).toBe(true);
  await page.getByRole('button', {name:'Week', exact:true}).click();
  await expect(page.locator('.week-day')).toHaveCount(7);
  expect(await page.locator('.week-grid').evaluate(g => getComputedStyle(g).gridTemplateColumns.split(' ').length)).toBe(1);
  expect(await noHorizontalScroll()).toBe(true);
  await page.locator('[data-view="stats"]').click();
  await expect(page.locator('#stats-view')).toBeVisible();
  expect(await page.locator('.stat-tiles').first().evaluate(g => getComputedStyle(g).gridTemplateColumns.split(' ').length)).toBe(2);
  expect(await noHorizontalScroll()).toBe(true);
});
