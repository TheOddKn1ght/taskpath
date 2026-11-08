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
  const response = await page.request.get('/test-account?fresh=1');
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
  const { userId } = await (await page.request.get('/test-account?fresh=1')).json();
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

test('reminders can be saved independently and survive clearing only the due date', async ({
  page,
}) => {
  test.setTimeout(30_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { userId } = await (await page.request.get('/test-account?fresh=1')).json();
  await page.goto('/');
  await page.locator('#unlock-user').fill(userId);
  await page.locator('#unlock-password').fill('browser harness password 2026');
  await page.locator('#unlock-submit').click();
  await expect(page.locator('#main')).toBeVisible();
  const title = `Reminder without due date ${Date.now()}`;
  await page.locator('#new-task').click();
  await page.locator('#task-title').fill(title);
  await page.locator('#task-schedule summary').click();
  const due = page.getByRole('checkbox', { name: 'Due date', exact: true });
  const reminder = page.getByRole('button', { name: /^Remind me:/ });
  await expect(due).not.toBeChecked();
  await expect(reminder).toBeVisible();
  await reminder.click();
  await page.getByRole('textbox', { name: 'Date (YYYY-MM-DD)', exact: true }).fill('2099-01-01');
  await page.getByRole('textbox', { name: 'Time (HH:mm)', exact: true }).fill('09:30');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const save = async () => {
    await page.locator('#save-task').click();
    await expect(page.locator('#task-dialog')).toHaveCount(0);
    await page.getByRole('button', { name: title, exact: true }).click();
  };
  await save();
  await expect(due).not.toBeChecked();
  await expect(reminder).toHaveText('2099-01-01 · 09:30');
  await due.check();
  await save();
  await expect(due).toBeChecked();
  await due.uncheck();
  await expect(reminder).toHaveText('2099-01-01 · 09:30');
  await save();
  await expect(due).not.toBeChecked();
  await expect(reminder).toHaveText('2099-01-01 · 09:30');
  await due.check();
  await page.getByRole('button', { name: /^Due date:/ }).click();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(due).not.toBeChecked();
  await expect(reminder).toHaveText('2099-01-01 · 09:30');
  await page.getByRole('button', { name: 'Clear dates', exact: true }).click();
  await save();
  await page.locator('#task-schedule summary').click();
  await expect(due).not.toBeChecked();
  await expect(reminder).toHaveText('Choose date');
});

test('optional task timers pause, survive reload, work offline, and appear in scoped stats', async ({
  page,
}) => {
  test.setTimeout(30_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { userId } = await (await page.request.get('/test-account?fresh=1')).json();
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
  // Disconnect workers too; page request routing cannot block their sync traffic.
  await page.context().setOffline(true);
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

test('due reminders offer snooze durations and snooze offline', async ({ page, context }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { userId } = await (await page.request.get('/test-account?fresh=1')).json();
  await page.goto('/');
  await page.locator('#unlock-user').fill(userId);
  await page.locator('#unlock-password').fill('browser harness password 2026');
  await page.locator('#unlock-submit').click();
  await expect(page.locator('#main')).toBeVisible();
  await page.locator('#new-task').click();
  await page.locator('#task-title').fill('Snooze test');
  await page.locator('#task-schedule summary').click();
  await page.getByRole('button', { name: /^Remind me:/ }).click();
  await page.getByRole('textbox', { name: 'Date (YYYY-MM-DD)', exact: true }).fill('2020-01-01');
  await page.getByRole('textbox', { name: 'Time (HH:mm)', exact: true }).fill('09:30');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.locator('#save-task').click();
  const panel = page.locator('#reminder-panel');
  const duration = panel.getByRole('button', { name: 'Snooze duration for Snooze test' });
  const menu = page.getByRole('menu', { name: 'Snooze duration for Snooze test' });
  await expect(panel.locator('select')).toHaveCount(0);
  await expect(duration).toHaveText('10 minutes');
  await duration.click();
  await expect(menu.getByRole('menuitemradio')).toHaveText([
    '5 minutes',
    '10 minutes',
    '30 minutes',
    '1 hour',
    '3 hours',
    '24 hours',
  ]);
  await expect(
    menu.getByRole('menuitemradio', { name: '10 minutes', exact: true }),
  ).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('menuitemradio', { name: '10 minutes', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(duration).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitemradio', { name: '24 hours', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(menu.getByRole('menuitemradio', { name: '5 minutes', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(duration).toHaveText('30 minutes');
  await expect(duration).toBeFocused();
  await duration.click();
  await page.locator('#reminder-panel > .reminder-row > svg').click();
  await expect(menu).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 844 });
  await duration.click();
  const bounds = (await menu.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  await page.keyboard.press('Escape');
  await context.setOffline(true);
  await duration.click();
  await menu.getByRole('menuitemradio', { name: '1 hour', exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(duration).toHaveText('1 hour');
  await panel.getByRole('button', { name: 'Snooze', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await context.setOffline(false);
});

test('tag manager creates reusable names, merges assignments and deletes offline', async ({
  page,
  context,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { userId } = await (await page.request.get('/test-account?fresh=1')).json();
  await page.goto('/');
  await page.locator('#unlock-user').fill(userId);
  await page.locator('#unlock-password').fill('browser harness password 2026');
  await page.locator('[name="remember"]').check();
  await page.locator('#unlock-submit').click();
  await expect(page.locator('#save-status')).toContainText('All changes synced');
  const openManager = async () => {
    await page.locator('.app-menu').click();
    await page.getByRole('menuitem', { name: 'Manage tags…', exact: true }).click();
  };
  await openManager();
  const manager = page.locator('#tags-dialog');
  await manager.getByRole('textbox', { name: 'New tag name' }).fill('Reusable');
  await manager.getByRole('button', { name: 'Add tag', exact: true }).click();
  await expect(manager.getByRole('region', { name: 'Tag reusable', exact: true })).toContainText(
    '0 tasks',
  );
  await manager.getByRole('button', { name: 'Close Manage tags' }).click();
  await page.locator('#new-task').click();
  await page.locator('#task-title').fill('Managed tag task');
  await page.locator('#browse-tags').click();
  await page.getByRole('option', { name: 'reusable', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.locator('#task-tag-input').fill('target');
  await page.locator('#add-tag').click();
  await page.locator('#save-task').click();
  await expect(page.locator('#save-status')).toContainText('All changes synced');
  await page.waitForLoadState('networkidle');
  await context.setOffline(true);
  await openManager();
  await manager.getByRole('button', { name: 'Rename reusable', exact: true }).click();
  await manager.getByRole('textbox', { name: 'New name for reusable', exact: true }).fill('target');
  await manager.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(manager.getByRole('region', { name: 'Tag reusable', exact: true })).toHaveCount(0);
  await expect(manager.getByRole('region', { name: 'Tag target', exact: true })).toContainText(
    '1 task',
  );
  await manager.getByRole('button', { name: 'Delete target', exact: true }).click();
  await manager.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(manager.getByRole('region', { name: 'Tag target', exact: true })).toBeVisible();
  await manager.getByRole('button', { name: 'Delete target', exact: true }).click();
  await manager.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(manager.getByRole('region', { name: 'Tag target', exact: true })).toHaveCount(0);
  await manager.getByRole('textbox', { name: 'New tag name' }).fill('offline name');
  await manager.getByRole('button', { name: 'Add tag', exact: true }).click();
  await expect(
    manager.getByRole('region', { name: 'Tag offline name', exact: true }),
  ).toBeVisible();
  await context.setOffline(false);
  await manager.getByRole('button', { name: 'Close Manage tags' }).click();
  await expect(page.locator('#save-status')).toContainText('All changes synced');
  await page.reload();
  await expect(page.locator('#main')).toBeVisible();
  await openManager();
  await expect(
    manager.getByRole('region', { name: 'Tag offline name', exact: true }),
  ).toContainText('0 tasks');
  await expect(manager.getByRole('region', { name: 'Tag target', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const inputBounds = (await manager.getByRole('textbox', { name: 'New tag name' }).boundingBox())!;
  expect(inputBounds.x).toBeGreaterThanOrEqual(0);
  expect(inputBounds.x + inputBounds.width).toBeLessThanOrEqual(320);
  await manager.getByRole('button', { name: 'Close Manage tags' }).click();
  await page.locator('.app-menu').click();
  await page.getByRole('menuitem', { name: 'Nickname…', exact: true }).click();
  await page.locator('[name="nickname"]').fill('Tag keeper');
  await page.locator('#nickname-dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await openManager();
  await manager.getByRole('textbox', { name: 'New tag name' }).fill('kept');
  await manager.getByRole('button', { name: 'Add tag', exact: true }).click();
  await expect(manager.getByRole('region', { name: 'Tag kept', exact: true })).toBeVisible();
  await expect(
    manager.getByRole('region', { name: 'Tag offline name', exact: true }),
  ).toBeVisible();
  await expect(page.locator('#greeting')).toContainText('Tag keeper');
});
