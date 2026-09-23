// Apply appearance before styles load. Preferences belong to this browser, not a vault.
(() => {
  const key = 'taskpath-theme';
  const root = '/assets/__TASKPATH_RELEASE__/';
  const themes = [
    { id: 'light', name: 'Light', color: '#fafaf8' },
    { id: 'dark', name: 'Dark', color: '#171c19' },
    { id: 'gruvbox-light', name: 'Gruvbox Light', color: '#fbf1c7' },
    { id: 'gruvbox-dark', name: 'Gruvbox Dark', color: '#282828' },
    { id: 'nord', name: 'Nord', color: '#2e3440' },
    { id: 'catppuccin', name: 'Catppuccin Mocha', color: '#1e1e2e' },
    { id: 'rose-pine', name: 'Rosé Pine Dawn', color: '#faf4ed' },
  ];
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const valid = (value: string | null) => themes.some(theme => theme.id === value) ? value : null;
  let preference: string | null = null;
  try { preference = valid(localStorage.getItem(key)); } catch { /* Storage may be unavailable. */ }

  function apply() {
    const theme = themes.find(theme => theme.id === (preference || (system.matches ? 'dark' : 'light')))!;
    const path = `${root}themes/${theme.id}/`;
    document.documentElement.dataset.theme = theme.id;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.color);
    document.querySelector('link[rel="icon"]')?.setAttribute('href', path + 'favicon.svg');
    document.querySelector('link[rel="apple-touch-icon"]')?.setAttribute('href', path + 'apple-touch-icon.png');
    document.querySelector('link[rel="manifest"]')?.setAttribute('href', path + 'manifest.webmanifest');

  }

  apply();
  window.addEventListener('taskpath-theme', event => { preference = valid((event as CustomEvent<string>).detail); apply(); });
  system.addEventListener('change', () => { if (!preference) apply(); });
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    preference = valid(event.newValue);
    apply();
  });
})();
