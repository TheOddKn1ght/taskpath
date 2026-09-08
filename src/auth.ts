import { createHash, randomBytes } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { InputError } from './store';
import { validateConfig, unbase64 } from '../public/crypto.js';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const sessionCookieName = 'taskpath_session';
export const secureSessionCookieName = '__Host-taskpath_session';
function cookieValue(request: Request) {
  const parts = (request.headers.get('cookie') || '').split(';').map(p => p.trim().split('='));
  return parts.find(p => p[0] === secureSessionCookieName)?.[1] || parts.find(p => p[0] === sessionCookieName)?.[1];
}
export class AuthManager {
  private attempts = new Map<string, { failures: number; at: number; until: number }>();
  private sessionSeconds: number;
  constructor(private db: Database, sessionDays = 30, private now = () => Date.now()) {
    if (!Number.isInteger(sessionDays) || sessionDays < 1 || sessionDays > 365) throw new Error('TASKPATH_SESSION_DAYS must be from 1 to 365.');
    this.sessionSeconds = sessionDays * 86400;
    db.exec('CREATE TABLE IF NOT EXISTS auth_sessions (tokenHash TEXT PRIMARY KEY, revision INTEGER NOT NULL, expiresAt INTEGER NOT NULL)');
  }
  private row() { return this.db.query<{ revision: number; config: string; verifier: string }, []>('SELECT * FROM vault WHERE id=1').get(); }
  configuration() { const row = this.row(); return row ? JSON.parse(row.config) : null; }
  issueSetupToken() {
    if (this.row()) return null;
    const token = randomBytes(32).toString('base64url');
    this.db.query('INSERT OR REPLACE INTO setup VALUES (1, ?, ?)').run(digest(token), this.now() + 1800000);
    return token;
  }
  private validSetup(token: unknown) {
    return typeof token === 'string' && token.length === 43 && Boolean(this.db.query('SELECT id FROM setup WHERE id=1 AND tokenHash=? AND expiresAt>?').get(digest(token), this.now()));
  }
  private validateCredential(credential: unknown) {
    try { unbase64(credential, 32); } catch { throw new InputError('Invalid authentication credential.'); }
  }
  async setup(token: unknown, config: any, credential: string) {
    if (!this.validSetup(token) || this.row()) throw new InputError('Setup link is invalid or expired. Restart the server for a new link before setup.', 403);
    try { validateConfig(config); } catch { throw new InputError('Invalid vault configuration.'); }
    if (config.revision !== 1) throw new InputError('Invalid initial revision.');
    this.validateCredential(credential);
    const verifier = await Bun.password.hash(credential, { algorithm: 'argon2id', memoryCost: 65536, timeCost: 2 });
    this.db.transaction(() => {
      if (!this.validSetup(token) || this.row()) throw new InputError('Setup link has already been used or expired.', 409);
      this.db.query('INSERT INTO vault VALUES (1, 1, ?, ?)').run(JSON.stringify(config), verifier);
      this.db.exec('DELETE FROM setup');
    })();
  }
  isAuthenticated(request: Request) {
    const token = cookieValue(request);
    return Boolean(token && token.length <= 128 && this.db.query('SELECT tokenHash FROM auth_sessions WHERE tokenHash=? AND revision=(SELECT revision FROM vault WHERE id=1) AND expiresAt>?').get(digest(token), this.now()));
  }
  private async verify(client: string, credential: string) {
    const now = this.now();
    for (const [key, a] of this.attempts) if (a.until <= now && now - a.at >= 600000) this.attempts.delete(key);
    while (this.attempts.size > 5000) this.attempts.delete(this.attempts.keys().next().value!);
    if ((this.attempts.get(client)?.until || 0) > now) throw new InputError('Too many attempts. Wait 15 minutes and try again.', 429);
    this.validateCredential(credential);
    const row = this.row();
    if (!row || !await Bun.password.verify(credential, row.verifier).catch(() => false)) {
      const before = this.attempts.get(client);
      const failures = (before?.failures || 0) + 1;
      this.attempts.set(client, { failures, at: before?.at || now, until: failures >= 5 ? now + 900000 : 0 });
      throw new InputError(failures >= 5 ? 'Too many attempts. Wait 15 minutes and try again.' : 'Password is incorrect.', failures >= 5 ? 429 : 401);
    }
    this.attempts.delete(client);
    return row;
  }
  async login(client: string, credential: string, revision: number) {
    const row = await this.verify(client, credential);
    if (revision !== row.revision || this.row()?.revision !== row.revision) throw new InputError('Password changed. Try again.', 409);
    const token = randomBytes(32).toString('base64url');
    this.db.query('DELETE FROM auth_sessions WHERE expiresAt<=?').run(this.now());
    this.db.query('INSERT INTO auth_sessions VALUES (?, ?, ?)').run(digest(token), row.revision, this.now() + this.sessionSeconds * 1000);
    return { token, maxAge: this.sessionSeconds };
  }
  async changePassword(client: string, request: Request, currentCredential: string, credential: string, config: any, revision: number) {
    const row = await this.verify(client, currentCredential);
    try { validateConfig(config); } catch { throw new InputError('Invalid vault configuration.'); }
    this.validateCredential(credential);
    if (revision !== row.revision || config.revision !== revision + 1 || config.vaultId !== JSON.parse(row.config).vaultId || config.kdf.salt === JSON.parse(row.config).kdf.salt) throw new InputError('Credential revision changed. Try again.', 409);
    const verifier = await Bun.password.hash(credential, { algorithm: 'argon2id', memoryCost: 65536, timeCost: 2 });
    this.db.transaction(() => {
      if (!this.isAuthenticated(request) || this.row()?.revision !== revision) throw new InputError('Credential revision changed. Sign in again.', 409);
      this.db.query('UPDATE vault SET revision=?, config=?, verifier=? WHERE id=1').run(config.revision, JSON.stringify(config), verifier);
      this.db.exec('DELETE FROM auth_sessions');
    })();
  }
  logout(request: Request) { const token = cookieValue(request); if (token) this.db.query('DELETE FROM auth_sessions WHERE tokenHash=?').run(digest(token)); }
  cookie(token: string, age: number, secure: boolean) { return `${secure ? secureSessionCookieName : sessionCookieName}=${token}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`; }
}
