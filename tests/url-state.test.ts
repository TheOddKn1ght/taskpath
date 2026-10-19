import { expect, test } from 'bun:test';
import { base64, importVault, random } from '../public/crypto.js';
import { decryptRoute, encryptRoute, validateRoute } from '../public/url-state.js';
import { emptyRoute } from '../public/ui/routes.js';
import type { Route } from '../public/types.js';

const rawKey = random(32), key = await importVault(rawKey);
const userId = 'u_1234567890abcdef1234567890abcdef', vaultId = 'private-vault-id';
const urlBase64 = (value: Uint8Array<ArrayBuffer>) => base64(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

function fullRoute(): Route {
  return {
    view: 'calendar', query: 'PRIVATE board query', category: 'work', tag: 'private-tag',
    calendar: { mode: 'week', anchor: '2026-10-19', selected: '2026-10-22' },
    searchOpen: true,
    searchState: {
      query: 'PRIVATE advanced search', scope: 'archived', status: 'done', category: 'personal',
      tags: ['private-tag', '🔒'.repeat(32)], due: 'overdue', reminder: 'yes',
    },
    fileQuery: 'PRIVATE attachment filter', details: 'private-selected-task',
    editor: {
      taskId: 'private-editor-task', status: 'week', due: '2026-10-23',
      draft: { title: 'PRIVATE imported title', notes: 'PRIVATE imported notes', tags: ['imported'], category: 'work' },
      values: {
        title: 'PRIVATE unfinished title', notes: 'PRIVATE unfinished notes\n第二行 🔒',
        tags: ['private-tag', '🔒'.repeat(32)], tag: 'PRIVATE uncommitted tag',
        column: 'today', category: 'personal', due: '2026-10-24', reminder: '2026-10-22T09:30',
      },
    },
    quickAdd: { later: 'PRIVATE later draft', week: 'PRIVATE week draft', today: 'PRIVATE today draft', done: '' },
  };
}

// Produce authenticated payloads independently so decryption must validate their contents too.
async function encryptedPayload(value: unknown, additionalData = JSON.stringify(['taskpath:url-state', 1, userId, vaultId])) {
  const nonce = random(12), encoder = new TextEncoder();
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(additionalData) }, key, encoder.encode(JSON.stringify(value)),
  ));
  return `#state=v1.${urlBase64(nonce)}.${urlBase64(ciphertext)}`;
}

test('encrypted URLs restore all view, filter, calendar, task selection, and unfinished edit fields', async () => {
  const route = fullRoute(), hash = await encryptRoute(route, key, userId, vaultId);
  expect(await decryptRoute(hash, key, userId, vaultId)).toEqual(route);
  expect(await decryptRoute(await encryptRoute({ ...emptyRoute, focus: 'today' }, key, userId, vaultId), key, userId, vaultId))
    .toEqual({ ...emptyRoute, focus: 'today' });
  expect(hash).toMatch(/^#state=v1\.[\w-]{16}\.[\w-]+$/);
  for (const secret of [
    route.query, route.tag, route.fileQuery!, route.details!, route.searchState!.query,
    route.editor!.taskId!, route.editor!.draft!.notes, route.editor!.values!.title,
    route.editor!.values!.notes, route.editor!.values!.tag, route.quickAdd!.later!, userId, vaultId,
    base64(rawKey), urlBase64(rawKey), Buffer.from(rawKey).toString('hex'),
  ]) expect(hash).not.toContain(secret);
  const url = new URL(`https://taskpath.example/${hash}`);
  expect(url.search).toBe('');
  expect(url.hash).toBe(hash);
  expect(key.extractable).toBe(false);
});

test('saving identical state uses a fresh nonce and ciphertext every time', async () => {
  const route = fullRoute();
  const hashes = await Promise.all(Array.from({ length: 8 }, () => encryptRoute(route, key, userId, vaultId)));
  expect(new Set(hashes.map(hash => hash.split('.')[1])).size).toBe(hashes.length);
  expect(new Set(hashes.map(hash => hash.split('.')[2])).size).toBe(hashes.length);
  for (const hash of hashes) expect(await decryptRoute(hash, key, userId, vaultId)).toEqual(route);
});

test('encrypted state is bound to its account, vault, key, and URL-state purpose', async () => {
  const hash = await encryptRoute(fullRoute(), key, userId, vaultId);
  expect(await decryptRoute(hash, key, 'another-account', vaultId)).toEqual(emptyRoute);
  expect(await decryptRoute(hash, key, userId, 'another-vault')).toEqual(emptyRoute);
  expect(await decryptRoute(hash, await importVault(random(32)), userId, vaultId)).toEqual(emptyRoute);
  const otherPurpose = await encryptedPayload(fullRoute(), JSON.stringify(['taskpath:task', 1, userId, vaultId]));
  expect(await decryptRoute(otherPurpose, key, userId, vaultId)).toEqual(emptyRoute);
  const segmented = await encryptRoute(fullRoute(), key, 'ab', 'c');
  expect(await decryptRoute(segmented, key, 'a', 'bc')).toEqual(emptyRoute);
});

test('tampered, truncated, unknown-version, malformed, and oversized links safely reset the route', async () => {
  const hash = await encryptRoute(fullRoute(), key, userId, vaultId);
  const [prefix, nonce, ciphertext] = hash.split('.');
  const changeFirst = (value: string) => (value[0] === 'A' ? 'B' : 'A') + value.slice(1);
  const invalid = [
    '', '#board?q=PRIVATE', '#state=v1.', '#state=v1.short.abc',
    `${prefix}.${changeFirst(nonce)}.${ciphertext}`, `${prefix}.${nonce}.${changeFirst(ciphertext)}`,
    hash.slice(0, -10), `${prefix}.${nonce}.AA`, hash.replace('#state=v1.', '#state=v2.'),
    hash + '=ignored', hash + '?q=ignored', `${prefix}.${nonce}.!invalid`,
    `#state=v1.${nonce}.${'a'.repeat(131072)}`,
  ];
  for (const input of invalid) expect(await decryptRoute(input, key, userId, vaultId)).toEqual(emptyRoute);
});

test('large Unicode notes at the editor limit survive reload, including empty field edits', async () => {
  const route = fullRoute();
  route.editor!.values = {
    title: '', notes: '🔒私人'.repeat(2500), tags: [], tag: '',
    column: 'later', category: 'work', due: '', reminder: '',
  };
  expect(route.editor!.values!.notes.length).toBe(10000);
  expect(await decryptRoute(await encryptRoute(route, key, userId, vaultId), key, userId, vaultId)).toEqual(route);
});

test('draft reminder instants survive device changes while legacy local inputs remain readable', async () => {
  const route = fullRoute();
  route.editor!.values!.reminderAt = '2031-07-22T09:35:00.000Z';
  expect(await decryptRoute(await encryptRoute(route, key, userId, vaultId), key, userId, vaultId)).toEqual(route);
  route.editor!.values!.reminderAt = null;
  expect(await decryptRoute(await encryptRoute(route, key, userId, vaultId), key, userId, vaultId)).toEqual(route);
  delete route.editor!.values!.reminderAt;
  expect(await decryptRoute(await encryptRoute(route, key, userId, vaultId), key, userId, vaultId)).toEqual(route);
  for (const reminderAt of ['not-a-date', '2031-02-30T09:35:00.000Z', '2031-07-22T09:35:00+00:00']) {
    route.editor!.values!.reminderAt = reminderAt;
    expect(await decryptRoute(await encryptedPayload(route), key, userId, vaultId)).toEqual(emptyRoute);
  }
});

const invalidRoutes: [string, () => unknown][] = [
  ['non-object route', () => null],
  ['unknown view', () => ({ ...emptyRoute, view: 'settings' })],
  ['wrong query type', () => ({ ...emptyRoute, query: [] })],
  ['unknown category', () => ({ ...emptyRoute, category: 'secret' })],
  ['oversized selected tag', () => ({ ...emptyRoute, tag: 'x'.repeat(81) })],
  ['invalid task ID', () => ({ ...emptyRoute, details: '../task' })],
  ['invalid focus', () => ({ ...emptyRoute, focus: 'tomorrow' })],
  ['invalid calendar date', () => ({ ...emptyRoute, calendar: { mode: 'week', anchor: '2026-02-30', selected: '2026-10-19' } })],
  ['invalid search enum', () => ({ ...fullRoute(), searchState: { ...fullRoute().searchState, scope: 'everyone' } })],
  ['invalid search tags', () => ({ ...fullRoute(), searchState: { ...fullRoute().searchState, tags: [42] } })],
  ['invalid quick-add column', () => ({ ...emptyRoute, quickAdd: { tomorrow: 'Draft' } })],
  ['oversized quick-add title', () => ({ ...emptyRoute, quickAdd: { today: 'x'.repeat(241) } })],
  ['invalid editor status', () => ({ ...emptyRoute, editor: { status: 'tomorrow' } })],
  ['invalid imported draft', () => ({ ...fullRoute(), editor: { ...fullRoute().editor, draft: { title: 'Task', notes: '', tags: [], category: 'secret' } } })],
  ['incomplete editor values', () => ({ ...emptyRoute, editor: { status: 'later', values: { title: 'Task' } } })],
  ['oversized editor notes', () => ({ ...fullRoute(), editor: { ...fullRoute().editor, values: { ...fullRoute().editor!.values, notes: 'x'.repeat(10001) } } })],
  ['invalid editor due date', () => ({ ...fullRoute(), editor: { ...fullRoute().editor, values: { ...fullRoute().editor!.values, due: '2026-13-01' } } })],
];

for (const [label, invalid] of invalidRoutes) {
  test(`invalid decrypted state is rejected: ${label}`, async () => {
    const value = invalid();
    expect(() => validateRoute(value)).toThrow();
    expect(await decryptRoute(await encryptedPayload(value), key, userId, vaultId)).toEqual(emptyRoute);
    await expect(encryptRoute(value as Route, key, userId, vaultId)).rejects.toThrow();
  });
}

test('individually valid fields cannot produce an excessively large encrypted URL', async () => {
  const route = fullRoute();
  route.query = route.fileQuery = route.searchState!.query = '界'.repeat(10000);
  route.editor!.values!.notes = '界'.repeat(10000);
  expect(validateRoute(route)).toEqual(route);
  await expect(encryptRoute(route, key, userId, vaultId)).rejects.toThrow('too large');
});
