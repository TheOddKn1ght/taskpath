import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Envelope, ReminderMetadata } from '../public/types.d.ts';
import { Database, openDatabase } from './db/connection.ts';
import { AccountRepository } from './db/accounts.ts';
import { WorkspaceRepository } from './db/workspace.ts';
import { validateEnvelope, validateConfig, validId } from '../public/crypto.ts';

const utf8 = new TextEncoder();
const toBase64Url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};
const fromBase64Url = (value: string): Uint8Array => {
  const s = value.replaceAll('-', '+').replaceAll('_', '/');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export class InputError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Expected an object.');
  return value as Record<string, unknown>;
}
export class Store {
  readonly db: Database;
  readonly timezone: string;
  readonly workspace: WorkspaceRepository;
  private accounts: AccountRepository;
  constructor(path = ':memory:', private now = () => new Date(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
    this.db = openDatabase(path, timezone);
    this.workspace = new WorkspaceRepository(this.db);
    this.accounts = new AccountRepository(this.db);
    this.timezone = this.workspace.setting('timezone', () => timezone);
  }

  close() { this.db.close(); }
  config(userId: string) { const row = this.accounts.get(userId); return row?.status === 'active' ? validateConfig(JSON.parse(row.config!)) : null; }
  private cursorKey = randomBytes(32);
  private metadata(userId: string, vaultId: string) {
    return { format: 1, protocol: 2, workspaceKey: vaultId, pushEnabled: this.pushEnabled(userId), timezone: this.timezone, serverTime: this.now().toISOString() };
  }
  private cursor(userId: string, vaultId: string, sequence: number) {
    const body = toBase64Url(utf8.encode(JSON.stringify([userId, vaultId, sequence])));
    return body + '.' + createHmac('sha256', this.cursorKey).update(body).digest('base64url');
  }
  syncBoard(userId: string, cursor: string | null = null) {
    const vaultId = this.config(userId)?.vaultId;
    if (!vaultId) throw new InputError('Account unavailable.', 403);
    let after = 0;
    if (cursor) {
      try {
        if (cursor.length > 1024) throw new Error();
        const [body, signature, extra] = cursor.split('.');
        const expected = createHmac('sha256', this.cursorKey).update(body!).digest();
        const actual = fromBase64Url(signature!);
        if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
        const [account, vault, sequence] = JSON.parse(new TextDecoder().decode(fromBase64Url(body!)));
        if (account !== userId || vault !== vaultId || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error();
        after = sequence;
      } catch { throw new InputError('Sync cursor expired. Restart the encrypted download.', 410); }
    }
    return this.workspace.transaction(() => {
      const candidates = this.workspace.page(userId, after), rows: Envelope[] = [];
      let bytes = 0, sequence = after;
      for (const row of candidates) {
        const size = utf8.encode(row.envelope).byteLength;
        if (rows.length === 50 || (rows.length > 0 && bytes + size > 1024 * 1024)) break;
        rows.push(validateEnvelope(JSON.parse(row.envelope), vaultId));
        bytes += size; sequence = row.sequence;
      }
      return { ...this.metadata(userId, vaultId), rows, cursor: this.cursor(userId, vaultId, sequence), hasMore: candidates.length > rows.length };
    });
  }
  sync(userId: string, raw: unknown) {
    const input = object(raw);
    const vaultId = this.config(userId)?.vaultId;
    if (!vaultId) throw new InputError('Account unavailable.', 403);
    if (input.workspaceKey !== vaultId) throw new InputError('This server has a different workspace. Your encrypted changes remain on this device.', 409);
    if (Object.keys(input).some(k => !['workspaceKey', 'changes', 'reminders'].includes(k)) || !Array.isArray(input.changes) || input.changes.length > 50) throw new InputError('Send at most 50 encrypted changes.');
    const rawReminders: unknown = input.reminders ?? [];
    if (!Array.isArray(rawReminders) || rawReminders.length > 50) throw new InputError('Send at most 50 reminder schedules.');
    const reminders = rawReminders.map((raw: unknown) => {
      const r = object(raw);
      if (Object.keys(r).some(k => !['taskId', 'changeId', 'token', 'dueAt'].includes(k)) || !validId(r.taskId) || !validId(r.changeId)
        || (r.token === null ? r.dueAt !== null : !validId(r.token) || (r.token as string).length < 32 || typeof r.dueAt !== 'string' || !Number.isFinite(Date.parse(r.dueAt)) || new Date(r.dueAt).toISOString() !== r.dueAt)) throw new InputError('Use only opaque reminder IDs and an ISO reminder time.');
      return r as unknown as ReminderMetadata;
    });
    const changes = (input.changes as unknown[]).map(raw => {
      let envelope: Envelope;
      try { envelope = validateEnvelope(raw, vaultId); } catch { throw new InputError('Invalid encrypted change. Plaintext sync is unsupported.'); }
      if (Date.parse(envelope.editedAt) > this.now().getTime() + 300000) throw new InputError('Edit time is too far in the future. Check this device’s clock.');
      return envelope;
    });
    return this.workspace.transaction(() => {
      const acknowledged: string[] = [];
      let conflicts = 0, changed = false;
      for (const e of changes) {
        const current = this.workspace.revision(userId, e.taskId);
        acknowledged.push(e.changeId);
        if (current && (current.editedAt > e.editedAt || (current.editedAt === e.editedAt && current.changeId >= e.changeId))) {
          if (current.changeId !== e.changeId) conflicts++;
          continue;
        }
        this.workspace.saveEnvelope({ userId, taskId: e.taskId, editedAt: e.editedAt, changeId: e.changeId, envelope: JSON.stringify(e) });
        // Until matching metadata arrives, never send the previous revision's reminder.
        this.workspace.cancelReminder(userId, e.taskId);
        changed = true;
      }
      if (this.pushEnabled(userId)) for (const r of reminders) {
        const current = this.workspace.revision(userId, r.taskId);
        if (current?.changeId !== r.changeId) continue;
        if (r.token === null) this.workspace.cancelReminder(userId, r.taskId);
        else this.workspace.saveReminder({ userId, taskId: r.taskId, changeId: r.changeId, token: r.token, dueAt: Date.parse(r.dueAt!) });
      }
      return { ...this.metadata(userId, vaultId), rows: [...new Set(changes.map(e => e.taskId))].map(id => validateEnvelope(JSON.parse(this.workspace.envelope(userId, id).envelope), vaultId)), acknowledged, reminderAcknowledged: reminders.map(r => ({ taskId: r.taskId, changeId: r.changeId })), conflicts, changed };
    });
  }
  pushEnabled(userId: string) { return this.workspace.pushEnabled(userId); }
  claim(userId: string, tokens: unknown) {
    if (!Array.isArray(tokens) || tokens.length > 100 || tokens.some(t => !validId(t) || (t as string).length < 32)) throw new InputError('Invalid reminder tokens.');
    return this.workspace.transaction(() => ({ tokens: (tokens as string[]).filter(token => this.workspace.claim(userId, token)) }));
  }
}
