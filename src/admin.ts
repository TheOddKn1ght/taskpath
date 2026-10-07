import { Store } from './store';
import { AuthManager } from './auth';
import { validUserId } from '../public/crypto.js';
import { snapshotDatabase } from './db/backup';

const usage = `Usage: bun run admin invite | list | reinvite USER_ID | revoke USER_ID | disable USER_ID
       bun run admin export BACKUP.sqlite
       bun run admin import BACKUP.sqlite

DATABASE_PATH selects the server database (default: ./data/taskpath-accounts.sqlite).
Export creates a consistent full backup, including encrypted files, accounts, sessions, and push state.
Import restores to a NEW DATABASE_PATH; existing files and SQLite sidecars are never overwritten.
Stop the server before restoring, then start it with the restored DATABASE_PATH.
Backups contain private account/authentication data. Keep them private; vault passwords are still required.
Only current Taskpath encrypted database schemas are supported.`;

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
    if (command === '--help' && !userId && !extra.length) { console.log(usage); }
    else if (['export', 'import'].includes(command)) {
      if (!userId || extra.length) throw new Error(usage);
      const database = process.env.DATABASE_PATH || './data/taskpath-accounts.sqlite';
      const path = command === 'export' ? snapshotDatabase(database, userId) : snapshotDatabase(userId, database);
      console.log(`${command === 'export' ? 'Database exported' : 'Database imported'}: ${path}`);
    } else {
      if (extra.length || !['invite', 'reinvite', 'revoke', 'list', 'disable'].includes(command) || (['reinvite', 'revoke', 'disable'].includes(command) ? !validUserId(userId) : userId !== undefined)) throw new Error(usage);
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
    }
  } catch (error) { console.error(error instanceof Error ? error.message : 'Admin command failed.'); process.exitCode = 1; }
}
