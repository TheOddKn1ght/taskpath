import { test, expect, type Page } from '@playwright/test';

const password = 'browser harness password 2026';
const stateFragment = /^#state=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('dialog', dialog => dialog.accept());
});

async function signIn(page: Page) {
  const accounts = await (await page.request.get('/test-account')).json() as { userId: string; secondUserId: string };
  await page.goto('/');
  await page.locator('#unlock-user').fill(accounts.userId);
  await unlock(page, password, true);
  await expect(page.locator('#save-status')).toContainText('All changes synced');
  return accounts;
}

async function unlock(page: Page, secret: string, remember = false) {
  await page.locator('#unlock-password').fill(secret);
  if (remember) await page.locator('[name="remember"]').check();
  await page.locator('#unlock-submit').click();
  await expect(page.locator('#main')).toBeVisible();
}

async function changeState(page: Page, action: () => Promise<unknown>) {
  const before = new URL(page.url()).hash;
  await action();
  await expect.poll(() => new URL(page.url()).hash).not.toBe(before);
  await expect.poll(() => new URL(page.url()).hash).toMatch(stateFragment);
  return page.url();
}

async function choose(page: Page, selector: string, option: string) {
  await page.locator(selector).click();
  await page.locator('dialog.picker-surface').getByRole('option', { name: option, exact: true }).click();
}

async function workspaceOption(page: Page, option: string) {
  await page.locator('.app-menu').click();
  await page.getByRole('menuitem', { name: option, exact: true }).click();
}

function captureRequests(page: Page) {
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url() + '\n' + (request.postData() || '')));
  return requests;
}

async function expectPrivate(page: Page, requests: string[], markers: string[]) {
  const surfaces = await page.evaluate(() => JSON.stringify({
    url: location.href,
    history: history.state,
    local: { ...localStorage },
    session: { ...sessionStorage },
  }));
  for (const marker of markers) {
    for (const representation of [marker, encodeURIComponent(marker), JSON.stringify(marker).slice(1, -1)]) {
      expect(surfaces).not.toContain(representation);
      expect(requests.join('\n')).not.toContain(representation);
    }
  }
}

async function createTask(page: Page, title: string, tag: string) {
  await page.locator('#new-task').click();
  await page.locator('#task-title').fill(title);
  await page.locator('#task-tag-input').fill(tag);
  await page.locator('#add-tag').click();
  await choose(page, '#task-dialog button[aria-label^="Category:"]', 'Work');
  await page.locator('#save-task').click();
  await expect(page.locator('#task-dialog')).toHaveCount(0);
  await expect(page.locator('.task-card').filter({ hasText: title })).toHaveCount(1);
}

test('encrypted URL restores board and search filters after reload and explicit locking', async ({ page }) => {
  const requests = captureRequests(page);
  await signIn(page);
  const stamp = Date.now().toString(36);
  const title = 'URL_PRIVATE_TASK_' + stamp;
  const tag = 'url-private-tag-' + stamp;
  const query = 'URL_PRIVATE_QUERY_' + stamp + ' café 日本語';
  await createTask(page, title, tag);

  await changeState(page, () => choose(page, '#category-filter', 'Work'));
  await changeState(page, () => choose(page, '#tag-filter', tag));
  await changeState(page, () => page.locator('#focus-today').click());
  await page.reload();
  await expect(page.locator('#category-filter')).toHaveText('Work');
  await expect(page.locator('#tag-filter')).toHaveText(tag);
  await expect(page.locator('#focus-today')).toHaveAttribute('aria-pressed', 'true');

  await changeState(page, () => page.locator('#open-search').click());
  await page.getByRole('button', { name: /^Filters/ }).click();
  await changeState(page, () => choose(page, '#search-filter-scope', 'Archived'));
  await changeState(page, () => choose(page, '#search-filter-category', 'Work'));
  await changeState(page, () => page.locator('.task-search-tags').getByLabel(tag, { exact: true }).check());
  await changeState(page, () => page.locator('#search').fill(query));
  await expectPrivate(page, requests, [title, tag, query]);

  await page.reload();
  await expect(page.locator('#search')).toHaveValue(query);
  await expect(page.getByRole('button', { name: 'Remove filter Archived', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove filter Work', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove filter #' + tag, exact: true })).toBeVisible();
  await changeState(page, () => page.getByRole('button', { name: 'Close Search tasks', exact: true }).click());
  await workspaceOption(page, 'Lock');
  await expect(page.locator('#unlock-form')).toBeVisible();
  await expect(page.locator('#main')).toHaveCount(0);
  await expectPrivate(page, requests, [title, tag, query]);
  await unlock(page, password);
  await expect(page.locator('#tag-filter')).toHaveText(tag);
  await expect(page.locator('#focus-today')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#open-search').click();
  await expect(page.locator('#search')).toHaveValue(query);
  await expect(page.getByRole('button', { name: 'Remove filter Archived', exact: true })).toBeVisible();
  await expectPrivate(page, requests, [title, tag, query]);
});

test('calendar position and file search survive reload and browser history', async ({ page }) => {
  const requests = captureRequests(page);
  await signIn(page);
  await changeState(page, () => page.locator('[data-view="calendar"]').click());
  await changeState(page, () => page.getByRole('button', { name: 'Next month', exact: true }).click());
  await changeState(page, () => page.locator('.month-day').nth(14).click());
  const selectedDay = await page.locator('#calendar-agenda-title').innerText();
  const month = await page.locator('#calendar-title').innerText();
  await page.reload();
  await expect(page.locator('#calendar-title')).toHaveText(month);
  await expect(page.locator('#calendar-agenda-title')).toHaveText(selectedDay);
  await expect(page.locator('.month-day[aria-pressed="true"] .month-day-number')).toHaveText('15');
  await changeState(page, () => page.getByRole('button', { name: 'Week', exact: true }).click());
  await changeState(page, () => page.getByRole('button', { name: 'Next week', exact: true }).click());
  const week = await page.locator('#calendar-title').innerText();
  await page.reload();
  await expect(page.locator('#calendar-view')).toHaveClass(/is-week/);
  await expect(page.locator('#calendar-title')).toHaveText(week);

  await changeState(page, () => page.locator('[data-view="files"]').click());
  const fileQuery = 'URL_PRIVATE_FILENAME_' + Date.now().toString(36);
  await changeState(page, () => page.getByRole('searchbox', { name: 'Search files', exact: true }).fill(fileQuery));
  await page.reload();
  await expect(page.getByRole('searchbox', { name: 'Search files', exact: true })).toHaveValue(fileQuery);
  await page.goBack();
  await expect(page.locator('#calendar-view')).toHaveClass(/is-week/);
  await expect(page.locator('#calendar-title')).toHaveText(week);
  await page.goForward();
  await expect(page.getByRole('searchbox', { name: 'Search files', exact: true })).toHaveValue(fileQuery);
  await expectPrivate(page, requests, [fileQuery]);
});

test('unfinished new and existing task edits stay encrypted through reload and locking', async ({ page, context }) => {
  const requests = captureRequests(page);
  await signIn(page);
  const stamp = Date.now().toString(36);
  const draftTitle = 'URL_PRIVATE_DRAFT_' + stamp;
  const draftNotes = 'URL_PRIVATE_NOTES_' + stamp + '\nUnfinished café 日本語';
  const pendingTag = 'url-private-pending-' + stamp;
  await changeState(page, () => page.locator('#new-task').click());
  await changeState(page, () => page.locator('#task-title').fill(draftTitle));
  await changeState(page, () => page.locator('#task-notes').fill(draftNotes));
  await changeState(page, () => page.locator('#task-tag-input').fill(pendingTag));
  await page.reload();
  await expect(page.locator('#task-title')).toHaveValue(draftTitle);
  await expect(page.locator('#task-notes')).toHaveValue(draftNotes);
  await expect(page.locator('#task-tag-input')).toHaveValue(pendingTag);
  await expect(page.locator('#save-task')).toHaveText('Add task');
  await expectPrivate(page, requests, [draftTitle, draftNotes, pendingTag]);

  const lockingTab = await context.newPage();
  await lockingTab.goto('/');
  await expect(lockingTab.locator('#main')).toBeVisible();
  await workspaceOption(lockingTab, 'Lock');
  await expect(page.locator('#unlock-form')).toBeVisible();
  await expect(page.locator('#task-dialog')).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain(draftTitle);
  await lockingTab.close();
  await unlock(page, password);
  await expect(page.locator('#task-title')).toHaveValue(draftTitle);
  await expect(page.locator('#task-notes')).toHaveValue(draftNotes);
  await expect(page.locator('#task-tag-input')).toHaveValue(pendingTag);
  await expectPrivate(page, requests, [draftTitle, draftNotes, pendingTag]);
  await page.locator('#task-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await changeState(page, () => page.getByRole('button', { name: 'Discard changes', exact: true }).click());
  await expect(page.locator('.task-card').filter({ hasText: draftTitle })).toHaveCount(0);

  const originalTitle = 'URL_SAVED_ORIGINAL_' + stamp;
  await createTask(page, originalTitle, 'url-edit-' + stamp);
  await changeState(page, async () => {
    const card = page.locator('.task-card').filter({ hasText: originalTitle });
    await card.focus();
    await card.press('Enter');
  });
  await changeState(page, () => page.locator('#task-title').fill(draftTitle));
  await changeState(page, () => page.locator('#task-notes').fill(draftNotes));
  await page.reload();
  await unlock(page, password);
  await expect(page.locator('#task-title')).toHaveValue(draftTitle);
  await expect(page.locator('#task-notes')).toHaveValue(draftNotes);
  await expect(page.locator('#save-task')).toHaveText('Save changes');
  await page.locator('#task-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await changeState(page, () => page.getByRole('button', { name: 'Discard changes', exact: true }).click());
  await expect(page.locator('.task-card').filter({ hasText: originalTitle })).toHaveCount(1);
  await expect(page.locator('.task-card').filter({ hasText: draftTitle })).toHaveCount(0);
  await expectPrivate(page, requests, [draftTitle, draftNotes, pendingTag]);
});

test('tampered and another account\'s encrypted state fall back without exposing private state', async ({ page }) => {
  const requests = captureRequests(page);
  const accounts = await signIn(page);
  const query = 'URL_PRIVATE_ACCOUNT_A_' + Date.now().toString(36);
  await changeState(page, () => page.locator('#open-search').click());
  const privateUrl = await changeState(page, () => page.locator('#search').fill(query));
  const tampered = new URL(privateUrl);
  const position = Math.floor((tampered.hash.lastIndexOf('.') + tampered.hash.length) / 2);
  tampered.hash = tampered.hash.slice(0, position) + (tampered.hash[position] === 'A' ? 'B' : 'A') + tampered.hash.slice(position + 1);
  await page.goto(tampered.href);
  await expect(page.locator('#main')).toBeVisible();
  await expect(page.locator('[data-view="board"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#search')).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain(query);

  await page.goto(privateUrl);
  await expect(page.locator('#search')).toHaveValue(query);
  await page.getByRole('button', { name: 'Close Search tasks', exact: true }).click();
  await workspaceOption(page, 'Switch account');
  await expect(page.locator('#unlock-user')).toHaveValue('');
  await page.locator('#unlock-user').fill(accounts.secondUserId);
  await unlock(page, 'browser second password 2026', true);
  await page.goto(privateUrl);
  await expect(page.locator('#main')).toBeVisible();
  await expect(page.locator('[data-view="board"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#search')).toHaveCount(0);
  await expect(page.locator('#task-dialog')).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain(query);
  await page.locator('#open-search').click();
  await expect(page.locator('#search')).toHaveValue('');
  await expectPrivate(page, requests, [query]);
});

test('quick-add drafts survive reload and Escape discards them durably', async ({ page }) => {
  const requests = captureRequests(page);
  await signIn(page);
  const title = 'URL_PRIVATE_QUICK_ADD_' + Date.now().toString(36);
  await changeState(page, async () => {
    const trigger = page.locator('.column[data-status="later"] .quick-add-trigger');
    await trigger.focus();
    await trigger.press('Enter');
  });
  await changeState(page, () => page.getByRole('textbox', { name: 'Quick add task to Later', exact: true }).fill(title));
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Quick add task to Later', exact: true })).toHaveValue(title);
  await expectPrivate(page, requests, [title]);
  await changeState(page, () => page.getByRole('textbox', { name: 'Quick add task to Later', exact: true }).press('Escape'));
  await expect(page.locator('.quick-add')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#main')).toBeVisible();
  await expect(page.locator('.quick-add')).toHaveCount(0);
  await expect(page.locator('.task-card').filter({ hasText: title })).toHaveCount(0);
  await expectPrivate(page, requests, [title]);
});

type EncryptionHoldWindow = Window & { __heldUrlEncryption?: { ready: number; release: () => void } };

test('locking clears the UI while pending URL encryption safely preserves the latest draft', async ({ page, context }) => {
  const requests = captureRequests(page);
  await signIn(page);
  await changeState(page, () => page.locator('#new-task').click());
  const lockingTab = await context.newPage();
  await lockingTab.goto('/');
  await expect(lockingTab.locator('#main')).toBeVisible();
  const before = new URL(page.url()).hash;
  await page.evaluate(() => {
    const original = crypto.subtle.encrypt;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const hold = {
      ready: 0,
      release: () => { crypto.subtle.encrypt = original; release(); },
    };
    (window as EncryptionHoldWindow).__heldUrlEncryption = hold;
    crypto.subtle.encrypt = async function (...args: Parameters<SubtleCrypto['encrypt']>) {
      const ciphertext = await original.apply(this, args);
      const additionalData = (args[0] as AesGcmParams).additionalData;
      if (additionalData && new TextDecoder().decode(additionalData).includes('taskpath:url-state')) {
        hold.ready++;
        await gate;
      }
      return ciphertext;
    };
  });
  const title = 'URL_PRIVATE_PENDING_ENCRYPTION_' + Date.now().toString(36);
  await page.locator('#task-title').fill(title);
  await expect.poll(() => page.evaluate(() => (window as EncryptionHoldWindow).__heldUrlEncryption?.ready || 0)).toBeGreaterThan(0);
  expect(new URL(page.url()).hash).toBe(before);
  await workspaceOption(lockingTab, 'Lock');
  await expect(page.locator('#unlock-form')).toBeVisible();
  await expect(page.locator('#main')).toHaveCount(0);
  await expect(page.locator('#task-dialog')).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain(title);
  await page.evaluate(() => (window as EncryptionHoldWindow).__heldUrlEncryption!.release());
  await expect.poll(() => new URL(page.url()).hash).not.toBe(before);
  await expect(page.locator('#unlock-form')).toBeVisible();
  await expect(page.locator('#main')).toHaveCount(0);
  await expect(page.locator('#task-dialog')).toHaveCount(0);
  await expectPrivate(page, requests, [title]);
  await lockingTab.close();
  await unlock(page, password);
  await expect(page.locator('#task-title')).toHaveValue(title);
  await expect(page.locator('#save-task')).toHaveText('Add task');
});

test('Back and Forward close and restore an unfinished task editor', async ({ page }) => {
  await signIn(page);
  await changeState(page, () => page.locator('#new-task').click());
  const title = 'URL_PRIVATE_HISTORY_DRAFT_' + Date.now().toString(36);
  await changeState(page, () => page.locator('#task-title').fill(title));
  await page.goBack();
  await expect(page.locator('#task-dialog')).toHaveCount(0);
  await expect(page.locator('[data-view="board"]')).toHaveAttribute('aria-current', 'page');
  await page.goForward();
  await expect(page.locator('#task-title')).toHaveValue(title);
  await expect(page.locator('#save-task')).toHaveText('Add task');
});
