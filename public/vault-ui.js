import { createVault, unlockVault, replacePassword, validateConfig, validUserId, normalizeNickname } from './crypto.js';
import { network, localState, activate, restoreRemembered, isUnlocked, sync, syncAfterCurrent, switchAccount, selectedAccount, offlineRequest, readBoard } from './offline.js';
import { loadAccount } from './persistence.js';
const $ = selector => document.querySelector(selector);
const fragment = new URLSearchParams(location.hash.slice(1));
let setupToken = fragment.get('setup'), invitedUserId = fragment.get('user');
if (setupToken) history.replaceState(null, '', location.pathname + location.search);
let resolveFirst, initialized = false, attempt = 0;
const configuration = userId => network('/api/auth/config?userId=' + encodeURIComponent(userId));
function showGate() {
  attempt++;
  document.body.classList.add('vault-locked'); $('#main').inert = true; $('#unlock-screen').hidden = false;
  $('#unlock-form').reset(); $('#unlock-error').hidden = true;
  $('#unlock-user').value = invitedUserId || selectedAccount() || '';
  $('#unlock-user').readOnly = Boolean(setupToken);
  const setup = Boolean(setupToken);
  $('#unlock-title').textContent = setup ? 'Your private vault' : 'Unlock Taskpath';
  $('#unlock-description').textContent = setup ? 'Save your user ID and password in your password manager. Only you can decrypt this vault; there is no password recovery.' : 'Enter your user ID and vault password. Works offline after your first download.';
  $('#unlock-confirm-field').hidden = !setup; $('#unlock-confirm').required = setup;
  $('#unlock-nickname-field').hidden = !setup;
  $('#unlock-password').autocomplete = setup ? 'new-password' : 'current-password';
  $('#unlock-submit').textContent = setup ? 'Create vault' : 'Unlock'; $('#unlock-submit').disabled = false;
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  (setup || selectedAccount() ? $('#unlock-password') : $('#unlock-user')).focus();
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
      event.preventDefault();
      let current = attempt;
      const userId = $('#unlock-user').value.trim().toLowerCase(), password = $('#unlock-password').value;
      const confirm = $('#unlock-confirm').value, nicknameInput = $('#unlock-nickname').value, remember = $('#unlock-remember').checked;
      $('#unlock-submit').disabled = true; $('#unlock-error').hidden = true;
      try {
        if (!validUserId(userId)) throw new Error('Enter the user ID from your invitation, not your nickname.');
        if (!crypto.subtle) throw new Error('Open Taskpath over HTTPS (or localhost) to use encryption.');
        if (selectedAccount() !== userId) { await switchAccount(userId); current = attempt; $('#unlock-submit').disabled = true; }
        const record = await localState(); let config, online = true;
        try { config = (await configuration(userId)).config; }
        catch (error) { if (error.status) throw error; online = false; config = record.config; }
        let key, nickname;
        if (setupToken) {
          if (config) throw new Error('This invitation has already been used. Open the normal app URL to sign in.');
          if (!online) throw new Error('Connect to the internet to accept your invitation.');
          if (password !== confirm) throw new Error('The passwords do not match.');
          nickname = normalizeNickname(nicknameInput);
          const vault = await createVault(password);
          if (current !== attempt) return;
          await network('/api/auth/setup', 'POST', { userId, token: setupToken, config: vault.config, credential: vault.credential }, userId);
          config = vault.config; key = vault.key; setupToken = null; invitedUserId = null;
        } else {
          if (!config) throw new Error(online ? 'User ID or password is incorrect, or the account is not available.' : 'This account has not been downloaded to this browser. Connect to sign in first.');
          validateConfig(config);
          if (record.config && record.config.vaultId !== config.vaultId) throw new Error('Vault identity changed. Existing encrypted changes were kept.');
          let unlocked;
          try { unlocked = await unlockVault(password, config); }
          catch { throw new Error('User ID or password is incorrect.'); }
          key = unlocked.key;
          if (current !== attempt) return;
          if (online) await network('/api/auth/login', 'POST', { userId, credential: unlocked.credential, revision: config.revision }, userId);
        }
        if (current !== attempt) return;
        await activate(config, key, remember, record.lockEpoch);
        if (nickname) { await syncAfterCurrent(); if (selectedAccount() === userId && isUnlocked()) await offlineRequest('/api/profile', 'POST', { nickname }); }
        else void syncAfterCurrent().catch(() => {});
      } catch (error) {
        if (current !== attempt) return;
        $('#unlock-error').textContent = error.message; $('#unlock-error').hidden = false;
      } finally {
        $('#unlock-password').value = ''; $('#unlock-confirm').value = ''; $('#unlock-nickname').value = '';
        $('#unlock-submit').disabled = false;
      }
    });
    $('#switch-account').addEventListener('click', async () => {
      $('.app-menu').open = false; setupToken = null; invitedUserId = null;
      // Stop local access before waiting for the network. The header makes any
      // old-account background request fail if another account owns the cookie.
      const userId = selectedAccount();
      await switchAccount(null);
      await network('/api/auth/logout', 'POST', {}, userId).catch(() => {});
    });
    $('#edit-nickname').addEventListener('click', async () => {
      $('.app-menu').open = false;
      const board = await readBoard(); if (!isUnlocked()) return;
      $('#nickname-input').value = board.nickname; $('#nickname-error').hidden = true; $('#nickname-dialog').showModal();
    });
    $('#nickname-form').addEventListener('submit', async event => {
      event.preventDefault();
      try { await offlineRequest('/api/profile', 'POST', { nickname: $('#nickname-input').value }); $('#nickname-dialog').close(); $('#nickname-input').value = ''; }
      catch (error) { $('#nickname-error').textContent = error.message; $('#nickname-error').hidden = false; }
    });
    $('#change-password').addEventListener('click', () => {
      $('.app-menu').open = false;
      $('#password-form').reset(); $('#password-error').hidden = true; $('#password-dialog').showModal(); $('#current-password').focus();
    });
    $('#password-form').addEventListener('submit', async event => {
      event.preventDefault(); $('#password-save').disabled = true; $('#password-error').hidden = true;
      const userId = selectedAccount();
      try {
        if (!isUnlocked()) throw new Error('Unlock first.');
        if ($('#new-password').value !== $('#confirm-password').value) throw new Error('The new passwords do not match.');
        const config = (await configuration(userId)).config;
        if (config.vaultId !== (await localState()).config.vaultId) throw new Error('Vault identity changed.');
        const replacement = await replacePassword($('#current-password').value, $('#new-password').value, config);
        if (!isUnlocked() || selectedAccount() !== userId) throw new Error('Vault was locked or account changed.');
        await network('/api/auth/password', 'POST', { ...replacement, revision: config.revision }, userId);
        await localState(record => { if (record.config?.vaultId === config.vaultId && record.config.revision < replacement.config.revision) record.config = replacement.config; }, userId);
        await network('/api/auth/login', 'POST', { userId, credential: replacement.credential, revision: replacement.config.revision }, userId);
        $('#password-dialog').close(); $('#password-form').reset();
        window.dispatchEvent(new Event('taskpath-password-changed'));
      } catch (error) { $('#password-error').textContent = error.name === 'OperationError' ? 'Current password is incorrect.' : error.message; $('#password-error').hidden = false; }
      finally { $('#password-form').querySelectorAll('input').forEach(input => { input.value = ''; }); $('#password-save').disabled = false; }
    });
  }
  await loadAccount();
  const ready = new Promise(resolve => { resolveFirst = resolve; });
  if (!setupToken && await restoreRemembered()) opened(); else showGate();
  return ready;
}
