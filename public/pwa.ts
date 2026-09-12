if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js', { type: 'module', updateViaCache: 'none' }).catch(() => {});
}
let installPrompt: BeforeInstallPromptEvent | null = null;
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault(); installPrompt = event;
  const button = document.getElementById('install-app');
  if (button) button.hidden = false;
});
document.getElementById('install-app')?.addEventListener('click', async () => {
  if (!installPrompt) return;
  await installPrompt.prompt();
  installPrompt = null;
  document.getElementById('install-app')!.hidden = true;
});
window.addEventListener('appinstalled', () => { document.getElementById('install-app')!.hidden = true; });

export {};
