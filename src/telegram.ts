import { FileRepository } from './db/files';
import { connect } from './db/connection';
import { fileQuota } from '../public/file-format';
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
type ButtonStyle = 'primary' | 'success' | 'danger';
type Button = { text: string; style?: ButtonStyle } & (
  { callback_data: string } | { copy_text: { text: string } }
);
const button = (text: string, callback_data: string, style?: ButtonStyle): Button => ({
  text,
  callback_data,
  style,
});
const presetAmounts = ['0', '10', '50', '100', '500', '1000'];
const filters = ['all', 'active', 'pending', 'disabled'] as const;
type Filter = (typeof filters)[number];
const labels = { all: 'All', active: 'Active', pending: 'Pending', disabled: 'Disabled' };
const filterSuffix = (filter: Filter) => (filter === 'all' ? '' : '|' + filter);
const html = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function dateTime(ms: number) {
  const fallback = new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  return `<tg-time unix="${Math.floor(ms / 1000)}" format="Dt">${fallback}</tg-time>`;
}
type Account = ReturnType<AuthManager['list']>[number];
function accountStatus(account: Account, now: number) {
  if (account.status === 'active') return '🟢 Active';
  if (account.status === 'disabled') return '⛔ Disabled';
  if (!account.expiresAt) return '⚪ Invite revoked';
  if (account.expiresAt <= now) return '⌛ Invite expired';
  return '🟡 Invited';
}

type LimitPrompt = { action: 'quota' | 'filelimit'; userId: string; filter: Filter };
type Reply = {
  text: string;
  buttons?: Button[][];
  confirmation?: string;
  backup?: boolean;
  prompt?: LimitPrompt;
};
function customAmount(prompt: LimitPrompt, error?: string): Reply {
  const title = prompt.action === 'quota' ? 'Custom file quota' : 'Custom file size limit';
  return {
    prompt,
    text: [
      `<b>${title}</b>\n<code>${prompt.userId}</code>`,
      error
        ? html(error)
        : 'Reply with a whole number of MB' + (prompt.action === 'filelimit' ? ' (0–1,000).' : '.'),
      'Zero pauses new uploads.',
    ].join('\n\n'),
  };
}
type Message = {
  message_id: number;
  chat: { id: number; type: string };
  text?: string;
  from?: { id: number };
  reply_to_message?: { message_id: number };
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
    public unchanged = false,
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
  private limitPrompt?: LimitPrompt & { messageId: number };
  private key: string;
  constructor(
    private db: Database,
    private auth: AuthManager,
    private config: TelegramConfig,
    private request: typeof fetch = fetch,
    private now = () => Date.now(),
    private report = (message: string) => console.error(message),
    private defaultQuota = fileQuota(process.env.TASKPATH_FILE_QUOTA_MB),
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
        code === 400 && /message is not modified/i.test(data.description || ''),
      );
    }
    return data.result;
  }
  private menu(): Reply {
    const counts = { active: 0, pending: 0, disabled: 0 };
    const rows = this.auth.list();
    for (const row of rows) counts[row.status]++;
    const summary = rows.length
      ? `<b>${rows.length}</b> ${rows.length === 1 ? 'account' : 'accounts'}\n🟢 ${counts.active} active  ·  🟡 ${counts.pending} pending  ·  ⛔ ${counts.disabled} disabled`
      : 'Invite someone to create the first account.';
    return {
      text: `<b>Taskpath admin</b>\n\n${summary}`,
      buttons: [
        [button('Invite', 'invite', 'success'), button('Accounts', 'list:0', 'primary')],
        [button('Database backup', 'backup'), button('Help', 'help')],
      ],
    };
  }
  private navigation(list = 'list:0'): Button[][] {
    return [[button('Accounts', list), button('Main menu', 'home')]];
  }
  private receiptButtons(userId?: string): Button[][] {
    return [
      ...(userId ? [[button('Account details', 'open:account:' + userId)]] : []),
      [button('Accounts', 'open:list:0'), button('Main menu', 'open:home')],
    ];
  }
  private account(userId: string, filter: Filter): Reply {
    const rows = this.auth.list();
    const row = rows.find((account) => account.userId === userId);
    if (!row) throw new InputError('Account not found.');
    const visible = rows.filter((r) => filter === 'all' || r.status === filter);
    const page = Math.floor(Math.max(0, visible.indexOf(row)) / 10);
    const suffix = filterSuffix(filter);
    const buttons: Button[][] = [];
    if (row.status === 'pending') {
      const actions = [button('New setup link', `reinvite:${userId}`, 'success')];
      if (row.expiresAt && row.expiresAt > this.now())
        actions.push(button('Revoke invite', `revoke:${userId}`));
      buttons.push(actions);
    }
    buttons.push([
      button('File quota', `quota:${userId}${suffix}`),
      button('File size limit', `filelimit:${userId}${suffix}`),
    ]);
    if (row.status !== 'disabled') buttons.push([button('Disable account', `disable:${userId}`)]);
    buttons.push(...this.navigation(`list:${page}${suffix}`));
    return {
      text: [
        `<b>Account details</b>\n${accountStatus(row, this.now())}\n<code>${userId}</code>`,
        `Created · ${dateTime(row.createdAt)}` +
          (row.expiresAt ? `\nInvite expiry · ${dateTime(row.expiresAt)}` : ''),
        '<b>Storage</b>\n' + this.storage(userId).text,
      ].join('\n\n'),
      buttons,
    };
  }
  private fileRepository() {
    return new FileRepository(connect(this.db), this.defaultQuota);
  }
  private storage(userId: string) {
    const files = this.fileRepository(),
      quota = files.quotaInfo(userId),
      limit = files.fileLimitInfo(userId);
    const used = (quota.usedBytes / 1_000_000).toLocaleString('en', { maximumFractionDigits: 6 });
    return {
      quota,
      limit,
      text: `Files: ${used} / ${quota.quotaBytes / 1_000_000} MB (${quota.inherited ? 'server default' : 'custom quota'})\nPer file: ${limit.fileLimitBytes / 1_000_000} MB (${limit.inherited ? 'default' : 'custom limit'})`,
    };
  }
  private quotaScreen(userId: string, perFile: boolean, filter: Filter, saved: boolean): Reply {
    if (!this.auth.list().some((row) => row.userId === userId))
      throw new InputError('Account not found.');
    const action = perFile ? 'filelimit' : 'quota';
    const { quota, limit, text } = this.storage(userId);
    const inherited = perFile ? limit.inherited : quota.inherited;
    const amount = String((perFile ? limit.fileLimitBytes : quota.quotaBytes) / 1_000_000);
    const selected = inherited ? 'default' : presetAmounts.includes(amount) ? amount : 'custom';
    const suffix = filterSuffix(filter);
    const preset = (value: string, label: string) =>
      button(
        selected === value ? '✓ ' + label : label,
        `${action}:${userId}:${value}${suffix}`,
        selected === value ? 'primary' : undefined,
      );
    return {
      text: `<b>${perFile ? 'File size limit' : 'File quota'}</b>\n<code>${userId}</code>\n\n${text}\n\n${saved ? '✓ Setting saved.\n' : ''}Zero pauses new uploads. Existing files stay available.`,
      buttons: [
        presetAmounts.slice(0, 3).map((v) => preset(v, v + ' MB')),
        presetAmounts.slice(3).map((v) => preset(v, v + ' MB')),
        [
          preset('default', `Default · ${perFile ? '10' : this.defaultQuota / 1_000_000} MB`),
          preset('custom', selected === 'custom' ? `Custom · ${amount} MB` : 'Custom amount…'),
        ],
        [button('‹ Account details', `account:${userId}${suffix}`), button('Main menu', 'home')],
      ],
    };
  }
  private setLimit({ action, userId, filter }: LimitPrompt, value: string): Reply {
    if (action === 'filelimit') this.fileRepository().setFileLimit(userId, value);
    else this.fileRepository().setQuota(userId, value);
    return this.quotaScreen(userId, action === 'filelimit', filter, true);
  }
  private amountReply(prompt: LimitPrompt, input: string): Reply {
    if (!/^\d+$/.test(input))
      return customAmount(prompt, 'Enter a nonnegative whole number of MB.');
    try {
      return this.setLimit(prompt, input);
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      return customAmount(prompt, error.message);
    }
  }
  private accounts(page: number, filter: Filter): Reply {
    const rows = this.auth.list().filter((r) => filter === 'all' || r.status === filter);
    const pages = Math.max(1, Math.ceil(rows.length / 10));
    page = Math.min(page, pages - 1);
    const suffix = filterSuffix(filter);
    const buttons: Button[][] = [
      filters.map((f) =>
        button(
          (f === filter ? '✓ ' : '') + labels[f],
          'list:0' + filterSuffix(f),
          f === filter ? 'primary' : undefined,
        ),
      ),
    ];
    for (const row of rows.slice(page * 10, page * 10 + 10)) {
      buttons.push([
        button(
          `${accountStatus(row, this.now())} · …${row.userId.slice(-10)}`,
          `account:${row.userId}${suffix}`,
        ),
      ]);
    }
    const nav: Button[] = [];
    if (page > 0) nav.push(button('‹ Previous', `list:${page - 1}${suffix}`));
    if (page + 1 < pages) nav.push(button('Next ›', `list:${page + 1}${suffix}`));
    if (nav.length) buttons.push(nav);
    buttons.push([button('Invite', 'invite', 'success'), button('Main menu', 'home')]);
    const empty = filter === 'all' ? 'No accounts.' : `No ${filter} accounts.`;
    const summary = rows.length
      ? `${labels[filter]} · ${rows.length} ${rows.length === 1 ? 'account' : 'accounts'} · Page ${page + 1} of ${pages}`
      : empty;
    return {
      text: `<b>Accounts</b>\n${summary}`,
      buttons,
    };
  }
  private command(
    action: string,
    arg: string | undefined,
    messageId?: number,
    filter: Filter = 'all',
  ): Reply {
    if (action === 'start' || action === 'home') return this.menu();
    if (action === 'help')
      return {
        text: '<b>Taskpath admin · Help</b>\n\n<b>Accounts</b>\n/start — dashboard\n/list — browse accounts\n/invite — create a setup link\n\n<b>Account actions</b>\n<code>/reinvite USER_ID</code> — replace a link\n<code>/revoke USER_ID</code> — revoke a link\n<code>/disable USER_ID</code> — review and confirm\n\n<b>Storage</b>\n<code>/quota USER_ID</code> — total quota\n<code>/filelimit USER_ID</code> — per-file limit\nAppend a whole MB amount or <code>default</code> to change it.\n/backup — download the database',
        buttons: this.navigation(),
      };
    if (action === 'account') {
      if (!validUserId(arg)) throw new InputError('Provide a valid USER_ID.');
      return this.account(arg, filter);
    }
    if (action === 'quota' || action === 'filelimit') {
      const [userId, value, ...extra] = (arg || '').split(/[:\s]+/);
      if (!validUserId(userId) || extra.length)
        throw new InputError(`Usage: /${action} USER_ID [MB|default]`);
      if (value === 'custom') {
        if (!this.auth.list().some((row) => row.userId === userId))
          throw new InputError('Account not found.');
        return customAmount({ action, userId, filter });
      }
      if (value !== undefined) return this.setLimit({ action, userId, filter }, value);
      return this.quotaScreen(userId, action === 'filelimit', filter, false);
    }
    if (action === 'backup') {
      if (arg !== undefined) throw new InputError('Usage: /backup');
      return { text: '', backup: true };
    }
    if (action === 'list') {
      if (arg !== undefined && !/^\d{1,8}$/.test(arg)) throw new InputError('Invalid page.');
      return this.accounts(Number(arg || 0), filter);
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
      if (action === 'cancel')
        return { text: 'Disable cancelled.', buttons: this.receiptButtons(pending.userId) };
      this.auth.disable(pending.userId);
      return {
        text: `<b>Account disabled</b>\n<code>${pending.userId}</code>\nSessions revoked. Encrypted data retained.`,
        buttons: this.receiptButtons(pending.userId),
      };
    }
    if (['reinvite', 'revoke', 'disable'].includes(action) && !validUserId(arg))
      throw new InputError('Provide a valid USER_ID.');
    if (action === 'invite' || action === 'reinvite') {
      if (action === 'invite' && arg !== undefined) throw new InputError('Usage: /invite');
      const invite =
        action === 'invite' ? this.auth.createInvitation() : this.auth.renewInvitation(arg!);
      const url = invitationURL(this.config.origin, invite.userId, invite.token);
      const buttons = this.receiptButtons(invite.userId);
      if (url.length <= 256)
        buttons.unshift([{ text: 'Copy setup link', copy_text: { text: url }, style: 'primary' }]);
      return {
        text: `<b>Invitation ready</b>\n<code>${invite.userId}</code>\n\nShare this link with the recipient (one use, 24 hours).\n<code>${html(url)}</code>\n\nExpires · ${dateTime(invite.expiresAt)}`,
        buttons,
      };
    }
    if (action === 'revoke') {
      this.auth.revokeInvitation(arg!);
      return {
        text: `<b>Invitation revoked</b>\n<code>${arg}</code>`,
        buttons: this.receiptButtons(arg),
      };
    }
    if (action === 'disable') {
      if (!this.auth.list().some((row) => row.userId === arg && row.status !== 'disabled'))
        throw new InputError('Enabled account not found.');
      const nonce = randomBytes(12).toString('hex');
      this.confirmations.set(nonce, { userId: arg!, expires: this.now() + 300_000 });
      return {
        text: `<b>Disable this account?</b>\n<code>${arg}</code>\n\nAll sessions will close. Encrypted data is retained.\nConfirm within five minutes.`,
        confirmation: nonce,
        buttons: [
          [
            button('Confirm disable', `confirm:${nonce}`, 'danger'),
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
            const data = (callback.data || '').replace(/^open:(?=home$|list:|account:)/, '');
            const match =
              /^(home|help|account|invite|list|reinvite|revoke|disable|confirm|cancel|backup|quota|filelimit)(?::([^|]+))?(?:\|(active|pending|disabled))?$/.exec(
                data,
              );
            if (match)
              reply = this.command(
                match[1]!,
                match[2],
                message!.message_id,
                match[3] as Filter | undefined,
              );
          } else {
            const match =
              /^\/(start|help|invite|list|reinvite|revoke|disable|backup|quota|filelimit)(?:\s+(.+?))?\s*$/.exec(
                message?.text || '',
              );
            const prompt = this.limitPrompt;
            const input = message?.text?.trim() || '';
            if (match) reply = this.command(match[1]!, match[2]);
            else if (prompt && message?.reply_to_message?.message_id === prompt.messageId)
              reply = this.amountReply(prompt, input);
            else if (message?.reply_to_message && /^\d+$/.test(input))
              throw new InputError(
                'That amount prompt has closed. Open the account and choose Custom amount again.',
              );
            else reply = this.menu();
          }
        } catch (error) {
          if (!(error instanceof InputError)) throw error;
          reply = { text: html(error.message) };
        }
      }
      this.db
        .query(
          'INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        )
        .run(this.key, String(update.update_id + 1));
    })();
    if (!consumed || !authorized) return;
    if (
      callback ||
      message?.text?.startsWith('/') ||
      message?.reply_to_message?.message_id === this.limitPrompt?.messageId
    )
      this.limitPrompt = undefined;
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
      const body = {
        chat_id: this.config.adminId,
        text: reply.text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: reply.prompt
          ? { force_reply: true, input_field_placeholder: 'Amount in MB' }
          : { inline_keyboard: reply.buttons?.length ? reply.buttons : this.navigation() },
      };
      if (
        callback &&
        !reply.prompt &&
        /^(home|help|list|account|quota|filelimit)(:|$)/.test(callback.data || '')
      ) {
        try {
          await this.api('editMessageText', { ...body, message_id: message!.message_id });
          return;
        } catch (error) {
          if (!(error instanceof TelegramError)) throw error;
          if (error.unchanged) return;
          if (!error.fatal) throw error;
        }
      }
      const result = await this.api('sendMessage', body);
      if (reply.prompt) this.limitPrompt = { ...reply.prompt, messageId: result.message_id };
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
          reply_markup: { inline_keyboard: this.receiptButtons() },
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
      form.set('reply_markup', JSON.stringify({ inline_keyboard: this.receiptButtons() }));
      await this.api('sendDocument', form);
    } catch {
      if (!this.controller.signal.aborted) {
        this.report('Telegram database backup failed.');
        await this.api('sendMessage', {
          chat_id: this.config.adminId,
          reply_markup: { inline_keyboard: this.receiptButtons() },
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
    this.limitPrompt = undefined;
    this.confirmations.clear();
    await this.running;
  }
}
