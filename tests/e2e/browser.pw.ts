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
    await page.waitForFunction(
      () => /ALL .*PASSED|\bFAIL\b/.test(document.querySelector('#result')?.textContent || ''),
      null,
      { timeout: 150_000 },
    );
    const output = await page.locator('#result').innerText();
    expect(output).not.toContain('FAIL');
    expect(output).toMatch(success);
  });
}

test('dismissed dialogs animate out before unmounting', async ({ page }) => {
  await page.goto('/');
  const dialog = page.locator('#theme-dialog');
  for (const dismiss of [
    () => page.getByRole('button', { name: 'Close Choose theme' }).click(),
    () => page.keyboard.press('Escape'),
  ]) {
    await page.locator('#unlock-theme').click();
    await expect(dialog).toBeVisible();
    await dialog.evaluate((d) => Promise.all(d.getAnimations().map((a) => a.finished)));
    await dismiss();
    await expect(dialog).toHaveClass(/\bclosing\b/);
    await expect(dialog).toHaveCount(0);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#unlock-theme').click();
  await page.getByRole('button', { name: 'Close Choose theme' }).click();
  await expect(dialog).toHaveCount(0, { timeout: 50 });
});

test('automatic lock expires in the background and prevents remembered reopening', async ({
  page,
}) => {
  test.setTimeout(30_000);
  const response = await page.request.get('/test-account');
  const { userId } = await response.json();
  await page.goto('/');
  await page.locator('#unlock-user').fill(userId);
  await page.locator('#unlock-password').fill('browser harness password 2026');
  await page.locator('[name="remember"]').check();
  await page.locator('#unlock-submit').click();
  await expect(page.locator('#main')).toBeVisible();
  await expect(page.locator('#save-status')).toContainText('All changes synced');
  await page.evaluate(() => {
    document.addEventListener(
      'scroll',
      (e) => console.log('SCROLL', (e.target as Element)?.nodeName, window.scrollY),
      true,
    );
    window.addEventListener('resize', () => console.log('RESIZE'));
  });
  page.on('console', (msg) => console.log(msg.text()));
  await page.locator('.app-menu').click();
  await page.getByRole('menuitem', { name: 'Automatic locking…', exact: true }).click();
  await page.locator('#auto-lock-interval').selectOption('1');
  await page.getByRole('button', { name: 'Save locking preference' }).click();
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
  await page.evaluate(() =>
    localStorage.setItem('taskpath-last-activity', String(Date.now() - 120_000)),
  );
  await page.reload();
  await expect(page.locator('#unlock-form')).toBeVisible();
  await expect(page.locator('#main')).toHaveCount(0);
});

test('phone layout fits six tabs and task views without horizontal scroll', async ({ page }) => {
  test.setTimeout(30_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const { userId } = await (await page.request.get('/test-account')).json();
  await page.goto('/');
  await page.locator('#unlock-user').fill(userId);
  await page.locator('#unlock-password').fill('browser harness password 2026');
  await page.locator('#unlock-submit').click();
  await expect(page.locator('#main')).toBeVisible();
  const tabs = page.locator('#sidebar nav button');
  await expect(tabs).toHaveCount(6);
  for (const tab of await tabs.all()) {
    const box = (await tab.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  const noHorizontalScroll = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  await page.locator('[data-view="calendar"]').click();
  await expect(page.locator('.month-grid')).toBeVisible();
  await expect(page.locator('.month-chips').first()).toBeHidden();
  expect(await noHorizontalScroll()).toBe(true);
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(page.locator('.week-day')).toHaveCount(7);
  expect(
    await page
      .locator('.week-grid')
      .evaluate((g) => getComputedStyle(g).gridTemplateColumns.split(' ').length),
  ).toBe(1);
  expect(await noHorizontalScroll()).toBe(true);
  await page.locator('[data-view="time"]').click();
  await expect(page.locator('#time-view')).toBeVisible();
  expect(await noHorizontalScroll()).toBe(true);
  await page.locator('[data-view="stats"]').click();
  await expect(page.locator('#stats-view')).toBeVisible();
  expect(
    await page
      .locator('.stat-tiles')
      .first()
      .evaluate((g) => getComputedStyle(g).gridTemplateColumns.split(' ').length),
  ).toBe(2);
  expect(await noHorizontalScroll()).toBe(true);
});

test('optional task timers pause, survive reload, work offline, and appear in scoped stats', async ({
  page,
}) => {
  test.setTimeout(30_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { userId } = await (await page.request.get('/test-account')).json();
  await page.goto('/');
  await page.locator('#unlock-user').fill(userId);
  await page.locator('#unlock-password').fill('browser harness password 2026');
  await page.locator('[name="remember"]').check();
  await page.locator('#unlock-submit').click();
  await expect(page.locator('#main')).toBeVisible();
  const title = `Tracked task ${Date.now()}`;
  const later = page.locator('.column.later');
  await later.getByRole('button', { name: 'Add task', exact: true }).click();
  await later.getByRole('textbox', { name: 'Quick add task to Later' }).fill(title);
  await later.getByRole('button', { name: 'Save task to Later' }).click();
  const card = page
    .locator('.task-card')
    .filter({ has: page.getByRole('button', { name: title, exact: true }) });
  await expect(card).toBeVisible();
  const contextTitle = `Right-click tracked task ${Date.now()}`;
  await later.getByRole('textbox', { name: 'Quick add task to Later' }).fill(contextTitle);
  await later.getByRole('button', { name: 'Save task to Later' }).click();
  const contextCard = page
    .locator('.task-card')
    .filter({ has: page.getByRole('button', { name: contextTitle, exact: true }) });
  // This shared account can have many tasks. Let scrolling settle before opening
  // the context menu, which deliberately dismisses on scroll.
  await contextCard.scrollIntoViewIfNeeded();
  await contextCard.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await contextCard.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add to time tracking', exact: true }).click();
  await expect(
    contextCard.getByRole('button', { name: `Track time for ${contextTitle}` }),
  ).toContainText('0h 00m 00s');
  await expect(page.locator('#board')).toBeVisible();
  await contextCard.click({ button: 'right' });
  await expect(
    page.getByRole('menuitem', { name: 'Add to time tracking', exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  const completedTitle = `Completed without timer ${Date.now()}`;
  const archivedTitle = `Archived without timer ${Date.now()}`;
  for (const extraTitle of [completedTitle, archivedTitle]) {
    await later.getByRole('textbox', { name: 'Quick add task to Later' }).fill(extraTitle);
    await later.getByRole('button', { name: 'Save task to Later' }).click();
    const extraCard = page
      .locator('.task-card')
      .filter({ has: page.getByRole('button', { name: extraTitle, exact: true }) });
    if (extraTitle === completedTitle) {
      await extraCard.getByRole('button', { name: `Complete ${extraTitle}`, exact: true }).click();
    } else {
      await extraCard.getByRole('button', { name: `More options for ${extraTitle}` }).click();
      await page.getByRole('menuitem', { name: 'Archive task', exact: true }).click();
    }
  }
  await page.getByRole('button', { name: 'Time tracking', exact: true }).click();
  await expect(page.locator('#time-view')).toBeVisible();
  const contextTimer = page
    .locator('.time-task')
    .filter({ has: page.getByRole('heading', { name: contextTitle, exact: true }) });
  await expect(contextTimer).toContainText('Ready to start');
  await expect(contextTimer.getByLabel('Tracked time')).toHaveText('0h 00m 00s');
  for (const extraTitle of [completedTitle, archivedTitle]) {
    const extraRow = page
      .locator('.time-task')
      .filter({ has: page.getByRole('heading', { name: extraTitle, exact: true }) });
    await expect(extraRow).toHaveCount(0);
  }
  const dialog = page
    .locator('.time-task')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await expect(dialog).toHaveCount(0);
  const picker = page.getByRole('combobox', { name: 'Add task to track' });
  await picker.selectOption({ label: title });
  await page.getByRole('button', { name: 'Add to tracking', exact: true }).click();
  await expect(dialog).toContainText('Ready to start');
  await expect(dialog.getByLabel('Tracked time')).toHaveText('0h 00m 00s');
  await expect(picker.locator('option', { hasText: title })).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Find a task' }).fill(title);
  await dialog.getByRole('button', { name: `Start timer for ${title}`, exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: `Pause timer for ${title}`, exact: true }),
  ).toBeEnabled();
  await expect(page.locator('#save-status')).toContainText('All changes synced');
  await page.reload();
  await expect(page.locator('#time-view')).toBeVisible();
  await expect(dialog).toContainText('Running');
  await expect(page.locator('#save-status')).toContainText('All changes synced');
  await page.waitForLoadState('networkidle');
  await page.route('**/api/**', (route) => route.abort());
  await page.clock.install();
  await page.clock.fastForward(65_000);
  await expect(dialog.getByLabel('Tracked time')).toContainText('01m');
  await dialog.getByRole('button', { name: `Pause timer for ${title}`, exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: `Resume timer for ${title}`, exact: true }),
  ).toBeEnabled();
  const paused = await dialog.getByLabel('Tracked time').innerText();
  await page.clock.fastForward(60_000);
  await expect(dialog.getByLabel('Tracked time')).toHaveText(paused);
  await dialog.getByRole('button', { name: `Resume timer for ${title}`, exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: `Pause timer for ${title}`, exact: true }),
  ).toBeEnabled();
  await page.clock.fastForward(10_000);
  await dialog.getByRole('button', { name: `Pause timer for ${title}`, exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: `Resume timer for ${title}`, exact: true }),
  ).toBeEnabled();
  let total = await dialog.getByLabel('Tracked time').innerText();
  expect(total).not.toBe(paused);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole('button', { name: 'Time tracking', exact: true })).toBeVisible();
    for (const tab of await page.locator('#sidebar nav button').all()) {
      const box = (await tab.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const pickerBox = (await picker.boundingBox())!;
    expect(pickerBox.x).toBeGreaterThanOrEqual(0);
    expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(width);
    const control = await dialog
      .getByRole('button', { name: `Resume timer for ${title}`, exact: true })
      .boundingBox();
    expect(control!.height).toBeGreaterThanOrEqual(44);
    expect(control!.x + control!.width).toBeLessThanOrEqual(width);
    const completeControl = (await dialog
      .getByRole('button', { name: `Complete task ${title}`, exact: true })
      .boundingBox())!;
    expect(completeControl.height).toBeGreaterThanOrEqual(44);
    expect(completeControl.x + completeControl.width).toBeLessThanOrEqual(width);
  }
  await dialog.getByRole('button', { name: `Resume timer for ${title}`, exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: `Pause timer for ${title}`, exact: true }),
  ).toBeEnabled();
  await page.clock.fastForward(10_000);
  await dialog.getByRole('button', { name: `Complete task ${title}`, exact: true }).click();
  await expect(dialog).toContainText('Completed');
  await expect(dialog.getByRole('button')).toHaveCount(0);
  total = await dialog.getByLabel('Tracked time').innerText();
  await page.clock.fastForward(60_000);
  await expect(dialog.getByLabel('Tracked time')).toHaveText(total);
  await page.getByRole('button', { name: 'Stats', exact: true }).click();
  const row = page.locator('.tracking-table tbody tr').filter({ hasText: title });
  await expect(row).toContainText(total);
  await expect(row).toContainText('Paused');
  await page.evaluate(() => {
    location.hash = '#stats?category=work';
  });
  await expect(page.locator('#stats-view')).toContainText('Showing Work tasks.');
  await expect(row).toHaveCount(0);
  await page.evaluate(() => {
    location.hash = '#stats?category=personal';
  });
  await expect(row).toContainText(total);
});
