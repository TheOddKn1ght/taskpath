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
    { id: 'midnight', name: 'Midnight', color: '#101827' },
    { id: 'plum', name: 'Plum', color: '#211627' },
    { id: 'ocean', name: 'Ocean', color: '#102326' },
    { id: 'sand', name: 'Sand', color: '#faf3e8' },
    { id: 'lavender', name: 'Lavender', color: '#f6f2fc' },
    { id: 'ice', name: 'Ice', color: '#f1f7fc' },
    { id: 'mint', name: 'Mint', color: '#f2faf5' },
    { id: 'blush', name: 'Blush', color: '#fff4f4' },
    { id: 'paper', name: 'Paper', color: '#f7f6f2' },
    { id: 'ember', name: 'Ember', color: '#241915' },
    { id: 'forest', name: 'Forest', color: '#102018' },
    { id: 'graphite', name: 'Graphite', color: '#18191c' },
  ];
  const lightIds = new Set(['light', 'gruvbox-light', 'rose-pine', 'sand', 'lavender', 'ice', 'mint', 'blush', 'paper']);
  const modeTheme = (mode: 'light' | 'dark', value: string | null) =>
    themes.some(theme => theme.id === value) && lightIds.has(value!) === (mode === 'light') ? value! : mode;
  const pair = { light: 'light', dark: 'dark' };
  for (const mode of ['light', 'dark'] as const) {
    try { pair[mode] = modeTheme(mode, localStorage.getItem(key + '-' + mode)); } catch {}
  }
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const valid = (value: string | null) => themes.some(theme => theme.id === value) ? value : null;
  let preference: string | null = null;
  try { preference = valid(localStorage.getItem(key)); } catch { /* Storage may be unavailable. */ }

  function apply() {
    const theme = themes.find(theme => theme.id === (preference || pair[system.matches ? 'dark' : 'light']))!;
    const path = `${root}themes/${theme.id}/`;
    document.documentElement.dataset.theme = theme.id;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.color);
    document.querySelector('link[rel="icon"]')?.setAttribute('href', path + 'favicon.svg');
    document.querySelector('link[rel="apple-touch-icon"]')?.setAttribute('href', path + 'apple-touch-icon.png');
    document.querySelector('link[rel="manifest"]')?.setAttribute('href', path + 'manifest.webmanifest');

  }

  apply();
  window.addEventListener('taskpath-theme', event => { preference = valid((event as CustomEvent<string>).detail); apply(); });
  window.addEventListener('taskpath-system-themes', event => {
    const { mode, theme } = (event as CustomEvent<{mode: 'light' | 'dark'; theme: string}>).detail;
    if (mode !== 'light' && mode !== 'dark') return;
    pair[mode] = modeTheme(mode, theme);
    apply();
  });
  system.addEventListener('change', () => { if (!preference) apply(); });
  window.addEventListener('storage', event => {
    if (event.key === key + '-light' || event.key === key + '-dark') {
      const mode = event.key === key + '-light' ? 'light' : 'dark';
      pair[mode] = modeTheme(mode, event.newValue);
      apply();
      return;
    }
    if (event.key !== key && event.key !== null) return;
    if (event.key === null) { pair.light = 'light'; pair.dark = 'dark'; }
    preference = valid(event.newValue);
    apply();
  });
})();
