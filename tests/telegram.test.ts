import { expect, test } from 'bun:test';
import { Store } from '../src/store';
import { AuthManager } from '../src/auth';
import { TelegramAdmin, telegramConfig, type TelegramUpdate } from '../src/telegram';
import { fixture, testUserId, testVault } from './auth-helpers';

const config = { token: '123:test_token', adminId: 42, origin: 'https://tasks.example.com' };
function setup() {
  const store = new Store(':memory:', undefined, 'UTC');
  const auth = new AuthManager(store.db);
  const calls: { method: string; body: any }[] = [];
  let messageId = 100;
  let clock = Date.now();
  let failSend = false;
  const request = (async (url: any, init: any) => {
    const method = String(url).split('/').at(-1)!;
    calls.push({ method, body: JSON.parse(init.body) });
    if (method === 'sendMessage' && failSend) throw new Error('secret URL must not escape');
    return Response.json({ ok: true, result: { message_id: ++messageId } });
  }) as typeof fetch;
  const makeBot = () => new TelegramAdmin(store.db, auth, config, request, () => clock);
  return {
    store,
    auth,
    calls,
    makeBot,
    bot: makeBot(),
    advance: () => {
      clock += 300_001;
    },
    fail: () => {
      failSend = true;
    },
  };
}
const message = (id: number, text: string, user = 42, type = 'private'): TelegramUpdate => ({
  update_id: id,
  message: { message_id: id, from: { id: user }, chat: { id: user, type }, text },
});
const callback = (
  id: number,
  data: string,
  messageId: number,
  user = 42,
  type = 'private',
): TelegramUpdate => ({
  update_id: id,
  callback_query: {
    id: `cb${id}`,
    data,
    from: { id: user },
    message: { message_id: messageId, chat: { id: user, type } },
  },
});
const replies = (calls: { method: string; body: any }[]) =>
  calls.filter((call) => call.method === 'sendMessage');

test('optional configuration requires a complete allowlist and HTTPS origin', () => {
  expect(telegramConfig({})).toBeNull();
  expect(
    telegramConfig({
      TASKPATH_TELEGRAM_BOT_TOKEN: config.token,
      TASKPATH_TELEGRAM_ADMIN_ID: '42',
      TASKPATH_ORIGIN: config.origin,
    }),
  ).toEqual(config);
  for (const env of [
    { TASKPATH_TELEGRAM_BOT_TOKEN: config.token },
    { TASKPATH_TELEGRAM_ADMIN_ID: '42' },
    {
      TASKPATH_TELEGRAM_ADMIN_ID: '9007199254740992',
      TASKPATH_TELEGRAM_BOT_TOKEN: config.token,
      TASKPATH_ORIGIN: config.origin,
    },
    {
      TASKPATH_TELEGRAM_ADMIN_ID: '42',
      TASKPATH_TELEGRAM_BOT_TOKEN: config.token,
      TASKPATH_ORIGIN: 'http://localhost',
    },
    {
      TASKPATH_TELEGRAM_ADMIN_ID: '42',
      TASKPATH_TELEGRAM_BOT_TOKEN: config.token,
      TASKPATH_ORIGIN: 'https://user:secret@example.com',
    },
  ])
    expect(() => telegramConfig(env)).toThrow();
});

test('rejects other senders, groups, and missing sender before commands and callbacks', async () => {
  const f = setup();
  try {
    await f.bot.handle(message(1, '/invite', 43));
    await f.bot.handle(message(2, '/invite', 42, 'group'));
    await f.bot.handle(callback(3, 'invite', 100, 43));
    await f.bot.handle(callback(4, 'invite', 100, 42, 'supergroup'));
    const missing = message(5, '/invite');
    delete missing.message!.from;
    await f.bot.handle(missing);
    expect(f.auth.list()).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  } finally {
    f.store.close();
  }
});

test('menu, invitation, renew and revoke use existing account rules', async () => {
  const f = setup();
  try {
    await f.bot.handle(message(1, '/start'));
    expect(
      replies(f.calls)[0]!.body.reply_markup.inline_keyboard[0].map((b: any) => b.text),
    ).toEqual(['Invite', 'Accounts']);
    await f.bot.handle(callback(2, 'invite', 101));
    const invitation = replies(f.calls).at(-1)!.body;
    expect(invitation.text).toContain('https://tasks.example.com/#user=');
    expect(invitation.text).toContain('one use, 24 hours');
    expect(invitation.link_preview_options.is_disabled).toBe(true);
    const id = f.auth.list()[0]!.userId;
    await f.bot.handle(message(3, `/reinvite ${id}`));
    expect(replies(f.calls).at(-1)!.body.text).not.toBe(invitation.text);
    await f.bot.handle(callback(4, `revoke:${id}`, 101));
    expect(f.auth.list()[0]!.expiresAt).toBeNull();
    await f.bot.handle(message(5, '/reinvite invalid'));
    expect(replies(f.calls).at(-1)!.body.text).toContain('valid USER_ID');
    await f.bot.handle(message(6, '/invite extra'));
    expect(f.auth.list()).toHaveLength(1);
  } finally {
    f.store.close();
  }
});

test('accounts paginate ten per page and expose applicable actions', async () => {
  const f = setup();
  try {
    for (let i = 0; i < 11; i++) f.auth.createInvitation();
    await f.bot.handle(message(1, '/list'));
    const first = replies(f.calls).at(-1)!.body;
    expect(first.text).toContain('Accounts (1/2)');
    expect(first.text.match(/pending/g)).toHaveLength(10);
    expect(first.reply_markup.inline_keyboard.at(-1)).toEqual([
      { text: 'Next', callback_data: 'list:1' },
    ]);
    await f.bot.handle(callback(2, 'list:1', 101));
    const next = replies(f.calls).at(-1)!.body;
    expect(next.text).toContain('Accounts (2/2)');
    expect(next.text.match(/pending/g)).toHaveLength(1);
  } finally {
    f.store.close();
  }
});

test('disable confirmation is bound to sender and message, single-use, and revokes sessions', async () => {
  const f = await fixture();
  const calls: any[] = [];
  const bot = new TelegramAdmin(f.store.db, f.auth, config, (async (_url: any, init: any) => {
    calls.push(JSON.parse(init.body));
    return Response.json({ ok: true, result: { message_id: 101 } });
  }) as typeof fetch);
  try {
    const session = await f.auth.login('test', testUserId, testVault.credential, 1);
    const request = new Request(config.origin, {
      headers: { cookie: `taskpath_session=${session.token}` },
    });
    await bot.handle(message(1, `/disable ${testUserId}`));
    const data = calls[0].reply_markup.inline_keyboard[0][0].callback_data;
    expect(f.auth.identity(request)).toBe(testUserId);
    await bot.handle(callback(2, data, 101, 43));
    await bot.handle(callback(3, data, 999));
    expect(f.auth.identity(request)).toBe(testUserId);
    await bot.handle(callback(4, data, 101));
    expect(f.auth.identity(request)).toBeNull();
    expect(f.auth.list()[0]!.status).toBe('disabled');
    await bot.handle(callback(5, data, 101));
    expect(calls.at(-1).text).toContain('expired');
  } finally {
    f.store.close();
  }
});

for (const action of ['expire', 'restart', 'cancel']) {
  test(`confirmation cannot disable after ${action}`, async () => {
    const f = setup();
    try {
      const id = f.auth.createInvitation().userId;
      await f.bot.handle(message(1, `/disable ${id}`));
      const data = replies(f.calls).at(-1)!.body.reply_markup.inline_keyboard[0][0].callback_data;
      if (action === 'expire') f.advance();
      if (action === 'cancel')
        await f.bot.handle(callback(2, data.replace('confirm:', 'cancel:'), 101));
      const bot = action === 'restart' ? f.makeBot() : f.bot;
      await bot.handle(callback(3, data, 101));
      expect(f.auth.list()[0]!.status).toBe('pending');
      expect(replies(f.calls).at(-1)!.body.text).toContain('expired');
    } finally {
      f.store.close();
    }
  });
}

test('lost reply and restart do not replay account mutation', async () => {
  const f = setup();
  try {
    f.fail();
    await expect(f.bot.handle(message(1, '/invite'))).rejects.toThrow('Telegram request failed.');
    expect(f.auth.list()).toHaveLength(1);
    await f.makeBot().handle(message(1, '/invite'));
    expect(f.auth.list()).toHaveLength(1);
    expect(replies(f.calls)).toHaveLength(1);
  } finally {
    f.store.close();
  }
});

test('database failure rolls back invitation and checkpoint together', async () => {
  const f = setup();
  try {
    f.store.db.exec(
      "CREATE TRIGGER reject_offset BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT, 'disk failure'); END",
    );
    await expect(f.bot.handle(message(1, '/invite'))).rejects.toThrow();
    expect(f.auth.list()).toHaveLength(0);
    f.store.db.exec('DROP TRIGGER reject_offset');
    await f.bot.handle(message(1, '/invite'));
    expect(f.auth.list()).toHaveLength(1);
  } finally {
    f.store.close();
  }
});

test('polling checks webhook, uses persisted offset, and aborts on shutdown', async () => {
  const f = setup();
  const calls: any[] = [];
  let entered!: () => void;
  const polling = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const bot = new TelegramAdmin(f.store.db, f.auth, config, (async (url: any, init: any) => {
    const method = String(url).split('/').at(-1);
    calls.push([method, JSON.parse(init.body)]);
    if (method !== 'getUpdates') return Response.json({ ok: true, result: {} });
    entered();
    return new Promise((_resolve, reject) =>
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
    );
  }) as typeof fetch);
  try {
    await f.bot.handle(message(9, '/help'));
    bot.start();
    await polling;
    await bot.stop();
    expect(calls.map((c) => c[0])).toEqual(['getMe', 'getWebhookInfo', 'getUpdates']);
    expect(calls[2][1].offset).toBe(10);
  } finally {
    f.store.close();
  }
});

for (const kind of ['webhook', 'credentials', 'conflict', 'network', 'rate-limit']) {
  test(`isolates ${kind} errors and shutdown interrupts retry waits`, async () => {
    const f = setup();
    const logs: string[] = [];
    let reported!: () => void;
    const done = new Promise<void>((resolve) => {
      reported = resolve;
    });
    const bot = new TelegramAdmin(
      f.store.db,
      f.auth,
      config,
      (async (url: any) => {
        if (kind === 'network') throw new Error(`secret ${url}`);
        if (kind === 'webhook')
          return Response.json({ ok: true, result: { url: 'https://existing' } });
        return Response.json({
          ok: false,
          error_code: kind === 'credentials' ? 401 : kind === 'conflict' ? 409 : 429,
          parameters: { retry_after: 60 },
        });
      }) as typeof fetch,
      Date.now,
      (text) => {
        logs.push(text);
        reported();
      },
    );
    try {
      bot.start();
      await done;
      await bot.stop();
      expect(logs).toHaveLength(1);
      expect(logs[0]).not.toContain(config.token);
      expect(f.auth.list()).toHaveLength(0);
    } finally {
      f.store.close();
    }
  });
}
