import { test, expect, type Page } from '@playwright/test';

const password = 'browser harness password 2026';
const stateFragment = /^#state=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

test.beforeEach(async ({ page }) => {
  await prepare(page);
});

async function prepare(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('dialog', dialog => dialog.accept());
}

async function unlock(page: Page, userId: string, secret = password, remember = false) {
  await page.locator('#unlock-user').fill(userId);
  await page.locator('#unlock-password').fill(secret);
  if (remember) await page.locator('[name="remember"]').check();
  await page.locator('#unlock-submit').click();
  await expect(page.locator('#main')).toBeVisible();
  await expect(page.locator('#save-status')).toContainText('All changes synced');
}

async function signIn(page: Page) {
  const accounts = await (await page.request.get('/test-account')).json() as { userId: string; secondUserId: string };
  await page.goto('/');
  await unlock(page, accounts.userId, password, true);
  await expect.poll(() => new URL(page.url()).hash).toMatch(stateFragment);
  return accounts;
}

// Each update waits for its own ciphertext, so the copied link includes the
// final keystroke rather than an earlier asynchronous encryption result.
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
  page.on('request', request => requests.push(JSON.stringify({
    url: request.url(),
    body: request.postData(),
    referrer: request.headers().referer || '',
  })));
  return requests;
}

async function expectPrivate(page: Page, requests: string[], markers: string[]) {
  // Inspect the actual persistent records, including the key store, rather
  // than assuming that localStorage is the only browser persistence surface.
  const persisted = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('taskpath-accounts-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const records = await Promise.all(Array.from(db.objectStoreNames, name => new Promise<unknown>((resolve, reject) => {
        const request = db.transaction(name).objectStore(name).getAll();
        request.onsuccess = () => resolve({ name, values: request.result });
        request.onerror = () => reject(request.error);
      })));
      return JSON.stringify({
        url: location.href,
        history: history.state,
        referrer: document.referrer,
        local: { ...localStorage },
        session: { ...sessionStorage },
        records,
      });
    } finally {
      db.close();
    }
  });
  for (const marker of markers) {
    for (const representation of [marker, encodeURIComponent(marker), JSON.stringify(marker).slice(1, -1)]) {
      expect(persisted).not.toContain(representation);
      expect(requests.join('\n')).not.toContain(representation);
    }
  }
}

async function expectLocked(page: Page, markers: string[]) {
  await expect(page.locator('#unlock-form')).toBeVisible();
  await expect(page.locator('#main')).toHaveCount(0);
  await expect(page.locator('#task-dialog, #search, .quick-add')).toHaveCount(0);
  const dom = await page.content();
  for (const marker of markers) expect(dom).not.toContain(marker);
}

async function setDate(page: Page, label: string, date: string, time?: string) {
  await page.locator('#task-dialog').getByRole('button', { name: new RegExp('^' + label + ':') }).click();
  const picker = page.locator('dialog.picker-surface');
  await picker.getByRole('textbox', { name: 'Date (YYYY-MM-DD)', exact: true }).fill(date);
  if (time) await picker.getByRole('textbox', { name: 'Time (HH:mm)', exact: true }).fill(time);
  await changeState(page, () => picker.getByRole('button', { name: 'Apply', exact: true }).click());
}

test('a fresh device restores the complete encrypted draft only after unlocking the same vault', async ({ page, browser, context }) => {
  const requests = captureRequests(page);
  const accounts = await signIn(page);
  const stamp = Date.now().toString(36);
  const titleMarker = 'URL_DEVICE_DRAFT_' + stamp;
  const notesMarker = 'URL_DEVICE_NOTES_' + stamp;
  const title = titleMarker + ' <img src=x onerror="window.xss=1">';
  const notes = notesMarker + '\nUnfinished café 日本語\n<script>window.xss=1</script>';
  const pendingTag = 'url-device-pending-' + stamp;
  const literalTag = '<svg/onload=window.xss=1>';
  const quickTitle = 'URL_DEVICE_QUICK_' + stamp;
  const query = 'URL_DEVICE_SEARCH_' + stamp;
  const markers = [titleMarker, notesMarker, pendingTag, literalTag, quickTitle, query];

  await changeState(page, async () => {
    const trigger = page.locator('.column[data-status="later"] .quick-add-trigger');
    await trigger.focus();
    await trigger.press('Enter');
  });
  await changeState(page, () => page.getByRole('textbox', { name: 'Quick add task to Later', exact: true }).fill(quickTitle));
  await changeState(page, () => page.locator('#open-search').click());
  await changeState(page, () => page.locator('#search').fill(query));
  await changeState(page, () => page.getByRole('button', { name: 'Close Search tasks', exact: true }).click());
  await changeState(page, () => page.locator('[data-view="calendar"]').click());
  await changeState(page, () => page.getByRole('button', { name: 'Next month', exact: true }).click());
  await changeState(page, () => page.locator('.month-day').nth(14).click());
  const month = await page.locator('#calendar-title').innerText();
  const selectedDay = await page.locator('#calendar-agenda-title').innerText();

  await changeState(page, () => page.locator('#new-task').click());
  await changeState(page, () => page.locator('#task-title').fill(title));
  await changeState(page, () => page.locator('#task-notes').fill(notes));
  await changeState(page, () => page.locator('#task-tag-input').fill(literalTag));
  await changeState(page, () => page.locator('#add-tag').click());
  await changeState(page, () => choose(page, '#task-dialog button[aria-label^="Column:"]', 'This Week'));
  await changeState(page, () => choose(page, '#task-dialog button[aria-label^="Category:"]', 'Work'));
  await page.locator('#task-schedule summary').click();
  await setDate(page, 'Due date', '2031-07-23');
  await setDate(page, 'Remind me', '2031-07-22', '09:35');
  const privateUrl = await changeState(page, () => page.locator('#task-tag-input').fill(pendingTag));
  await page.evaluate(() => fetch('/test-account', { cache: 'no-store' }).then(response => response.json()));
  await expectPrivate(page, requests, markers);
  expect(await page.locator('#task-tags').innerText()).toContain(literalTag);
  await expect(page.locator('#task-tags svg, #task-tags img, #task-tags script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { xss?: number }).xss)).toBeUndefined();

  // Lock the source through another tab while the unfinished editor is open.
  const lockingTab = await context.newPage();
  await prepare(lockingTab);
  await lockingTab.goto(new URL('/', privateUrl).href);
  await expect(lockingTab.locator('#main')).toBeVisible();
  await workspaceOption(lockingTab, 'Lock');
  await expectLocked(page, markers);
  await expectPrivate(page, requests, markers);
  await lockingTab.close();

  const device = await browser.newContext();
  try {
    expect(await device.storageState()).toEqual({ cookies: [], origins: [] });
    const remote = await device.newPage();
    await prepare(remote);
    const remoteRequests = captureRequests(remote);
    await remote.goto(privateUrl);
    await expectLocked(remote, markers);
    await expectPrivate(remote, remoteRequests, markers);
    await unlock(remote, accounts.userId);
    await expect(remote.locator('#task-title')).toHaveValue(title);
    await expect(remote.locator('#task-notes')).toHaveValue(notes);
    await expect(remote.locator('#task-tag-input')).toHaveValue(pendingTag);
    await expect(remote.locator('#save-task')).toHaveText('Add task');
    await expect(remote.locator('#task-dialog button[aria-label="Column: This Week"]')).toBeVisible();
    await expect(remote.locator('#task-dialog button[aria-label="Category: Work"]')).toBeVisible();
    await expect(remote.locator('#task-tags').getByRole('button', { name: 'Remove tag ' + literalTag, exact: true })).toHaveText(literalTag + '×');
    await expect(remote.locator('#task-tags svg, #task-tags img, #task-tags script')).toHaveCount(0);
    expect(await remote.evaluate(() => (window as Window & { xss?: number }).xss)).toBeUndefined();
    await remote.locator('#task-schedule summary').click();
    await expect(remote.getByRole('button', { name: 'Due date: 2031-07-23', exact: true })).toBeVisible();
    await expect(remote.getByRole('button', { name: 'Remind me: 2031-07-22 · 09:35', exact: true })).toBeVisible();
    await expectPrivate(remote, remoteRequests, markers);

    await remote.locator('#task-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await changeState(remote, () => remote.getByRole('button', { name: 'Discard changes', exact: true }).click());
    await expect(remote.locator('#calendar-title')).toHaveText(month);
    await expect(remote.locator('#calendar-agenda-title')).toHaveText(selectedDay);
    await changeState(remote, () => remote.locator('#open-search').click());
    await expect(remote.locator('#search')).toHaveValue(query);
    await changeState(remote, () => remote.getByRole('button', { name: 'Close Search tasks', exact: true }).click());
    await changeState(remote, () => remote.locator('[data-view="board"]').click());
    await expect(remote.getByRole('textbox', { name: 'Quick add task to Later', exact: true })).toHaveValue(quickTitle);
    await expect(remote.locator('.task-card').filter({ hasText: titleMarker })).toHaveCount(0);
    await expect(remote.locator('.task-card').filter({ hasText: quickTitle })).toHaveCount(0);
    await workspaceOption(remote, 'Lock');
    await expectLocked(remote, markers);
    await expectPrivate(remote, remoteRequests, markers);
  } finally {
    await device.close();
  }

  const wrongDevice = await browser.newContext();
  try {
    expect(await wrongDevice.storageState()).toEqual({ cookies: [], origins: [] });
    const wrong = await wrongDevice.newPage();
    await prepare(wrong);
    const wrongRequests = captureRequests(wrong);
    await wrong.goto(privateUrl);
    await expectLocked(wrong, markers);
    await unlock(wrong, accounts.secondUserId, 'browser second password 2026');
    await expect(wrong.locator('[data-view="board"]')).toHaveAttribute('aria-current', 'page');
    await expect(wrong.locator('#task-dialog, #search, .quick-add')).toHaveCount(0);
    for (const marker of markers) expect(await wrong.content()).not.toContain(marker);
    await wrong.locator('#open-search').click();
    await expect(wrong.locator('#search')).toHaveValue('');
    await expectPrivate(wrong, wrongRequests, markers);
  } finally {
    await wrongDevice.close();
  }
});

test('a copied URL remains an encrypted snapshot while later unfinished edits stay on the source device', async ({ page, browser }) => {
  const requests = captureRequests(page);
  const accounts = await signIn(page);
  const stamp = Date.now().toString(36);
  const copied = 'URL_COPIED_DRAFT_' + stamp;
  const later = 'URL_LATER_DRAFT_' + stamp;
  await changeState(page, () => page.locator('#new-task').click());
  const copiedUrl = await changeState(page, () => page.locator('#task-title').fill(copied));
  const updatedUrl = await changeState(page, () => page.locator('#task-title').fill(later));
  expect(updatedUrl).not.toBe(copiedUrl);
  await expectPrivate(page, requests, [copied, later]);

  const device = await browser.newContext();
  try {
    const remote = await device.newPage();
    await prepare(remote);
    const remoteRequests = captureRequests(remote);
    await remote.goto(copiedUrl);
    await expectLocked(remote, [copied, later]);
    await unlock(remote, accounts.userId);
    await expect(remote.locator('#task-title')).toHaveValue(copied);
    await expect(page.locator('#task-title')).toHaveValue(later);
    await expect(remote.locator('.task-card').filter({ hasText: copied })).toHaveCount(0);
    await expectPrivate(remote, remoteRequests, [copied, later]);

    await remote.goto(updatedUrl);
    await remote.reload();
    await expectLocked(remote, [copied, later]);
    await unlock(remote, accounts.userId);
    await expect(remote.locator('#task-title')).toHaveValue(later);
    await expect(remote.locator('#save-task')).toHaveText('Add task');
    await expectPrivate(remote, remoteRequests, [copied, later]);
  } finally {
    await device.close();
  }
});

test('restoring an unfinished reminder on a device in another timezone preserves its instant', async ({ page, browser }) => {
  const response = await page.request.get('/test-account');
  const { userId } = await response.json() as { userId: string };
  const baseURL = new URL(response.url()).origin;
  const sourceDevice = await browser.newContext({ timezoneId: 'UTC' });
  const receivingDevice = await browser.newContext({ timezoneId: 'America/New_York' });
  try {
    const source = await sourceDevice.newPage();
    await prepare(source);
    await source.goto(baseURL);
    await unlock(source, userId);
    await expect.poll(() => new URL(source.url()).hash).toMatch(stateFragment);
    await changeState(source, () => source.locator('#new-task').click());
    const title = 'URL_TIMEZONE_DRAFT_' + Date.now().toString(36);
    await changeState(source, () => source.locator('#task-title').fill(title));
    await source.locator('#task-schedule summary').click();
    await setDate(source, 'Remind me', '2031-07-22', '09:35');
    await expect(source.getByRole('button', { name: 'Remind me: 2031-07-22 · 09:35', exact: true })).toBeVisible();
    const privateUrl = source.url();

    const receiving = await receivingDevice.newPage();
    await prepare(receiving);
    const requests = captureRequests(receiving);
    await receiving.goto(privateUrl);
    await expectLocked(receiving, [title]);
    await unlock(receiving, userId);
    await expect(receiving.locator('#task-title')).toHaveValue(title);
    await receiving.locator('#task-schedule summary').click();
    await expect(receiving.getByRole('button', { name: 'Remind me: 2031-07-22 · 05:35', exact: true })).toBeVisible();
    await receiving.locator('#save-task').click();
    await expect(receiving.locator('#task-dialog')).toHaveCount(0);
    const savedTask = receiving.locator('.task-card').filter({ hasText: title });
    await expect(savedTask).toHaveCount(1);
    await expect(savedTask.locator('time')).toHaveAttribute('datetime', '2031-07-22T09:35:00.000Z');
    await expect(receiving.locator('#save-status')).toContainText('All changes synced');
    await expectPrivate(receiving, requests, [title]);
  } finally {
    await sourceDevice.close();
    await receivingDevice.close();
  }
});
