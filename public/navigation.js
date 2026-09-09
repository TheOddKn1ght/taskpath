// Navigation preferences contain no vault data and belong to this browser.
export function navigation(onChange) {
  const root = document.getElementById('main');
  const toggle = document.getElementById('sidebar-toggle');
  const drawer = document.getElementById('navigation-dialog');
  const menu = document.getElementById('navigation-open');
  const mobile = matchMedia('(max-width: 760px)');
  const key = 'taskpath-sidebar-collapsed';
  let collapsed = false;
  try { collapsed = localStorage.getItem(key) === 'true'; } catch {}
  function appearance() {
    root.classList.toggle('sidebar-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    toggle.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  }
  function close() { if (drawer.open) drawer.close(); }
  function select(view) {
    for (const button of document.querySelectorAll('[data-view]')) {
      if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    close(); onChange(view);
  }
  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    try { localStorage.setItem(key, String(collapsed)); } catch {}
    appearance();
  });
  menu.addEventListener('click', () => {
    drawer.showModal(); menu.setAttribute('aria-expanded', 'true');
    drawer.querySelector('[aria-current="page"]')?.focus();
  });
  document.getElementById('navigation-close').addEventListener('click', close);
  drawer.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const buttons = [...drawer.querySelectorAll('button:not(:disabled)')];
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  drawer.addEventListener('click', event => {
    const box = drawer.getBoundingClientRect();
    if (event.target === drawer && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) close();
  });
  drawer.addEventListener('close', () => { menu.setAttribute('aria-expanded', 'false'); if (!root.inert && mobile.matches) menu.focus(); });
  for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => select(button.dataset.view));
  mobile.addEventListener('change', () => { if (!mobile.matches) close(); });
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    collapsed = event.newValue === 'true'; appearance();
  });
  appearance();
  return { reset: () => select('board'), close };
}
