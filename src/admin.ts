import { Store } from './store.ts';
import { AuthManager } from './auth.ts';
import { validUserId } from '../public/crypto.ts';

export function invitationURL(origin: string, userId: string, token: string) {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Set TASKPATH_ORIGIN to the public HTTPS origin.');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Invitations require HTTPS outside localhost.');
  url.hash = new URLSearchParams({ user: userId, setup: token }).toString();
  return url.href;
}
if (import.meta.main) {
  const [command, userId, ...extra] = Deno.args;
  try {
    if (extra.length || !['invite', 'reinvite', 'revoke', 'list', 'disable'].includes(command!) || (['reinvite', 'revoke', 'disable'].includes(command!) ? !validUserId(userId) : userId !== undefined)) throw new Error('Usage: deno task admin invite | list | reinvite USER_ID | revoke USER_ID | disable USER_ID');
    const origin = Deno.env.get('TASKPATH_ORIGIN') || `http://localhost:${Deno.env.get('PORT') || 3000}`;
    if (['invite', 'reinvite'].includes(command!)) invitationURL(origin, 'validation', 'validation');
    const store = new Store(Deno.env.get('DATABASE_PATH') || './data/taskpath-accounts.sqlite', undefined, Deno.env.get('TASKPATH_TIMEZONE'));
    try {
      const auth = new AuthManager(store.db);
      if (command === 'list') console.table(auth.list());
      else if (command === 'disable') { auth.disable(userId!); console.log('Account disabled. Its encrypted data was retained.'); }
      else if (command === 'revoke') { auth.revokeInvitation(userId!); console.log('Pending invitation revoked.'); }
      else {
        const invitation = command === 'invite' ? auth.createInvitation() : auth.renewInvitation(userId!);
        console.log(`User ID: ${invitation.userId}\nSetup link: ${invitationURL(origin, invitation.userId, invitation.token)}\nExpires: ${new Date(invitation.expiresAt).toISOString()} (one use, 24 hours)`);
      }
    } finally { store.close(); }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Account command failed.');
    Deno.exit(1);
  }
}
