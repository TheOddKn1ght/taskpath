import type { Route } from './types.js';
import { normalizeTags } from './tags.js';
// View and filters live only after #; never put search text in the HTTP query string.
export function navigation(onChange: (view: Route['view'], filters: Omit<Route,'view'>) => void) {
  const root = document.getElementById('main')!;
  const toggle = document.getElementById('sidebar-toggle')!;
  const mobile = matchMedia('(max-width: 760px)');
  const key = 'taskpath-sidebar-collapsed';
  let current: Route = { view: 'board', query: '', category: 'all', tag: '' };
  function readRoute(): Route | null {
    const match = location.hash.match(/^#(board|archive|files)(?:\?(.*))?$/);
    if (!match) return location.hash ? null : { view: 'board', query: '', category: 'all', tag: '' };
    const params = new URLSearchParams(match[2] || '');
    const category = ['work', 'personal'].includes(params.get('category') || '') ? params.get('category') as Route['category'] : 'all';
    let tag = '';
    try { if (params.get('tag')) tag = normalizeTags([params.get('tag')])[0]; } catch { /* Ignore invalid tag filters in external links. */ }
    return { view: match[1] as Route['view'], query: params.get('q') || '', category, tag };
  }
  function hashFor(route: Route) {
    if (route.view === 'files') return '#files';
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
    onChange(view, { query: current.query, category: current.category, tag: current.tag });
  }
  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    try { localStorage.setItem(key, String(collapsed)); } catch {}
    appearance();
  });
  for (const button of document.querySelectorAll<HTMLElement>('[data-view]')) button.addEventListener('click', () => {
    const changed = button.dataset.view !== current.view;
    select(button.dataset.view as Route['view'], true);
    if (changed && mobile.matches) window.scrollTo({ top: 0, behavior: 'instant' });
  });
  // Keep the bottom tabs out of the way when a software keyboard is open.
  let fullHeight = window.innerHeight;
  function keyboard() {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const editing = document.activeElement?.matches('input,textarea,[contenteditable="true"]');
    if (!editing) fullHeight = window.innerHeight;
    root.classList.toggle('mobile-keyboard', mobile.matches && !!editing && viewport.scale === 1 && fullHeight - viewport.height > 120);
  }
  window.visualViewport?.addEventListener('resize', keyboard);
  window.addEventListener('resize', keyboard);
  window.addEventListener('focusin', keyboard);
  window.addEventListener('focusout', keyboard);
  window.addEventListener('taskpath-locked', () => root.classList.toggle('mobile-keyboard', false));
  const restore = () => {
    const route: Route = readRoute() || { view: 'board', query: '', category: 'all', tag: '' };
    select(route.view, false, route);
  };
  window.addEventListener('hashchange', () => {
    // Ordinary document anchors, such as the skip link, are not view navigation.
    if (readRoute()) restore();
  });
  mobile.addEventListener('change', keyboard);
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    collapsed = event.newValue === 'true'; appearance();
  });
  appearance();
  restore();
  return { restore, reset: () => select('board', true), filters: (patch: Partial<Omit<Route,'view'>>) => select(current.view, 'replace', { ...current, ...patch }) };
}
