import { and, eq, gt, lte } from 'drizzle-orm';
import type { AppDatabase } from './connection';
import { accounts, sessions } from './schema';

export class AccountRepository {
  constructor(private db: AppDatabase) {}

  transaction<T>(work: () => T): T { return this.db.transaction(work); }

  get(userId: string) {
    return this.db.select().from(accounts).where(eq(accounts.userId, userId)).get();
  }

  list() {
    return this.db.select({ userId: accounts.userId, status: accounts.status, createdAt: accounts.createdAt, expiresAt: accounts.expiresAt })
      .from(accounts).orderBy(accounts.createdAt, accounts.userId).all();
  }

  createPending(userId: string, createdAt: number) {
    this.db.insert(accounts).values({ userId, status: 'pending', createdAt }).run();
  }

  setInvitation(userId: string, tokenHash: string | null, expiresAt: number | null) {
    return Boolean(this.db.update(accounts).set({ tokenHash, expiresAt })
      .where(and(eq(accounts.userId, userId), eq(accounts.status, 'pending')))
      .returning({ userId: accounts.userId }).get());
  }

  validInvitation(userId: string, tokenHash: string, now: number) {
    return Boolean(this.db.select({ userId: accounts.userId }).from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.status, 'pending'), eq(accounts.tokenHash, tokenHash), gt(accounts.expiresAt, now))).get());
  }

  activate(userId: string, config: string, verifier: string) {
    this.db.update(accounts).set({ status: 'active', revision: 1, config, verifier, tokenHash: null, expiresAt: null })
      .where(eq(accounts.userId, userId)).run();
  }

  disable(userId: string) {
    return Boolean(this.db.update(accounts).set({ status: 'disabled', tokenHash: null, expiresAt: null })
      .where(eq(accounts.userId, userId)).returning({ userId: accounts.userId }).get());
  }

  replaceCredentials(userId: string, revision: number, config: string, verifier: string) {
    this.db.update(accounts).set({ revision, config, verifier }).where(eq(accounts.userId, userId)).run();
  }

  sessionIdentity(tokenHash: string, now: number) {
    return this.db.select({ userId: sessions.userId }).from(sessions)
      .innerJoin(accounts, eq(accounts.userId, sessions.userId))
      .where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.revision, accounts.revision), gt(sessions.expiresAt, now), eq(accounts.status, 'active')))
      .get()?.userId ?? null;
  }

  createSession(tokenHash: string, userId: string, revision: number, expiresAt: number) {
    this.db.insert(sessions).values({ tokenHash, userId, revision, expiresAt }).run();
  }

  deleteExpiredSessions(now: number) {
    this.db.delete(sessions).where(lte(sessions.expiresAt, now)).run();
  }

  revokeSessions(userId: string) {
    this.db.delete(sessions).where(eq(sessions.userId, userId)).run();
  }

  deleteSession(tokenHash: string) {
    this.db.delete(sessions).where(eq(sessions.tokenHash, tokenHash)).run();
  }
}
