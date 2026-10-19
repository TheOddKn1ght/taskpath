import type { Route } from './types.js';
import { base64, unbase64, random, validId } from './crypto.js';
import { validCalendarDate } from './picker-model.js';
export const emptyRoute: Route = { view: 'board', query: '', category: 'all', tag: '' };

const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_LENGTH = 131072;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const oneOf = (v: unknown, values: readonly string[]) => typeof v === 'string' && values.includes(v);
const statuses = ['later', 'week', 'today', 'done'];
const categories = ['work', 'personal'];
const tags = (v: unknown) => Array.isArray(v) && v.length <= 100 && v.every(t => text(t, 80));
const date = (v: unknown) => typeof v === 'string' && validCalendarDate(v);
const instant = (v: unknown) => text(v, 40) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v);

// Validate decrypted links before passing their values to UI controls.
export function validateRoute(value: unknown): Route {
  if (!object(value) || !oneOf(value.view, ['board', 'calendar', 'stats', 'archive', 'files']) ||
      !text(value.query, 10000) || !oneOf(value.category, ['all', ...categories]) || !text(value.tag, 80) ||
      !optional(value.focus, v => v === 'today') || !optional(value.searchOpen, v => typeof v === 'boolean') ||
      !optional(value.fileQuery, v => text(v, 10000)) || !optional(value.details, validId)) throw new Error('Invalid view state.');
  if (!optional(value.calendar, v => object(v) && oneOf(v.mode, ['month', 'week']) && date(v.anchor) && date(v.selected))) throw new Error('Invalid calendar state.');
  if (!optional(value.searchState, v => object(v) && text(v.query, 10000) && oneOf(v.scope, ['all', 'active', 'archived']) &&
      oneOf(v.status, ['all', ...statuses]) && oneOf(v.category, ['all', ...categories]) && tags(v.tags) &&
      oneOf(v.due, ['any', 'overdue', 'today', 'week', 'none']) && oneOf(v.reminder, ['any', 'yes', 'no']))) throw new Error('Invalid search state.');
  if (!optional(value.quickAdd, v => object(v) && Object.entries(v).every(([key, title]) => statuses.includes(key) && text(title, 240)))) throw new Error('Invalid quick draft.');
  if (!optional(value.editor, v => object(v) && optional(v.taskId, validId) && oneOf(v.status, statuses) && optional(v.due, date) &&
      optional(v.draft, d => object(d) && text(d.title, 240) && text(d.notes, 10000) && tags(d.tags) && oneOf(d.category, categories)) &&
      optional(v.values, d => object(d) && text(d.title, 240) && text(d.notes, 10000) && tags(d.tags) && text(d.tag, 1000) &&
        oneOf(d.column, statuses) && oneOf(d.category, categories) && (d.due === '' || date(d.due)) && text(d.reminder, 40) &&
        optional(d.reminderAt, v => v === null || instant(v))))) throw new Error('Invalid editor state.');
  return value as unknown as Route;
}

const encode = (bytes: Uint8Array<ArrayBuffer>) => base64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
function decode(value: string) {
  if (!/^[\w-]+$/.test(value)) throw new Error('Invalid view state.');
  const b64 = value.replaceAll('-', '+').replaceAll('_', '/');
  return unbase64(b64 + '='.repeat((4 - b64.length % 4) % 4));
}
const aad = (userId: string, vaultId: string) => encoder.encode(JSON.stringify(['taskpath:url-state', 1, userId, vaultId]));

export async function encryptRoute(route: Route, key: CryptoKey, userId: string, vaultId: string) {
  const bytes = encoder.encode(JSON.stringify(validateRoute(route)));
  try {
    if (bytes.length > 90000) throw new Error('View state is too large to save in this link.');
    const nonce = random(12);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(userId, vaultId) }, key, bytes));
    return `#state=v1.${encode(nonce)}.${encode(ciphertext)}`;
  } finally { bytes.fill(0); }
}

export async function decryptRoute(hash: string, key: CryptoKey, userId: string, vaultId: string): Promise<Route> {
  try {
    if (hash.length > MAX_LENGTH) return { ...emptyRoute };
    const match = /^#state=v1\.([\w-]{16})\.([\w-]+)$/.exec(hash);
    if (!match) return { ...emptyRoute };
    const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(match[1]), additionalData: aad(userId, vaultId) }, key, decode(match[2])));
    try { return validateRoute(JSON.parse(decoder.decode(bytes))); }
    finally { bytes.fill(0); }
  } catch { return { ...emptyRoute }; }
}
