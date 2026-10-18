import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { startQaSession } from '../scripts/qa-dev';
import { seedQaWorkspace } from '../scripts/qa-seed';
import { createVault, decryptEnvelope, unlockVault } from '../public/crypto';
import { project, validate } from '../public/offline-model';
import { Store } from '../src/store';

const root = resolve(import.meta.dir, '..');
// Static, side-effect, dynamic and require imports: anything that could pull QA code in.
function imports(source: string) {
  return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)]
    .map(match => match[1]!);
}

async function open(session: { url: string; origin: string }) {
  const token = new URL(session.url).hash.slice(7);
  const claimed = await fetch(session.origin + '/__qa/claim', { method: 'POST', headers: { Origin: session.origin, Authorization: 'Bearer ' + token } });
  const data = await claimed.json();
  const unlocked = await unlockVault(data.password, data.config);
  const login = await fetch(session.origin + '/api/auth/login', {
    method: 'POST', headers: { Origin: session.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: data.userId, credential: unlocked.credential, revision: data.config.revision }),
  });
  return { data, unlocked, cookie: login.headers.get('set-cookie')!.split(';')[0] };
}

test('QA opens a disposable workspace pre-filled with tasks and files', async () => {
  const session = await startQaSession();
  try {
    const { data, unlocked, cookie } = await open(session);
    const board = await (await fetch(session.origin + '/api/sync', { headers: { Cookie: cookie, 'x-taskpath-sync': '2' } })).json();
    expect(board.rows.length).toBeGreaterThan(0);
    const rows = [];
    for (const envelope of board.rows) {
      const task = await decryptEnvelope(unlocked.key, data.config.vaultId, envelope);
      validate(task);
      rows.push(task);
    }
    const view = project({ board: { rows, changeIds: {}, timezone: board.timezone }, pending: [], offset: 0, lastEdit: 0 });
    const columns = new Set(view.tasks.map(task => task.status));
    expect([...columns].sort()).toEqual(['done', 'later', 'today', 'week']);
    expect(view.tasks.some(task => task.archivedAt)).toBe(true);
    const manifest = await (await fetch(session.origin + '/api/files', { headers: { Cookie: cookie, 'x-taskpath-user': data.userId } })).json();
    expect(manifest.files.length).toBeGreaterThan(0);
    expect(manifest.usedBytes).toBeGreaterThan(0);
  } finally { await session.stop(); }
});

test('QA launcher and seed refuse production and never enter production source', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await expect(startQaSession()).rejects.toThrow('production');
    const store = new Store(':memory:');
    try {
      const vault = await createVault('correct horse battery staple');
      await expect(seedQaWorkspace({ store, userId: 'u_' + '1'.repeat(32), vaultId: vault.config.vaultId, key: vault.key }))
        .rejects.toThrow('production');
    } finally { store.close(); }
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
  // Production ships src/* and the bundled public/* client. Neither may reach
  // the disposable QA scripts, which only exist for `bun run qa`.
  for (const directory of ['src', 'public']) {
    const files = new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: resolve(root, directory) });
    let scanned = 0;
    for (const file of files) {
      scanned++;
      const source = await Bun.file(resolve(root, directory, file)).text();
      for (const specifier of imports(source)) {
        expect(specifier, `${directory}/${file}`).not.toMatch(/(?:^|\/)qa-(?:dev|seed)\b/);
        expect(specifier, `${directory}/${file}`).not.toMatch(/(?:^|\/)scripts\//);
      }
    }
    expect(scanned, directory).toBeGreaterThan(0);
  }
});
