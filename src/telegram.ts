import { randomBytes } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotDatabase } from './db/backup';
import { AuthManager } from './auth';
import { invitationURL } from './admin';
import { InputError } from './store';
import { validUserId } from '../public/crypto';

export const TELEGRAM_ADMIN_VERSION = 1;
export const TELEGRAM_BACKUP_MAX_BYTES = 50_000_000;
export type TelegramConfig = { token: string; adminId: number; origin: string };
type Button = { text: string; callback_data: string };
type Reply = { text: string; buttons?: Button[][]; confirmation?: string; backup?: boolean };
type Message = {
  message_id: number;
  chat: { id: number; type: string };
  text?: string;
  from?: { id: number };
};
export type TelegramUpdate = {
  update_id: number;
  message?: Message;
  callback_query?: { id: string; from: { id: number }; data?: string; message?: Message };
};
type Confirmation = { userId: string; expires: number; messageId?: number };
class TelegramError extends Error {
  constructor(
    public fatal: boolean,
    public delay = 0,
  ) {
    super('Telegram request failed.');
  }
}

export function telegramConfig(env: Record<string, string | undefined>): TelegramConfig | null {
  const token = env.TASKPATH_TELEGRAM_BOT_TOKEN;
  const id = env.TASKPATH_TELEGRAM_ADMIN_ID;
  if (!token && !id) return null;
  if (
    !token ||
    !/^\d+:[A-Za-z0-9_-]+$/.test(token) ||
    !id ||
    !/^[1-9]\d*$/.test(id) ||
    !Number.isSafeInteger(Number(id))
  )
    throw new Error('Telegram requires a valid bot token and numeric admin ID.');
  const origin = env.TASKPATH_ORIGIN || '';
  invitationURL(origin, 'validation', 'validation');
  if (new URL(origin).protocol !== 'https:')
    throw new Error('Telegram requires TASKPATH_ORIGIN with HTTPS.');
  return { token, adminId: Number(id), origin };
}

export class TelegramAdmin {
  private controller = new AbortController();
  private running?: Promise<void>;
  private confirmations = new Map<string, Confirmation>();
  private key: string;
  constructor(
    private db: Database,
    private auth: AuthManager,
    private config: TelegramConfig,
    private request: typeof fetch = fetch,
    private now = () => Date.now(),
    private report = (message: string) => console.error(message),
  ) {
    this.key = `telegram-offset:${config.token.split(':')[0]}`;
  }
  private offset() {
    return Number(
      this.db
        .query<{ value: string }, [string]>('SELECT value FROM settings WHERE key=?')
        .get(this.key)?.value || 0,
    );
  }
  private async api(method: string, body: object | FormData): Promise<any> {
    let response: Response;
    try {
      response = await this.request(`https://api.telegram.org/bot${this.config.token}/${method}`, {
        method: 'POST',
        headers: body instanceof FormData ? undefined : { 'content-type': 'application/json' },
        body: body instanceof FormData ? body : JSON.stringify(body),
        signal: AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(method === 'sendDocument' ? 120_000 : 45_000),
        ]),
      });
    } catch {
      throw new TelegramError(false);
    }
    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new TelegramError(false);
    }
    if (!response.ok || !data.ok) {
      const code = data.error_code || response.status;
      throw new TelegramError(
        [400, 401, 403, 404, 409].includes(code),
        Math.min(3600, Math.max(0, Number(data.parameters?.retry_after) || 0)) * 1000,
      );
    }
    return data.result;
  }
  private menu(): Reply {
    return {
      text: 'Taskpath admin\n/invite — create invitation\n/list — accounts\n/reinvite USER_ID\n/revoke USER_ID\n/disable USER_ID\n/backup — download database backup',
      buttons: [
        [
          { text: 'Invite', callback_data: 'invite' },
          { text: 'Accounts', callback_data: 'list:0' },
        ],
        [{ text: 'Database backup', callback_data: 'backup' }],
      ],
    };
  }
  private accounts(page: number): Reply {
    const rows = this.auth.list();
    const pages = Math.max(1, Math.ceil(rows.length / 10));
    page = Math.min(page, pages - 1);
    const selected = rows.slice(page * 10, page * 10 + 10);
    const buttons: Button[][] = [];
    for (const row of selected) {
      const actions: Button[] = [];
      if (row.status === 'pending')
        actions.push(
          { text: `Reinvite ${row.userId}`, callback_data: `reinvite:${row.userId}` },
          { text: 'Revoke invite', callback_data: `revoke:${row.userId}` },
        );
      if (row.status !== 'disabled')
        actions.push({ text: `Disable ${row.userId}`, callback_data: `disable:${row.userId}` });
      if (actions.length) buttons.push(actions);
    }
    const nav: Button[] = [];
    if (page > 0) nav.push({ text: 'Previous', callback_data: `list:${page - 1}` });
    if (page + 1 < pages) nav.push({ text: 'Next', callback_data: `list:${page + 1}` });
    if (nav.length) buttons.push(nav);
    return {
      text:
        `Accounts (${page + 1}/${pages})\n` +
        (selected
          .map(
            (row) =>
              `${row.userId}\n${row.status} · created ${new Date(row.createdAt).toISOString()}${row.expiresAt ? ` · invite expires ${new Date(row.expiresAt).toISOString()}` : ''}`,
          )
          .join('\n\n') || 'No accounts.'),
      buttons,
    };
  }
  private command(action: string, arg: string | undefined, messageId?: number): Reply {
    if (action === 'start' || action === 'help') return this.menu();
    if (action === 'backup') {
      if (arg !== undefined) throw new InputError('Usage: /backup');
      return { text: '', backup: true };
    }
    if (action === 'list') {
      if (arg !== undefined && !/^\d{1,8}$/.test(arg)) throw new InputError('Invalid page.');
      return this.accounts(Number(arg || 0));
    }
    if (action === 'confirm' || action === 'cancel') {
      const pending = this.confirmations.get(arg || '');
      if (
        !pending ||
        pending.expires <= this.now() ||
        pending.messageId !== messageId ||
        messageId === undefined
      )
        throw new InputError('Confirmation expired. Request the action again.');
      this.confirmations.delete(arg!);
      if (action === 'cancel') return { text: 'Cancelled.' };
      this.auth.disable(pending.userId);
      return {
        text: `Account disabled: ${pending.userId}\nSessions revoked. Encrypted data retained.`,
      };
    }
    if (['reinvite', 'revoke', 'disable'].includes(action) && !validUserId(arg))
      throw new InputError('Provide a valid USER_ID.');
    if (action === 'invite' || action === 'reinvite') {
      if (action === 'invite' && arg !== undefined) throw new InputError('Usage: /invite');
      const invite =
        action === 'invite' ? this.auth.createInvitation() : this.auth.renewInvitation(arg!);
      return {
        text: `User ID: ${invite.userId}\nSetup link: ${invitationURL(this.config.origin, invite.userId, invite.token)}\nExpires: ${new Date(invite.expiresAt).toISOString()} (one use, 24 hours)`,
      };
    }
    if (action === 'revoke') {
      this.auth.revokeInvitation(arg!);
      return { text: `Pending invitation revoked: ${arg}` };
    }
    if (action === 'disable') {
      if (!this.auth.list().some((row) => row.userId === arg && row.status !== 'disabled'))
        throw new InputError('Enabled account not found.');
      const nonce = randomBytes(12).toString('hex');
      this.confirmations.set(nonce, { userId: arg!, expires: this.now() + 300_000 });
      return {
        text: `Disable account ${arg}?\nThis revokes sessions and retains encrypted data. Confirmation expires in five minutes.`,
        confirmation: nonce,
        buttons: [
          [
            { text: 'Confirm disable', callback_data: `confirm:${nonce}` },
            { text: 'Cancel', callback_data: `cancel:${nonce}` },
          ],
        ],
      };
    }
    return this.menu();
  }
  async handle(update: TelegramUpdate) {
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) return;
    const callback = update.callback_query;
    const message = callback?.message || update.message;
    const sender = callback?.from || update.message?.from;
    let reply: Reply | undefined;
    let authorized = false;
    let consumed = false;
    this.db.transaction(() => {
      if (update.update_id < this.offset()) return;
      consumed = true;
      authorized =
        sender?.id === this.config.adminId &&
        message?.chat.type === 'private' &&
        message.chat.id === this.config.adminId;
      for (const [key, pending] of this.confirmations)
        if (pending.expires <= this.now()) this.confirmations.delete(key);
      if (authorized) {
        try {
          if (callback) {
            const match =
              /^(invite|list|reinvite|revoke|disable|confirm|cancel|backup)(?::([^:]+))?$/.exec(
                callback.data || '',
              );
            if (match) reply = this.command(match[1]!, match[2], message!.message_id);
          } else {
            const match =
              /^\/(start|help|invite|list|reinvite|revoke|disable|backup)(?:\s+(\S+))?\s*$/.exec(
                message?.text || '',
              );
            reply = match ? this.command(match[1]!, match[2]) : this.menu();
          }
        } catch (error) {
          if (!(error instanceof InputError)) throw error;
          reply = { text: error.message };
        }
      }
      this.db
        .query(
          'INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        )
        .run(this.key, String(update.update_id + 1));
    })();
    if (!consumed || !authorized) return;
    if (callback) {
      try {
        await this.api('answerCallbackQuery', { callback_query_id: callback.id });
      } catch {
        /* A stale callback acknowledgement must not hide the result. */
      }
    }
    if (reply?.backup) {
      await this.sendBackup();
      return;
    }
    if (reply) {
      const result = await this.api('sendMessage', {
        chat_id: this.config.adminId,
        text: reply.text,
        link_preview_options: { is_disabled: true },
        ...(reply.buttons?.length ? { reply_markup: { inline_keyboard: reply.buttons } } : {}),
      });
      if (reply.confirmation) {
        const pending = this.confirmations.get(reply.confirmation);
        if (pending) pending.messageId = result.message_id;
      }
    }
  }
  private async sendBackup() {
    let directory: string | undefined;
    try {
      directory = mkdtempSync(join(tmpdir(), 'taskpath-telegram-backup-'));
      const filename = `taskpath-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}.sqlite`;
      const path = snapshotDatabase(this.db.filename, join(directory, filename));
      if (statSync(path).size > TELEGRAM_BACKUP_MAX_BYTES) {
        await this.api('sendMessage', {
          chat_id: this.config.adminId,
          text: 'Database backup exceeds the 50 MB Telegram upload limit. Use sudo taskpath backup on the VPS instead.',
        });
        return;
      }
      const form = new FormData();
      form.set('chat_id', String(this.config.adminId));
      form.set(
        'document',
        new File([Bun.file(path)], filename, { type: 'application/vnd.sqlite3' }),
      );
      form.set(
        'caption',
        'Full Taskpath database backup. Contains all accounts, encrypted tasks and files, sessions, and push state. Keep private. Vault passwords are still required.',
      );
      await this.api('sendDocument', form);
    } catch {
      if (!this.controller.signal.aborted) {
        this.report('Telegram database backup failed.');
        await this.api('sendMessage', {
          chat_id: this.config.adminId,
          text: 'Could not create or deliver the database backup. Retry /backup, or use sudo taskpath backup on the VPS.',
        });
      }
    } finally {
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  }

  start() {
    if (!this.running)
      this.running = this.run().catch(() =>
        this.report(
          'Telegram admin stopped after an internal failure. Web service remains available.',
        ),
      );
  }
  private async run() {
    let ready = false;
    let delay = 1000;
    while (!this.controller.signal.aborted) {
      try {
        if (!ready) {
          await this.api('getMe', {});
          const webhook = await this.api('getWebhookInfo', {});
          if (webhook.url) {
            this.report(
              'Telegram admin stopped: remove the bot webhook before using long polling.',
            );
            return;
          }
          ready = true;
        }
        const updates = await this.api('getUpdates', {
          offset: this.offset(),
          timeout: 30,
          allowed_updates: ['message', 'callback_query'],
        });
        if (!Array.isArray(updates)) throw new TelegramError(false);
        for (const update of updates) {
          if (this.controller.signal.aborted) break;
          await this.handle(update);
        }
        delay = 1000;
      } catch (error) {
        if (this.controller.signal.aborted) return;
        if (!(error instanceof TelegramError)) throw error;
        if (error.fatal) {
          this.report(
            'Telegram admin stopped: check bot credentials, chat access, and that no other bot instance is polling.',
          );
          return;
        }
        this.report('Telegram admin temporarily unavailable; retrying.');
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            this.controller.signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, Math.max(delay, error.delay));
          this.controller.signal.addEventListener('abort', done, { once: true });
        });
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }
  async stop() {
    this.controller.abort();
    this.confirmations.clear();
    await this.running;
  }
}
