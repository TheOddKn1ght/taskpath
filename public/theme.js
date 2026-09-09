// Apply appearance before styles load. Preferences belong to this browser, not a vault.
(() => {
  const key = 'taskpath-theme';
  const root = '/assets/accounts-v4/';
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
  const valid = value => themes.some(theme => theme.id === value) ? value : null;
  let preference = null;
  try { preference = valid(localStorage.getItem(key)); } catch { /* Storage may be unavailable. */ }

  function apply() {
    const theme = themes.find(theme => theme.id === (preference || (system.matches ? 'dark' : 'light')));
    const path = `${root}themes/${theme.id}/`;
    document.documentElement.dataset.theme = theme.id;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.color);
    document.querySelector('link[rel="icon"]')?.setAttribute('href', path + 'favicon.svg');
    document.querySelector('link[rel="apple-touch-icon"]')?.setAttribute('href', path + 'apple-touch-icon.png');
    document.querySelector('link[rel="manifest"]')?.setAttribute('href', path + 'manifest.webmanifest');
    const label = `Choose theme, current: ${theme.name}${preference ? '' : ' (system)'}`;
    const button = document.getElementById('theme-toggle');
    if (button) {
      button.setAttribute('aria-label', label);
      button.title = label;
      button.replaceChildren(Object.assign(document.createElement('img'), { src: path + 'favicon.svg', alt: '' }));
    }
    document.getElementById('unlock-theme')?.setAttribute('aria-label', label);
    for (const choice of document.querySelectorAll('[data-theme-choice]')) {
      choice.setAttribute('aria-pressed', String(choice.dataset.themeChoice === (preference || 'system')));
    }
  }

  apply();
  document.addEventListener('DOMContentLoaded', () => {
    const dialog = document.getElementById('theme-dialog');
    const choices = document.getElementById('theme-choices');
    for (const theme of [{ id: 'system', name: 'Follow system' }, ...themes]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'theme-choice';
      button.dataset.themeChoice = theme.id;
      const preview = document.createElement('span');
      preview.className = 'theme-preview';
      if (theme.id !== 'system') preview.append(Object.assign(document.createElement('img'), { src: `${root}themes/${theme.id}/favicon.svg`, alt: '', width: 32, height: 32 }));
      else { preview.classList.add('theme-system'); preview.textContent = '◐'; }
      button.append(preview, Object.assign(document.createElement('span'), { textContent: theme.name }));
      button.addEventListener('click', () => {
        preference = valid(theme.id);
        try {
          if (preference) localStorage.setItem(key, preference);
          else localStorage.removeItem(key);
        } catch { /* Keep the choice for this tab. */ }
        apply();
      });
      choices.append(button);
    }
    apply();
    document.getElementById('theme-toggle').addEventListener('click', () => {
      if (!dialog.open) dialog.showModal();
      choices.querySelector('[aria-pressed="true"]')?.focus();
    });
    document.getElementById('theme-close').addEventListener('click', () => dialog.close());
  });
  system.addEventListener('change', () => { if (!preference) apply(); });
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    preference = valid(event.newValue);
    apply();
  });
})();
