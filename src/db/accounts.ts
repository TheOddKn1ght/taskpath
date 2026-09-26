import { Database, transaction } from './connection.ts';

export interface AccountRow {
  userId: string;
  status: 'pending' | 'active' | 'disabled';
  createdAt: number;
  tokenHash: string | null;
  expiresAt: number | null;
  revision: number | null;
  config: string | null;
  verifier: string | null;
}

export class AccountRepository {
  constructor(private db: Database) {}

  transaction<T>(work: () => T): T { return transaction(this.db, work); }

  get(userId: string): AccountRow | undefined {
    return this.db.prepare('SELECT * FROM accounts WHERE userId=?').get(userId) as AccountRow | undefined;
  }

  list(): { userId: string; status: string; createdAt: number; expiresAt: number | null }[] {
    return this.db.prepare('SELECT userId, status, createdAt, expiresAt FROM accounts ORDER BY createdAt, userId').all() as { userId: string; status: string; createdAt: number; expiresAt: number | null }[];
  }

  createPending(userId: string, createdAt: number): void {
    this.db.prepare("INSERT INTO accounts(userId, status, createdAt) VALUES (?, 'pending', ?)").run(userId, createdAt);
  }

  setInvitation(userId: string, tokenHash: string | null, expiresAt: number | null): boolean {
    return Boolean((this.db.prepare("UPDATE accounts SET tokenHash=?, expiresAt=? WHERE userId=? AND status='pending' RETURNING userId").get(tokenHash, expiresAt, userId) as { userId: string } | undefined));
  }

  validInvitation(userId: string, tokenHash: string, now: number): boolean {
    return Boolean((this.db.prepare("SELECT userId FROM accounts WHERE userId=? AND status='pending' AND tokenHash=? AND expiresAt>?").get(userId, tokenHash, now) as { userId: string } | undefined));
  }

  activate(userId: string, config: string, verifier: string): void {
    this.db.prepare("UPDATE accounts SET status='active', revision=1, config=?, verifier=?, tokenHash=NULL, expiresAt=NULL WHERE userId=?").run(config, verifier, userId);
  }

  disable(userId: string): boolean {
    return Boolean((this.db.prepare("UPDATE accounts SET status='disabled', tokenHash=NULL, expiresAt=NULL WHERE userId=? RETURNING userId").get(userId) as { userId: string } | undefined));
  }

  replaceCredentials(userId: string, revision: number, config: string, verifier: string): void {
    this.db.prepare('UPDATE accounts SET revision=?, config=?, verifier=? WHERE userId=?').run(revision, config, verifier, userId);
  }

  sessionIdentity(tokenHash: string, now: number): string | null {
    const row = this.db.prepare(`SELECT s.userId AS userId FROM auth_sessions s
      INNER JOIN accounts a ON a.userId=s.userId
      WHERE s.tokenHash=? AND s.revision=a.revision AND s.expiresAt>? AND a.status='active'`).get(tokenHash, now) as { userId: string } | undefined;
    return row?.userId ?? null;
  }

  createSession(tokenHash: string, userId: string, revision: number, expiresAt: number): void {
    this.db.prepare('INSERT INTO auth_sessions(tokenHash, userId, revision, expiresAt) VALUES (?,?,?,?)').run(tokenHash, userId, revision, expiresAt);
  }

  deleteExpiredSessions(now: number): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE expiresAt<=?').run(now);
  }

  revokeSessions(userId: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE userId=?').run(userId);
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE tokenHash=?').run(tokenHash);
  }
}
