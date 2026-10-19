import { test, expect, type Page } from '@playwright/test';

const password = 'browser harness password 2026';
type HeldEncryptionWindow = Window & {
  __urlRace?: { ready: number; finished: number; unlocked: number; release: () => void };
};

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('dialog', dialog => dialog.accept());
});

async function signIn(page: Page) {
  const { userId } = await (await page.request.get('/test-account')).json() as { userId: string };
  await page.goto('/');
  await page.locator('#unlock-user').fill(userId);
  await page.locator('#unlock-password').fill(password);
  await page.locator('[name="remember"]').check();
  await page.locator('#unlock-submit').click();
  await expect(page.locator('#save-status')).toContainText('All changes synced');
  await expect.poll(() => new URL(page.url()).hash).toMatch(/^#state=v1\./);
}

async function committedChange(page: Page, action: () => Promise<unknown>) {
  const before = page.url();
  await action();
  await expect.poll(() => page.url()).not.toBe(before);
}

async function holdEncryption(page: Page) {
  await page.evaluate(() => {
    const original = crypto.subtle.encrypt;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = {
      ready: 0,
      finished: 0,
      unlocked: 0,
      release: () => { crypto.subtle.encrypt = original; release(); },
    };
    (window as HeldEncryptionWindow).__urlRace = held;
    window.addEventListener('taskpath-unlocked', () => { held.unlocked++; }, { once: true });
    crypto.subtle.encrypt = async function (...args: Parameters<SubtleCrypto['encrypt']>) {
      const ciphertext = await original.apply(this, args);
      const additionalData = (args[0] as AesGcmParams).additionalData;
      if (additionalData && new TextDecoder().decode(additionalData).includes('taskpath:url-state')) {
        held.ready++;
        await gate;
        held.finished++;
      }
      return ciphertext;
    };
  });
}

async function pendingDraft(page: Page, title: string) {
  await holdEncryption(page);
  await page.locator('#task-title').fill(title);
  await expect.poll(() => page.evaluate(() => (window as HeldEncryptionWindow).__urlRace?.ready || 0)).toBeGreaterThan(0);
}

async function releaseEncryption(page: Page) {
  await page.evaluate(() => (window as HeldEncryptionWindow).__urlRace!.release());
  await expect.poll(() => page.evaluate(() => (window as HeldEncryptionWindow).__urlRace?.finished || 0)).toBeGreaterThan(0);
}

test('Back during draft encryption keeps the latest unfinished edit available on Forward', async ({ page }) => {
  await signIn(page);
  await committedChange(page, () => page.locator('#new-task').click());
  await committedChange(page, () => page.locator('#task-title').fill('Earlier draft'));
  const title = 'PRIVATE_HISTORY_RACE_' + Date.now().toString(36);
  await pendingDraft(page, title);

  await page.goBack();
  await releaseEncryption(page);
  await expect(page.locator('#task-dialog')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#main')).toBeVisible();
  await page.goForward();
  await expect(page.locator('#task-title')).toHaveValue(title);
  await expect(page.locator('#save-task')).toHaveText('Add task');
  expect(page.url()).not.toContain(title);
  await page.reload();
  await expect(page.locator('#task-title')).toHaveValue(title);
});

test('a new editor reserves its Forward entry before its address encryption completes', async ({ page }) => {
  await signIn(page);
  await holdEncryption(page);
  await page.locator('#new-task').click();
  await expect(page.locator('#task-dialog')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as HeldEncryptionWindow).__urlRace?.ready || 0)).toBeGreaterThanOrEqual(2);
  const title = 'PRIVATE_PENDING_PUSH_' + Date.now().toString(36);
  await page.locator('#task-title').fill(title);
  await expect.poll(() => page.evaluate(() => (window as HeldEncryptionWindow).__urlRace?.ready || 0)).toBeGreaterThanOrEqual(3);

  await page.goBack();
  await releaseEncryption(page);
  await expect(page.locator('#task-dialog')).toHaveCount(0);
  await page.goForward();
  await expect(page.locator('#task-title')).toHaveValue(title);
  expect(page.url()).not.toContain(title);
});

test('unlocking before pending draft encryption completes restores the latest edit', async ({ page, context }) => {
  await signIn(page);
  await committedChange(page, () => page.locator('#new-task').click());
  await committedChange(page, () => page.locator('#task-title').fill('Earlier draft'));
  const lockingTab = await context.newPage();
  await lockingTab.goto('/');
  await expect(lockingTab.locator('#main')).toBeVisible();
  const title = 'PRIVATE_LOCK_UNLOCK_RACE_' + Date.now().toString(36);
  await pendingDraft(page, title);

  await lockingTab.locator('.app-menu').click();
  await lockingTab.getByRole('menuitem', { name: 'Lock', exact: true }).click();
  await expect(page.locator('#unlock-form')).toBeVisible();
  await expect(page.locator('#task-dialog')).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain(title);
  await lockingTab.close();
  await page.locator('#unlock-password').fill(password);
  await page.locator('#unlock-submit').click();
  await expect.poll(() => page.evaluate(() => (window as HeldEncryptionWindow).__urlRace?.unlocked || 0)).toBe(1);
  await releaseEncryption(page);
  await expect(page.locator('#task-title')).toHaveValue(title);
  await expect(page.locator('#save-task')).toHaveText('Add task');
  expect(page.url()).not.toContain(title);
});
