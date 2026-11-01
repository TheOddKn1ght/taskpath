import { createRouter } from '../public/router';

export const serverRoutes = createRouter({
  health: '/healthz',
  authConfig: '/api/auth/config',
  authStatus: '/api/auth/status',
  authSetup: '/api/auth/setup',
  authLogin: '/api/auth/login',
  authLogout: '/api/auth/logout',
  authPassword: '/api/auth/password',
  events: '/api/events',
  sync: '/api/sync',
  reminders: '/api/reminders/claim',
  push: '/api/push',
  files: '/api/files',
  file: '/api/files/*fileId',
  home: '/',
  login: '/login',
  offlineShell: '/offline-shell',
  loginShell: '/login-shell',
  worker: '/sw.js',
  asset: '/assets/*assetPath',
});
