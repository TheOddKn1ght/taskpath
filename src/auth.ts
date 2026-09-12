import { createHash, randomBytes } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { InputError } from './store';
import { connect } from './db/connection';
import { AccountRepository } from './db/accounts';
import { validateConfig, unbase64, validUserId } from '../public/crypto.js';
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
  private accounts: AccountRepository;
  constructor(db: Database, sessionDays = 30, private now = () => Date.now()) {
    if (!Number.isInteger(sessionDays) || sessionDays < 1 || sessionDays > 365) throw new Error('TASKPATH_SESSION_DAYS must be from 1 to 365.');
    this.sessionSeconds = sessionDays * 86400;
    this.accounts = new AccountRepository(connect(db));
  }
  private row(userId: string) { return this.accounts.get(userId); }
  configuration(userId: string) { const row = this.row(userId); return row?.status === 'active' ? validateConfig(JSON.parse(row.config!)) : null; }
  createInvitation() {
    return this.accounts.transaction(() => {
      const userId = 'u_' + randomBytes(16).toString('hex');
      this.accounts.createPending(userId, this.now());
      return this.renewInvitation(userId);
    });
  }
  renewInvitation(userId: string) {
    const token = randomBytes(32).toString('base64url'), expiresAt = this.now() + 86400000;
    if (!this.accounts.setInvitation(userId, digest(token), expiresAt)) throw new InputError('Only pending accounts can receive a new invitation.');
    return { userId, token, expiresAt };
  }
  revokeInvitation(userId: string) {
    if (!this.accounts.setInvitation(userId, null, null)) throw new InputError('Pending account not found.');
  }
  disable(userId: string) {
    this.accounts.transaction(() => {
      if (!this.accounts.disable(userId)) throw new InputError('Account not found.');
      this.accounts.revokeSessions(userId);
    });
  }
  list() { return this.accounts.list(); }
  private validSetup(userId: unknown, token: unknown) {
    return validUserId(userId) && typeof token === 'string' && token.length === 43 && this.accounts.validInvitation(userId as string, digest(token), this.now());
  }
  private validateCredential(credential: unknown) {
    try { unbase64(credential, 32); } catch { throw new InputError('Invalid authentication credential.'); }
  }
  async setup(userId: string, token: unknown, rawConfig: unknown, credential: string) {
    if (!this.validSetup(userId, token)) throw new InputError('Invitation is invalid, used, or expired. Ask the administrator for a new invitation.', 403);
    let config: ReturnType<typeof validateConfig>;
    try { config = validateConfig(rawConfig); } catch { throw new InputError('Invalid vault configuration.'); }
    if (config.revision !== 1) throw new InputError('Invalid initial revision.');
    this.validateCredential(credential);
    const verifier = await Bun.password.hash(credential, { algorithm: 'argon2id', memoryCost: 65536, timeCost: 2 });
    this.accounts.transaction(() => {
      if (!this.validSetup(userId, token)) throw new InputError('Invitation has already been used or expired.', 409);
      this.accounts.activate(userId, JSON.stringify(config), verifier);
    });
  }
  identity(request: Request): string | null {
    const token = cookieValue(request);
    if (!token || token.length > 128) return null;
    return this.accounts.sessionIdentity(digest(token), this.now());
  }
  isAuthenticated(request: Request) { return this.identity(request) !== null; }
  private async verify(client: string, userId: string, credential: string) {
    const now = this.now(), rateKey = client + ':' + userId;
    for (const [key, a] of this.attempts) if (a.until <= now && now - a.at >= 600000) this.attempts.delete(key);
    while (this.attempts.size > 5000) this.attempts.delete(this.attempts.keys().next().value!);
    if ((this.attempts.get(rateKey)?.until || 0) > now) throw new InputError('Too many attempts. Wait 15 minutes and try again.', 429);
    this.validateCredential(credential);
    const row = validUserId(userId) ? this.row(userId) : null;
    if (!row || row.status !== 'active' || !await Bun.password.verify(credential, row.verifier!).catch(() => false)) {
      const before = this.attempts.get(rateKey), failures = (before?.failures || 0) + 1;
      this.attempts.set(rateKey, { failures, at: before?.at || now, until: failures >= 5 ? now + 900000 : 0 });
      throw new InputError(failures >= 5 ? 'Too many attempts. Wait 15 minutes and try again.' : 'User ID or password is incorrect.', failures >= 5 ? 429 : 401);
    }
    this.attempts.delete(rateKey);
    return row;
  }
  async login(client: string, userId: string, credential: string, revision: number) {
    const row = await this.verify(client, userId, credential);
    // Recheck after asynchronous hashing: disabling an account must beat login.
    const current = this.row(userId);
    if (current?.status !== 'active' || revision !== row.revision || current.revision !== row.revision) throw new InputError('Account changed. Sign in again.', 409);
    const token = randomBytes(32).toString('base64url');
    this.accounts.deleteExpiredSessions(this.now());
    this.accounts.createSession(digest(token), userId, row.revision!, this.now() + this.sessionSeconds * 1000);
    return { token, maxAge: this.sessionSeconds };
  }
  async changePassword(client: string, request: Request, currentCredential: string, credential: string, rawConfig: unknown, revision: number) {
    const userId = this.identity(request);
    if (!userId) throw new InputError('Sign in again.', 401);
    const row = await this.verify(client, userId, currentCredential);
    let config: ReturnType<typeof validateConfig>;
    try { config = validateConfig(rawConfig); } catch { throw new InputError('Invalid vault configuration.'); }
    this.validateCredential(credential);
    if (revision !== row.revision || config.revision !== revision + 1 || config.vaultId !== JSON.parse(row.config!).vaultId || config.kdf.salt === JSON.parse(row.config!).kdf.salt) throw new InputError('Credential revision changed. Try again.', 409);
    const verifier = await Bun.password.hash(credential, { algorithm: 'argon2id', memoryCost: 65536, timeCost: 2 });
    this.accounts.transaction(() => {
      if (this.identity(request) !== userId || this.row(userId)?.revision !== revision) throw new InputError('Credential revision changed. Sign in again.', 409);
      this.accounts.replaceCredentials(userId, config.revision, JSON.stringify(config), verifier);
      this.accounts.revokeSessions(userId);
    });
  }
  logout(request: Request) { const token = cookieValue(request); if (token) this.accounts.deleteSession(digest(token)); }
  cookie(token: string, age: number, secure: boolean) { return `${secure ? secureSessionCookieName : sessionCookieName}=${token}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`; }
}
