import { createVault, unlockVault, replacePassword, validateConfig } from './crypto.js';
import { network, localState, activate, restoreRemembered, isUnlocked, sync } from './offline.js';
const $ = selector => document.querySelector(selector);
let setupToken = new URLSearchParams(location.hash.slice(1)).get('setup');
if (setupToken) history.replaceState(null, '', location.pathname + location.search);
let resolveFirst;
let initialized = false, attempt = 0;
function showGate() {
  attempt++;
  document.body.classList.add('vault-locked');
  $('#main').inert = true;
  $('#unlock-screen').hidden = false;
  $('#unlock-password').value = ''; $('#unlock-confirm').value = '';
  $('#unlock-remember').checked = false;
  $('#unlock-error').hidden = true;
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  void configureGate();
}
async function configureGate() {
  const current = attempt;
  try {
    let config;
    try { config = (await network('/api/auth/config')).config; }
    catch (error) { if (error.status) throw error; config = (await localState()).config; }
    if (current !== attempt) return;
    const setup = !config && Boolean(setupToken);
    $('#unlock-title').textContent = setup ? 'Your private workspace' : 'Unlock Taskpath';
    $('#unlock-description').textContent = setup ? 'Choose one password to sign in and encrypt your tasks. Save it in your password manager: there is no reset or recovery key.' : 'One password opens your encrypted tasks. Works offline after your first download.';
    $('#unlock-confirm-field').hidden = !setup;
    $('#unlock-confirm').required = setup;
    $('#unlock-password').autocomplete = setup ? 'new-password' : 'current-password';
    $('#unlock-submit').textContent = setup ? 'Create encrypted workspace' : 'Unlock';
    $('#unlock-submit').disabled = !config && !setup;
    if (!config && !setup) throw new Error('Open the one-use setup link from the server console. If it expired, restart the server for a new link.');
    $('#unlock-password').focus();
  } catch (error) { $('#unlock-error').textContent = error.message; $('#unlock-error').hidden = false; }
}
function opened() {
  document.body.classList.remove('vault-locked'); $('#main').inert = false; $('#unlock-screen').hidden = true;
  $('#unlock-form').reset(); $('#unlock-error').hidden = true;
  resolveFirst?.(); resolveFirst = null;
}
export async function startVault() {
  if (!initialized) {
    initialized = true;
    $('#unlock-theme').addEventListener('click', () => $('#theme-toggle').click());
    window.addEventListener('taskpath-locked', showGate);
    window.addEventListener('taskpath-unlocked', opened);
    window.addEventListener('taskpath-lock-error', event => { $('#unlock-error').textContent = event.detail; $('#unlock-error').hidden = false; });
    $('#unlock-form').addEventListener('submit', async event => {
      event.preventDefault(); const current = attempt;
      $('#unlock-submit').disabled = true; $('#unlock-error').hidden = true;
      const password = $('#unlock-password').value, remember = $('#unlock-remember').checked;
      try {
        if (!crypto.subtle) throw new Error('Open Taskpath over HTTPS (or localhost) to use encryption.');
        const record = await localState(); let config, online = true;
        try { config = (await network('/api/auth/config')).config; }
        catch (error) { if (error.status) throw error; online = false; config = record.config; }
        let key;
        if (!config) {
          if (!online || !setupToken) throw new Error('Use the setup link from your server console while online.');
          if (password !== $('#unlock-confirm').value) throw new Error('The passwords do not match.');
          const vault = await createVault(password);
          if (current !== attempt) return;
          await network('/api/auth/setup', 'POST', { token: setupToken, config: vault.config, credential: vault.credential });
          config = vault.config; key = vault.key; setupToken = null;
        } else {
          validateConfig(config);
          if (record.config && record.config.vaultId !== config.vaultId) throw new Error('This device has a different encrypted workspace. Open it offline to export before using a separate browser profile for the new workspace.');
          let unlocked;
          try { unlocked = await unlockVault(password, config); }
          catch { throw new Error('Password is incorrect, or the encrypted key could not be verified.'); }
          key = unlocked.key;
          if (current !== attempt) return;
          if (online) await network('/api/auth/login', 'POST', { credential: unlocked.credential, revision: config.revision });
        }
        if (current !== attempt) return;
        await activate(config, key, remember, record.lockEpoch);
        void sync().catch(() => {});
      } catch (error) {
        if (current !== attempt) return;
        $('#unlock-error').textContent = error.message; $('#unlock-error').hidden = false;
      } finally {
        $('#unlock-password').value = ''; $('#unlock-confirm').value = '';
        $('#unlock-submit').disabled = false;
      }
    });
    $('#change-password').addEventListener('click', () => {
      $('.app-menu').open = false;
      $('#password-form').reset(); $('#password-error').hidden = true; $('#password-dialog').showModal(); $('#current-password').focus();
    });
    $('#password-form').addEventListener('submit', async event => {
      event.preventDefault(); $('#password-save').disabled = true; $('#password-error').hidden = true;
      try {
        if (!isUnlocked()) throw new Error('Unlock first.');
        if ($('#new-password').value !== $('#confirm-password').value) throw new Error('The new passwords do not match.');
        const config = (await network('/api/auth/config')).config;
        if (config.vaultId !== (await localState()).config.vaultId) throw new Error('Workspace identity changed.');
        const replacement = await replacePassword($('#current-password').value, $('#new-password').value, config);
        if (!isUnlocked()) throw new Error('Workspace was locked.');
        await network('/api/auth/password', 'POST', { ...replacement, revision: config.revision });
        await localState(record => { if (record.config?.vaultId === config.vaultId && record.config.revision < replacement.config.revision) record.config = replacement.config; });
        // Every pre-existing session was revoked. Issue a new session for this page.
        await network('/api/auth/login', 'POST', { credential: replacement.credential, revision: replacement.config.revision });
        $('#password-dialog').close();
        $('#password-form').reset();
        window.dispatchEvent(new Event('taskpath-password-changed'));
      } catch (error) { $('#password-error').textContent = error.name === 'OperationError' ? 'Current password is incorrect.' : error.message; $('#password-error').hidden = false; }
      finally { $('#password-form').querySelectorAll('input').forEach(input => { input.value = ''; }); $('#password-save').disabled = false; }
    });
  }
  const ready = new Promise(resolve => { resolveFirst = resolve; });
  if (!setupToken && await restoreRemembered()) opened(); else showGate();
  return ready;
}
