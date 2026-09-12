import { test, expect } from 'bun:test';
import { runInNewContext } from 'node:vm';

const html = await Bun.file('public/index.html').text();
const source = new Bun.Transpiler({loader: 'ts'}).transformSync((await Bun.file('public/vault-ui.ts').text()).replace(/^import .*\n/gm, '').replace('export async function startVault', 'async function startVault'));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function startup(hash = '', overrides = {}) {
  const load = deferred<void>(), restore = deferred<boolean>();
  const nodes = new Map<string, any>(), visibility: boolean[] = [], listeners = new Map<string, Function>();
  const classes = new Set(['vault-locked']);
  let restoreCalls = 0;
  function node(id: string) {
    if (!nodes.has(id)) {
      let hidden = id === '#unlock-screen' || id === '#unlock-error';
      nodes.set(id, {
        get hidden() { return hidden; },
        set hidden(value) { hidden = value; if (id === '#unlock-screen') visibility.push(!value); },
        inert: id === '#main', value: '', textContent: '',
        attributes: new Map(), handlers: new Map(),
        setAttribute(name: string, value: string) { this.attributes.set(name, value); },
        addEventListener(name: string, callback: Function) { this.handlers.set(name, callback); }, reset() {}, focus() {},
      });
    }
    return nodes.get(id);
  }
  const context = {
    $: node, Error, validateConfig: (input: unknown) => input, errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error), errorStatus: (error: {status?: number}) => error.status,
    URLSearchParams, location: { hash }, history: { replaceState() {} },
    document: { querySelector: node, querySelectorAll: () => [], body: { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } } },
    window: { addEventListener: (name: string, callback: Function) => listeners.set(name, callback) },
    selectedAccount: () => 'u_test', loadAccount: () => load.promise,
    restoreRemembered: () => { restoreCalls++; return restore.promise; },
    ...overrides,
  };
  const start = runInNewContext(source + '\nstartVault;', context);
  const ready = start();
  return { ready, load, restore, node, visibility, classes, listeners, restoreCalls: () => restoreCalls };
}

test('remembered startup never reveals sign-in while device storage is pending', async () => {
  // Native hidden works even before styles or modules arrive.
  expect(html).toMatch(/<section\b[^>]*id="unlock-screen"[^>]*\bhidden\s*>/);
  const ui = startup();
  expect(ui.node('#unlock-screen').hidden).toBe(true);
  expect(ui.node('#vault-loading').hidden).toBe(false);
  expect(ui.node('#main').inert).toBe(true);
  ui.load.resolve(); await tick();
  expect(ui.visibility).toEqual([]);
  ui.restore.resolve(true); await ui.ready;
  expect(ui.visibility).toEqual([false]);
  expect(ui.node('#vault-loading').hidden).toBe(true);
  expect(ui.node('#main').inert).toBe(false);
  // Explicit locking still reveals the gate immediately.
  ui.listeners.get('taskpath-locked')!();
  expect(ui.node('#unlock-screen').hidden).toBe(false);
  expect(ui.node('#main').inert).toBe(true);
});

test('unlock shows progress, ignores repeated submissions, and recovers from a failed attempt', async () => {
  const config = deferred<any>(); let requests = 0;
  const ui = startup('', {
    validUserId: () => true, crypto: { subtle: {} }, localState: async () => ({}),
    network: () => { requests++; return config.promise; }, validateConfig: (input: unknown) => input,
    unlockVault: async () => { throw new Error('Wrong password'); },
  });
  ui.load.resolve(); await tick(); ui.restore.resolve(false); await tick();
  ui.node('#unlock-user').value = 'u_test'; ui.node('#unlock-password').value = 'incorrect test password';
  const submit = ui.node('#unlock-form').handlers.get('submit');
  const pending = submit({ preventDefault() {} }); await tick();
  expect(ui.node('#unlock-submit').disabled).toBe(true);
  expect(ui.node('#unlock-progress').textContent).toBe('Unlocking your workspace…');
  expect(ui.node('#main').inert).toBe(true);
  await submit({ preventDefault() {} }); expect(requests).toBe(1);
  config.resolve({ config: { vaultId: 'test' } }); await pending;
  expect(ui.node('#unlock-error').textContent).toBe('User ID or password is incorrect.');
  expect(ui.node('#unlock-password').value).toBe('');
  expect(ui.node('#unlock-submit').disabled).toBe(false);
  expect(ui.node('#unlock-submit').attributes.get('aria-busy')).toBe('false');
  expect(ui.node('#unlock-progress').textContent).toBe('');
});

test('a device without a remembered key shows sign-in only after checking storage', async () => {
  const ui = startup(); ui.load.resolve(); await tick();
  expect(ui.visibility).toEqual([]);
  ui.restore.resolve(false); await tick();
  expect(ui.visibility).toEqual([true]);
  expect(ui.node('#vault-loading').hidden).toBe(true);
  expect(ui.classes.has('vault-locked')).toBe(true);
});

test('invitations show setup and do not restore another remembered vault', async () => {
  const ui = startup('#user=u_invited&setup=test-token'); ui.load.resolve(); await tick();
  expect(ui.restoreCalls()).toBe(0);
  expect(ui.node('#unlock-screen').hidden).toBe(false);
  expect(ui.node('#unlock-title').textContent).toBe('Your private vault');
  expect(ui.node('#unlock-user').value).toBe('u_invited');
});

test('storage failures leave startup with a visible locked error', async () => {
  for (const phase of ['load', 'restore'] as const) {
    const ui = startup();
    if (phase === 'restore') { ui.load.resolve(); await tick(); }
    ui[phase].reject(new Error('Storage unavailable')); await tick();
    expect(ui.node('#vault-loading').hidden).toBe(true);
    expect(ui.node('#unlock-screen').hidden).toBe(false);
    expect(ui.node('#unlock-error').hidden).toBe(false);
    expect(ui.node('#unlock-error').textContent).toContain('device storage');
    expect(ui.node('#main').inert).toBe(true);
  }
});
