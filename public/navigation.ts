import type { Route } from './types.js';
import { normalizeTags } from './tags.js';
// View and filters live only after #; never put search text in the HTTP query string.
export function navigation(onChange: (view: Route['view'], filters: Omit<Route,'view'>) => void) {
  const root = document.getElementById('main')!;
  const toggle = document.getElementById('sidebar-toggle')!;
  const drawer = document.getElementById('navigation-dialog') as HTMLDialogElement;
  const menu = document.getElementById('navigation-open')!;
  const mobile = matchMedia('(max-width: 760px)');
  const key = 'taskpath-sidebar-collapsed';
  let current: Route = { view: 'board', query: '', category: 'all', tag: '' };
  function readRoute(): Route | null {
    const match = location.hash.match(/^#(board|archive)(?:\?(.*))?$/);
    if (!match) return location.hash ? null : { view: 'board', query: '', category: 'all', tag: '' };
    const params = new URLSearchParams(match[2] || '');
    const category = ['work', 'personal'].includes(params.get('category') || '') ? params.get('category') as Route['category'] : 'all';
    let tag = '';
    try { if (params.get('tag')) tag = normalizeTags([params.get('tag')])[0]; } catch { /* Ignore invalid tag filters in external links. */ }
    return { view: match[1] as Route['view'], query: params.get('q') || '', category, tag };
  }
  function hashFor(route: Route) {
    const params = new URLSearchParams();
    if (route.query) params.set('q', route.query);
    if (route.category !== 'all') params.set('category', route.category);
    if (route.tag) params.set('tag', route.tag);
    const query = params.toString();
    return query ? `#${route.view}?${query}` : route.view === 'archive' ? '#archive' : '';
  }
  let collapsed = false;
  try { collapsed = localStorage.getItem(key) === 'true'; } catch {}
  function appearance() {
    root.classList.toggle('sidebar-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    toggle.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  }
  function close() { if (drawer.open) drawer.close(); }
  function select(view: Route['view'], updateURL: boolean | 'replace' = false, filters = current) {
    current = { view, query: filters.query, category: filters.category, tag: filters.tag };
    const hash = hashFor(current);
    if (updateURL && location.hash !== hash) {
      const method = updateURL === 'replace' ? 'replaceState' : 'pushState';
      history[method](null, '', location.pathname + location.search + hash);
    }
    for (const button of document.querySelectorAll<HTMLElement>('[data-view]')) {
      if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    close(); onChange(view, { query: current.query, category: current.category, tag: current.tag });
  }
  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    try { localStorage.setItem(key, String(collapsed)); } catch {}
    appearance();
  });
  menu.addEventListener('click', () => {
    drawer.showModal(); menu.setAttribute('aria-expanded', 'true');
    drawer.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
  });
  document.getElementById('navigation-close')!.addEventListener('click', close);
  drawer.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const buttons = [...drawer.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  drawer.addEventListener('click', event => {
    const box = drawer.getBoundingClientRect();
    if (event.target === drawer && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) close();
  });
  drawer.addEventListener('close', () => { menu.setAttribute('aria-expanded', 'false'); if (!root.inert && mobile.matches) menu.focus(); });
  for (const button of document.querySelectorAll<HTMLElement>('[data-view]')) button.addEventListener('click', () => select(button.dataset.view as Route['view'], true));
  const restore = () => {
    const route: Route = readRoute() || { view: 'board', query: '', category: 'all', tag: '' };
    select(route.view, false, route);
  };
  window.addEventListener('hashchange', () => {
    // Ordinary document anchors, such as the skip link, are not view navigation.
    if (readRoute()) restore();
  });
  mobile.addEventListener('change', () => { if (!mobile.matches) close(); });
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    collapsed = event.newValue === 'true'; appearance();
  });
  appearance();
  restore();
  return { restore, reset: () => select('board', true), filters: (patch: Partial<Omit<Route,'view'>>) => select(current.view, 'replace', { ...current, ...patch }), close };
}
