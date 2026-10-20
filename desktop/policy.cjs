const { URL } = require('node:url');

function serverURL(value = 'https://taskpath.oddknight.space') {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('TASKPATH_DESKTOP_URL must be an HTTPS origin (HTTP is allowed on localhost).');
  }
  return url.origin;
}

function sameOrigin(value, origin) {
  try { return new URL(value).origin === origin; } catch { return false; }
}

function externalURL(value) {
  try { return ['https:', 'http:', 'mailto:'].includes(new URL(value).protocol); }
  catch { return false; }
}

module.exports = { serverURL, sameOrigin, externalURL };
