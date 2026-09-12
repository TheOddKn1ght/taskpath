import { network, localState, selectedAccount, isUnlocked, syncAfterCurrent } from './offline.js';
const $ = selector => document.querySelector(selector);
const digest = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(n => n.toString(16).padStart(2, '0')).join('');
export function setupPush() {
  const dialog = $('#push-dialog'), button = $('#push-toggle'), status = $('#push-status');
  let registration, config, existing, subscribed = false, userId, revision = 0;
  const supported = () => window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const check = () => { if (!isUnlocked() || selectedAccount() !== userId) throw new Error('Unlock this account to change notifications.'); };
  const refresh = async () => {
    check(); const current = revision, account = userId;
    const [nextConfig, nextRegistration] = await Promise.all([network('/api/push', 'GET', undefined, account), navigator.serviceWorker.getRegistration()]);
    const nextSubscription = await nextRegistration?.pushManager.getSubscription();
    const id = nextSubscription && await digest(nextSubscription.endpoint);
    if (current !== revision) return;
    check(); config = nextConfig; registration = nextRegistration; existing = nextSubscription;
    subscribed = Boolean(existing && config.subscriptionIds.includes(id));
    button.textContent = subscribed ? 'Turn off on this device' : 'Enable on this device';
    button.disabled = !config.available || !registration?.active;
    status.textContent = !config.available ? 'Your administrator needs to set TASKPATH_ORIGIN to the public HTTPS address.' : !registration?.active ? 'The offline app is still installing. Close this dialog and try again shortly.' : subscribed ? 'Background reminders are on for this device, including while the vault is locked.' : 'Background reminders are off on this device.';
  };
  $('#background-notifications').addEventListener('click', async () => {
    $('.app-menu').open = false; dialog.showModal(); userId = selectedAccount();
    const current = ++revision; button.disabled = true; $('#push-error').hidden = true;
    if (!supported()) { status.textContent = 'This browser does not support background notifications here. On iPhone or iPad, add Taskpath to your Home Screen and open it there (iOS 16.4 or later).'; return; }
    status.textContent = 'Checking this device…';
    try { await refresh(); } catch (error) { if (current === revision) status.textContent = error.message; }
  });
  window.addEventListener('taskpath-locked', () => { revision++; button.disabled = true; dialog.close(); });
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    const current = revision, account = userId;
    button.disabled = true; $('#push-error').hidden = true;
    try {
      check();
      if (subscribed) {
        await network('/api/push', 'DELETE', { id: await digest(existing.endpoint) }, account);
        await existing.unsubscribe();
        for (const notification of await registration.getNotifications()) if (notification.tag.startsWith('taskpath-reminder-')) notification.close();
      } else {
        // Permission is requested directly from this user gesture, including on iOS.
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') throw new Error('Notifications were not allowed. You can change this in your browser or device settings.');
        check();
        if (typeof config.publicKey !== 'string' || !/^[\w-]{80,100}$/.test(config.publicKey)) throw new Error('Background notifications are unavailable. Reopen Taskpath online after updating, then try again.');
        const unpadded = config.publicKey.replace(/-/g, '+').replace(/_/g, '/');
        const key = Uint8Array.from(atob(unpadded + '='.repeat((4 - unpadded.length % 4) % 4)), c => c.charCodeAt(0));
        // Subscribe on the live active registration, not a possibly stale cached one.
        const live = await navigator.serviceWorker.ready;
        if (!live.active) throw new Error('The offline app is still installing. Close this dialog, wait a moment, and try again.');
        registration = live;
        try {
          existing = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        } catch (error) {
          if (error?.name === 'NotAllowedError') throw new Error('Notifications were not allowed. You can change this in your browser or device settings.');
          throw new Error(`Could not reach the browser push service (${error?.name || 'push service error'}). Check connection, VPN/ad-blocker, and that this browser can reach its push provider, then try again.`, { cause: error });
        }
        check();
        await network('/api/push', 'POST', { subscription: existing.toJSON() }, account);
        check();
        await localState(record => { record.pushEnabled = true; record.reminderPublished = {}; }, account);
      }
      status.textContent = 'Updating reminder schedules…';
      await syncAfterCurrent();
      if (current === revision) await refresh();
    } catch (error) {
      if (current === revision) { $('#push-error').textContent = error.message; $('#push-error').hidden = false; }
    } finally { if (current === revision) button.disabled = !config?.available || !registration?.active; }
  });
}
