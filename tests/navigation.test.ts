import { test, expect } from 'bun:test';
import { normalizeTags } from '../public/tags.js';
import { runInNewContext } from 'node:vm';
const source = new Bun.Transpiler({loader: 'ts'}).transformSync((await Bun.file('public/navigation.ts').text()).replace(/^import .*\n/gm, '').replace('export function navigation', 'function navigation'));
function fixture(hash = '', mobile = false) {
  const listeners = new Map<string, Function>();
  const node = (view?: string) => ({
    dataset: { view }, attributes: new Map<string, string>(), listeners: new Map<string, Function>(), open: false,
    classList: { values: new Set<string>(), toggle(name: string, enabled: boolean) { if (enabled) this.values.add(name); else this.values.delete(name); } }, setAttribute(name: string, value: string) { this.attributes.set(name, value); },
    removeAttribute(name: string) { this.attributes.delete(name); }, addEventListener(name: string, fn: Function) { this.listeners.set(name, fn); },
    close() { this.open = false; },
  });
  const ids = new Map(['main', 'sidebar-toggle'].map(id => [id, node()]));
  const buttons = [node('board'), node('archive'), node('files')], views: string[] = [], urls: string[] = [], routes: any[] = [], methods: string[] = [];
  const location = { pathname: '/login', search: '?source=saved', hash };
  let scrolls = 0;
  const viewportListeners = new Map<string, Function>();
  const viewport = { height: 844, scale: 1, addEventListener: (name: string, fn: Function) => viewportListeners.set(name, fn) };
  const document = { activeElement: null as null | { matches: () => boolean }, getElementById: (id: string) => ids.get(id), querySelectorAll: () => buttons };
  const controller = runInNewContext(source + '\nnavigation;', {
    document,
    URLSearchParams, normalizeTags, location, history: Object.fromEntries(['pushState', 'replaceState'].map(method => [method, (_state: unknown, _title: string, url: string) => { methods.push(method); urls.push(url); location.hash = new URL(url, 'https://test.example').hash; }])),
    localStorage: { getItem: () => null }, matchMedia: () => ({ matches: mobile, addEventListener() {} }),
    window: { innerHeight:844, visualViewport:viewport, scrollTo: () => scrolls++, addEventListener: (name: string, fn: Function) => listeners.set(name, fn) },
  })((view: string, filters: any) => { views.push(view); routes.push({ view, ...filters }); });
  return { views, urls, routes, methods, buttons, location, controller, ids, listeners, scrolls: () => scrolls, keyboard: (height: number, editing: boolean) => { viewport.height = height; document.activeElement = editing ? { matches: () => true } : null; viewportListeners.get("resize")!(); }, hashchange: () => listeners.get('hashchange')!() };
}

test('archive URLs select Archive on startup and after unlocking without rewriting the URL', () => {
  const f = fixture('#archive');
  expect(f.views).toEqual(['archive']);
  expect(f.buttons[1].attributes.get('aria-current')).toBe('page');
  f.controller.restore();
  expect(f.views).toEqual(['archive', 'archive']);
  expect(f.location.hash).toBe('#archive'); expect(f.urls).toEqual([]);
});

test('navigation writes archive anchors, preserves path/query, and avoids duplicate history entries', () => {
  const f = fixture();
  f.buttons[1].listeners.get('click')!(); f.buttons[1].listeners.get('click')!();
  expect(f.urls).toEqual(['/login?source=saved#archive']);
  f.buttons[0].listeners.get('click')!();
  expect(f.urls).toEqual(['/login?source=saved#archive', '/login?source=saved']);
  expect(f.views.at(-1)).toBe('board');
});

test('hash navigation handles Back/Forward and explicit board reset without rewriting document anchors', () => {
  const f = fixture('#archive');
  f.location.hash = ''; f.hashchange(); expect(f.views.at(-1)).toBe('board');
  f.location.hash = '#archive'; f.hashchange(); expect(f.views.at(-1)).toBe('archive');
  f.location.hash = '#main'; f.hashchange(); expect(f.views.at(-1)).toBe('archive');
  expect(f.urls).toEqual([]);
  f.controller.reset(); expect(f.views.at(-1)).toBe('board'); expect(f.location.hash).toBe('');
});


test('search and filters round-trip through fragments with Unicode and reserved characters', () => {
  const query = 'Private café & plans? #today + 50% / 日本語 <script> &setup=not-a-token';
  const f = fixture('#archive');
  f.controller.filters({ query, category: 'work', tag: 'home office' });
  const url = new URL(f.urls.at(-1)!, 'https://test.example');
  expect(url.search).toBe('?source=saved');
  expect(url.searchParams.has('q')).toBe(false);
  expect(url.hash).toStartWith('#archive?q=');
  expect(new URLSearchParams(url.hash.slice(1)).has('setup')).toBe(false);
  const reopened = fixture(url.hash);
  expect(reopened.routes.at(-1)).toEqual({ view: 'archive', query, category: 'work', tag: 'home office' });
  reopened.controller.restore();
  expect(reopened.routes.at(-1)).toEqual({ view: 'archive', query, category: 'work', tag: 'home office' });
});

test('typing replaces history, view changes carry filters, and Back restores earlier filters', () => {
  const f = fixture('#archive');
  f.controller.filters({ query: 'first' }); const earlier = f.location.hash;
  f.buttons[0].listeners.get('click')!();
  expect(f.location.hash).toBe('#board?q=first');
  f.controller.filters({ query: 'second', category: 'personal' });
  expect(f.methods).toEqual(['replaceState', 'pushState', 'replaceState']);
  f.location.hash = earlier; f.hashchange();
  expect(f.routes.at(-1)).toEqual({ view: 'archive', query: 'first', category: 'all', tag: '' });
  f.controller.filters({ query: '' }); expect(f.location.hash).toBe('#archive');
  f.controller.reset(); expect(f.location.hash).toBe('');
});

test('invalid filter links fall back safely and normalize valid tags', () => {
  expect(fixture('#board?category=unknown&tag=%00').routes.at(-1)).toEqual({ view: 'board', query: '', category: 'all', tag: '' });
  expect(fixture('#archive?tag=%20HOME%20').routes.at(-1).tag).toBe('home');
  expect(fixture('#board?q=%ZZ').routes.at(-1).query).toBe('%ZZ');
});

test('fragment search text is absent from actual HTTP requests on navigation and refresh', async () => {
  const requests: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) { requests.push(request.url); return new Response('ok'); } });
  try {
    const f = fixture('#archive');
    f.controller.filters({ query: 'PRIVATE_SEARCH_8284', category: 'work', tag: 'private-tag' });
    const url = new URL(f.urls.at(-1)!, server.url);
    await fetch(url); await fetch(url);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(new URL(request).pathname).toBe('/login');
      expect(new URL(request).search).toBe('?source=saved');
      expect(request).not.toContain('PRIVATE_SEARCH_8284');
      expect(request).not.toContain('private-tag');
    }
  } finally { await server.stop(true); }
});


test('mobile tabs share URL navigation, mark Files selected and reset scroll only when the view changes', () => {
  const f = fixture('', true);
  f.buttons[2].listeners.get('click')!();
  expect(f.location.hash).toBe('#files');
  expect(f.buttons[2].attributes.get('aria-current')).toBe('page');
  expect(f.buttons[0].attributes.has('aria-current')).toBe(false);
  expect(f.scrolls()).toBe(1);
  f.buttons[2].listeners.get('click')!(); expect(f.scrolls()).toBe(1);
  f.location.hash = '#archive'; f.hashchange();
  expect(f.buttons[1].attributes.get('aria-current')).toBe('page');
});

test('bottom tabs hide for the software keyboard, return on blur and clear their hidden state on lock', () => {
  const f = fixture('', true), classes = f.ids.get('main')!.classList.values;
  f.keyboard(844, true); expect(classes.has('mobile-keyboard')).toBe(false);
  f.keyboard(480, true); expect(classes.has('mobile-keyboard')).toBe(true);
  f.keyboard(480, false); expect(classes.has('mobile-keyboard')).toBe(false);
  f.keyboard(480, true); f.listeners.get('taskpath-locked')!();
  expect(classes.has('mobile-keyboard')).toBe(false);
  const desktop = fixture(); desktop.keyboard(480, true);
  expect(desktop.ids.get('main')!.classList.values.has('mobile-keyboard')).toBe(false);
});
