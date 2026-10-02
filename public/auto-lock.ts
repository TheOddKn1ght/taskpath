import { LOCK_SETTING, ACTIVITY, lockChoices, lockMinutes, autoLockExpired } from './auto-lock-settings.js';
export { lockChoices, lockMinutes } from './auto-lock-settings.js';
export function setLockMinutes(minutes: number) {
  if (!lockChoices.some(n => n === minutes)) throw new Error('Choose a valid lock interval.');
  localStorage.setItem(LOCK_SETTING, String(minutes));
  window.dispatchEvent(new Event('taskpath-lock-setting'));
}
export function startAutoLock(unlocked: () => boolean, lock: () => Promise<void>) {
  const abort = new AbortController(), options = { signal: abort.signal };
  let lastActivity = Date.now(), locking = false;
  const sharedActivity = () => { try { return Math.max(lastActivity, Number(localStorage.getItem(ACTIVITY) || 0)); } catch { return lastActivity; } };
  const recordActivity = () => { lastActivity = Date.now(); try { localStorage.setItem(ACTIVITY, String(lastActivity)); } catch {} };
  const check = () => {
    if (unlocked() && !locking && autoLockExpired(Date.now(), sharedActivity(), lockMinutes())) {
      locking = true;
      void lock().catch(() => {}).finally(() => { locking = false; });
      return true;
    }
    return false;
  };
  const activity = (event: Event) => { if (event.isTrusted && unlocked() && !check()) recordActivity(); };
  for (const name of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(name, activity, { ...options, passive: true });
  window.addEventListener('focus', check, options);
  document.addEventListener('visibilitychange', check, options);
  window.addEventListener('storage', check, options);
  window.addEventListener('taskpath-unlocked', recordActivity, options);
  window.addEventListener('taskpath-lock-setting', recordActivity, options);
  if (unlocked()) recordActivity();
  const timer = setInterval(check, 1000);
  return () => { abort.abort(); clearInterval(timer); };
}
