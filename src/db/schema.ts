import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const encryptedFormat = sqliteTable('encrypted_format', {
  version: integer().notNull(),
});

export const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value: text().notNull(),
});

export const accounts = sqliteTable('accounts', {
  userId: text().primaryKey(),
  status: text({ enum: ['pending', 'active', 'disabled'] }).notNull(),
  createdAt: integer().notNull(),
  tokenHash: text(),
  expiresAt: integer(),
  revision: integer(),
  config: text(),
  verifier: text(),
}, table => [
  check('account_status', sql`${table.status} IN ('pending','active','disabled')`),
  uniqueIndex('invitation_hash').on(table.tokenHash).where(sql`${table.tokenHash} IS NOT NULL`),
]);

export const sessions = sqliteTable('auth_sessions', {
  tokenHash: text().primaryKey(),
  userId: text().notNull(),
  revision: integer().notNull(),
  expiresAt: integer().notNull(),
});

export const encryptedTasks = sqliteTable('encrypted_tasks', {
  userId: text().notNull(),
  taskId: text().notNull(),
  editedAt: text().notNull(),
  changeId: text().notNull(),
  // Preserve the serialized envelope byte-for-byte on reads and retries.
  envelope: text().notNull(),
}, table => [primaryKey({ columns: [table.userId, table.taskId] })]);

export const reminderClaims = sqliteTable('reminder_claims', {
  userId: text().notNull(),
  token: text().notNull(),
}, table => [primaryKey({ columns: [table.userId, table.token] })]);

export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: text().primaryKey(),
  userId: text().notNull(),
  subscription: text().notNull(),
});

export const pushReminders = sqliteTable('push_reminders', {
  userId: text().notNull(),
  taskId: text().notNull(),
  changeId: text().notNull(),
  token: text().notNull(),
  dueAt: integer().notNull(),
}, table => [
  primaryKey({ columns: [table.userId, table.taskId] }),
  index('push_due').on(table.dueAt),
]);

export const pushDeliveries = sqliteTable('push_deliveries', {
  userId: text().notNull(),
  taskId: text().notNull(),
  token: text().notNull(),
  subscriptionId: text().notNull(),
  nextAt: integer().notNull(),
  attempts: integer().notNull().default(0),
}, table => [primaryKey({ columns: [table.userId, table.token, table.subscriptionId] })]);

export type Account = typeof accounts.$inferSelect;
export type EncryptedTaskRow = typeof encryptedTasks.$inferInsert;
export type ReminderRow = typeof pushReminders.$inferInsert;
export type Delivery = typeof pushDeliveries.$inferSelect;
