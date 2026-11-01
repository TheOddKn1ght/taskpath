import { expect, test } from 'bun:test';
import { createRouter, offlineRoutes, parseWorkspaceHash, workspaceViews } from '../public/router';
import { serverRoutes } from '../src/router';
import { queueChange } from '../public/offline-model';
import { ClientStore } from './client-helpers';

const routes = createRouter({
  task: '/tasks/:id',
  timer: '/tasks/:id/timer',
  create: '/tasks/new',
  asset: '/assets/*path',
});

test('literal routes take priority and parameters match whole path segments', () => {
  expect(routes.match('/tasks/new')).toEqual({ name: 'create', params: {} });
  expect(routes.match('/tasks/a-b_1')).toEqual({ name: 'task', params: { id: 'a-b_1' } });
  expect(routes.match('/tasks/a/timer')).toEqual({ name: 'timer', params: { id: 'a' } });
  for (const path of [
    '/tasks',
    '/tasks/',
    '/tasks/a/',
    '/tasks//timer',
    '/tasks/a/timer/extra',
    '/tasks/a?x=1',
    '/tasks/a#x',
    'tasks/a',
  ]) {
    expect(routes.match(path)).toBeNull();
  }
});

test('wildcards preserve raw paths without implicit decoding or normalization', () => {
  expect(routes.match('/assets/release/ui/app.js')).toEqual({
    name: 'asset',
    params: { path: 'release/ui/app.js' },
  });
  expect(routes.match('/assets/')).toEqual({ name: 'asset', params: { path: '' } });
  expect(routes.match('/assets')).toBeNull();
  expect(routes.match('/tasks/a%2Fb')?.params.id).toBe('a%2Fb');
  expect(routes.match('/assets/release/../secret')?.params.path).toBe('release/../secret');
  expect(serverRoutes.match('/api/files/one/two')).toEqual({
    name: 'file',
    params: { fileId: 'one/two' },
  });
});

test('route definitions reject ambiguous literals and invalid parameter declarations', () => {
  expect(() => createRouter({ a: '/same', b: '/same' })).toThrow();
  for (const pattern of [
    'relative',
    '/tasks/:',
    '/tasks/*',
    '/tasks/:id/:id',
    '/assets/*path/extra',
  ]) {
    expect(() => createRouter({ invalid: pattern })).toThrow();
  }
});

test('workspace navigation uses one view registry and ignores auth and unknown fragments', () => {
  for (const view of Object.keys(workspaceViews) as (keyof typeof workspaceViews)[]) {
    const parsed = parseWorkspaceHash(`#${view}?category=work&tag=home`)!;
    expect(parsed.view).toBe(view);
    expect(parsed.params.get('category')).toBe('work');
    expect(parsed.params.get('tag')).toBe('home');
  }
  for (const hash of [
    '',
    '#unknown',
    '#toString',
    '#constructor',
    '#user=u_123&setup=secret',
    '/board',
  ]) {
    expect(parseWorkspaceHash(hash)).toBeNull();
  }
});

test('offline task actions use exact named routes and reject malformed operations without writing', () => {
  const client = new ClientStore();
  const task = client.create({ title: 'Routing boundaries' });
  for (const action of ['restore', 'reminder', 'archive', 'unarchive', 'timer'] as const) {
    expect(offlineRoutes.match(`/api/tasks/${task.id}/${action}`)?.name).toBe(action);
  }
  expect(offlineRoutes.match('/api/tasks/archive-completed')?.name).toBe('archiveCompleted');
  expect(offlineRoutes.match('/api/export-extra')).toBeNull();
  const before = JSON.stringify(client.record);
  for (const suffix of ['/unknown', '/timer/extra', '/', '?action=timer']) {
    expect(() =>
      queueChange(client.record, `/api/tasks/${task.id}${suffix}`, 'POST', { action: 'start' }),
    ).toThrow('no longer exists');
  }
  expect(JSON.stringify(client.record)).toBe(before);
});
