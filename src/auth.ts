import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";

export type AuthConfig = {
  username: string;
  passwordHash: string;
  sessionDays?: number;
};

type Attempt = { failures: number; firstFailureAt: number; blockedUntil: number };
type LoginResult = { ok: true; token: string; maxAge: number } | { ok: false; status: 401 | 429; retryAfter?: number };

export const sessionCookieName = "taskpath_session";
export const secureSessionCookieName = "__Host-taskpath_session";
const attemptWindowMs = 10 * 60 * 1000;
const blockMs = 15 * 60 * 1000;
const maxFailures = 5;

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function equal(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(request: Request, name: string) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

export class AuthManager {
  private fingerprint: string;
  private sessionSeconds: number;
  private attempts = new Map<string, Attempt>();

  constructor(private db: Database, private config: AuthConfig, private now = () => Date.now()) {
    this.fingerprint = digest(config.passwordHash);
    this.sessionSeconds = Math.round((config.sessionDays ?? 30) * 24 * 60 * 60);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        tokenHash TEXT PRIMARY KEY,
        credentialFingerprint TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expiresAt);
    `);
    this.removeExpired();
  }

  get username() { return this.config.username; }

  isAuthenticated(request: Request) {
    const token = cookieValue(request, secureSessionCookieName) || cookieValue(request, sessionCookieName);
    if (!token || token.length > 128) return false;
    const now = this.now();
    const session = this.db.query<{ expiresAt: number }, [string, string, number]>(
      "SELECT expiresAt FROM auth_sessions WHERE tokenHash = ? AND credentialFingerprint = ? AND expiresAt > ?",
    ).get(digest(token), this.fingerprint, now);
    return Boolean(session);
  }

  async login(client: string, username: string, password: string): Promise<LoginResult> {
    const now = this.now();
    this.pruneAttempts(now);
    const previous = this.attempts.get(client);
    if (previous?.blockedUntil && previous.blockedUntil > now) {
      return { ok: false, status: 429, retryAfter: Math.ceil((previous.blockedUntil - now) / 1000) };
    }
    if (previous && now - previous.firstFailureAt >= attemptWindowMs) this.attempts.delete(client);

    // Verify the hash even for an unknown username so the two failures take similar time.
    const passwordMatches = await Bun.password.verify(password, this.config.passwordHash).catch(() => false);
    if (!equal(username, this.config.username) || !passwordMatches) {
      const current = this.attempts.get(client);
      const failures = (current?.failures || 0) + 1;
      const firstFailureAt = current?.firstFailureAt || now;
      const blockedUntil = failures >= maxFailures ? now + blockMs : 0;
      this.attempts.set(client, { failures, firstFailureAt, blockedUntil });
      return blockedUntil ? { ok: false, status: 429, retryAfter: Math.ceil(blockMs / 1000) } : { ok: false, status: 401 };
    }

    this.attempts.delete(client);
    this.removeExpired();
    const token = randomBytes(32).toString("base64url");
    this.db.query("INSERT INTO auth_sessions (tokenHash, credentialFingerprint, createdAt, expiresAt) VALUES (?, ?, ?, ?)")
      .run(digest(token), this.fingerprint, now, now + this.sessionSeconds * 1000);
    return { ok: true, token, maxAge: this.sessionSeconds };
  }

  logout(request: Request) {
    const token = cookieValue(request, secureSessionCookieName) || cookieValue(request, sessionCookieName);
    if (token && token.length <= 128) this.db.query("DELETE FROM auth_sessions WHERE tokenHash = ?").run(digest(token));
  }

  cookie(token: string, maxAge: number, secure: boolean) {
    const name = secure ? secureSessionCookieName : sessionCookieName;
    return `${name}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
  }

  clearCookie(secure: boolean) {
    return this.cookie("", 0, secure);
  }

  private removeExpired() {
    this.db.query("DELETE FROM auth_sessions WHERE expiresAt <= ? OR credentialFingerprint != ?").run(this.now(), this.fingerprint);
  }

  private pruneAttempts(now: number) {
    for (const [client, attempt] of this.attempts) {
      if (attempt.blockedUntil <= now && now - attempt.firstFailureAt >= attemptWindowMs) this.attempts.delete(client);
    }
    while (this.attempts.size > 5000) this.attempts.delete(this.attempts.keys().next().value!);
  }
}
