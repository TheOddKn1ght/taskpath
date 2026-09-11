-- Deployed multi-user schema before the Drizzle refactor. Keep this fixture frozen.
PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS encrypted_format (version INTEGER NOT NULL);
    INSERT INTO encrypted_format SELECT 2 WHERE NOT EXISTS (SELECT 1 FROM encrypted_format);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts (userId TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('pending','active','disabled')), createdAt INTEGER NOT NULL, tokenHash TEXT, expiresAt INTEGER, revision INTEGER, config TEXT, verifier TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS invitation_hash ON accounts(tokenHash) WHERE tokenHash IS NOT NULL;
    CREATE TABLE IF NOT EXISTS encrypted_tasks (userId TEXT NOT NULL, taskId TEXT NOT NULL, editedAt TEXT NOT NULL, changeId TEXT NOT NULL, envelope TEXT NOT NULL, PRIMARY KEY(userId, taskId));
    CREATE TABLE IF NOT EXISTS reminder_claims (userId TEXT NOT NULL, token TEXT NOT NULL, PRIMARY KEY(userId, token));
    CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, userId TEXT NOT NULL, subscription TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS push_reminders (userId TEXT NOT NULL, taskId TEXT NOT NULL, changeId TEXT NOT NULL, token TEXT NOT NULL, dueAt INTEGER NOT NULL, PRIMARY KEY(userId, taskId));
    CREATE TABLE IF NOT EXISTS push_deliveries (userId TEXT NOT NULL, taskId TEXT NOT NULL, token TEXT NOT NULL, subscriptionId TEXT NOT NULL, nextAt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(userId, token, subscriptionId));
    CREATE INDEX IF NOT EXISTS push_due ON push_reminders(dueAt);
  
CREATE TABLE IF NOT EXISTS auth_sessions (tokenHash TEXT PRIMARY KEY, userId TEXT NOT NULL, revision INTEGER NOT NULL, expiresAt INTEGER NOT NULL)
