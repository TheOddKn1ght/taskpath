import { Store } from './store';
import { AuthManager } from './auth';
import { validUserId } from '../public/crypto.js';

export function invitationURL(origin: string, userId: string, token: string) {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Set TASKPATH_ORIGIN to the public HTTPS origin.');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Invitations require HTTPS outside localhost.');
  url.hash = new URLSearchParams({ user: userId, setup: token }).toString();
  return url.href;
}
if (import.meta.main) {
  const [command, userId, ...extra] = process.argv.slice(2);
  try {
    if (extra.length || !['invite', 'reinvite', 'revoke', 'list', 'disable'].includes(command) || (['reinvite', 'revoke', 'disable'].includes(command) ? !validUserId(userId) : userId !== undefined)) throw new Error('Usage: bun run admin invite | list | reinvite USER_ID | revoke USER_ID | disable USER_ID');
    const origin = process.env.TASKPATH_ORIGIN || `http://localhost:${process.env.PORT || 3000}`;
    if (['invite', 'reinvite'].includes(command)) invitationURL(origin, 'validation', 'validation');
    const store = new Store(process.env.DATABASE_PATH || './data/taskpath-accounts.sqlite', undefined, process.env.TASKPATH_TIMEZONE);
    try {
      const auth = new AuthManager(store.db);
      if (command === 'list') console.table(auth.list());
      else if (command === 'disable') { auth.disable(userId); console.log('Account disabled. Its encrypted data was retained.'); }
      else if (command === 'revoke') { auth.revokeInvitation(userId); console.log('Pending invitation revoked.'); }
      else {
        const invitation = command === 'invite' ? auth.createInvitation() : auth.renewInvitation(userId);
        console.log(`User ID: ${invitation.userId}\nSetup link: ${invitationURL(origin, invitation.userId, invitation.token)}\nExpires: ${new Date(invitation.expiresAt).toISOString()} (one use, 24 hours)`);
      }
    } finally { store.close(); }
  } catch (error) { console.error(error instanceof Error ? error.message : 'Account command failed.'); process.exitCode = 1; }
}
