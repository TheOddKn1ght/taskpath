import { unlockAfterLogin } from './offline.js';
const form = document.getElementById('login-form');
const button = document.getElementById('login-button');
const error = document.getElementById('login-error');

form.addEventListener('submit', async event => {
  event.preventDefault();
  error.hidden = true;
  button.disabled = true;
  button.textContent = 'Signing in…';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
      }),
    });
    if (response.ok) {
      await unlockAfterLogin();
      document.getElementById('password').value = '';
      location.replace('/');
      return;
    }
    let message = response.status === 429 ? 'Too many attempts. Wait a while and try again.' : 'Username or password is incorrect.';
    try { message = (await response.json()).error || message; } catch { /* Keep the readable fallback. */ }
    error.textContent = message;
    error.hidden = false;
    document.getElementById('password').select();
  } catch {
    error.textContent = 'Could not reach your workspace. Please try again.';
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Sign in';
  }
});
