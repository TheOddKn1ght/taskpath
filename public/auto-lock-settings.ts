declare const localStorage: { getItem(key: string): string | null };
export const LOCK_SETTING = 'taskpath-auto-lock-minutes';
export const ACTIVITY = 'taskpath-last-activity';
export const lockChoices = [0, 1, 5, 15, 30, 60] as const;
export function lockMinutes() {
  try { const value = Number(localStorage.getItem(LOCK_SETTING)); return lockChoices.some(n => n === value) ? value : 0; }
  catch { return 0; }
}
export function autoLockExpired(now: number, lastActivity: number, minutes: number) {
  return minutes > 0 && now - lastActivity >= minutes * 60_000;
}
export function rememberedLockExpired() {
  try { return autoLockExpired(Date.now(), Number(localStorage.getItem(ACTIVITY) || 0), lockMinutes()); }
  catch { return lockMinutes() > 0; }
}
