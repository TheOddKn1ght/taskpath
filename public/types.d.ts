// Compile-time contracts only. Persisted/wire formats are unchanged.
export type Status = 'later' | 'week' | 'today' | 'done';
export type Category = 'work' | 'personal';
export interface Task {
  id: string; title: string; notes: string; tags: string[]; category: Category; status: Status; position: number;
  plannedDay: string | null; plannedWeek: string | null; completedAt: string | null;
  createdAt: string; updatedAt: string; deletedAt: string | null; archivedAt: string | null;
  dueDate: string | null; reminderAt: string | null; reminderDismissedAt: string | null; reminderNotifiedAt: string | null;
  reminderToken?: string | null;
}
export interface Profile { id: '_profile'; nickname: string; updatedAt: string }
export interface IdentifiedRecord extends Record<string, unknown> { id: string; updatedAt: string }
export interface Kdf { version: 1; algorithm: 'PBKDF2'; hash: 'SHA-256'; iterations: 600000; salt: string }
export interface VaultConfig { vaultId: string; revision: number; kdf: Kdf; wrappedKey: { nonce: string; ciphertext: string } }
export interface Envelope { version: 1; vaultId: string; taskId: string; editedAt: string; changeId: string; nonce: string; ciphertext: string }
export interface Change<T = Task> { changeId: string; editedAt: string; task: T }
export interface ReminderMetadata { taskId: string; changeId: string; token: string | null; dueAt: string | null }
export interface SyncBoard { format: number; workspaceKey: string; timezone: string; serverTime: string; rows: Envelope[]; pushEnabled?: boolean }
export interface SyncResult extends SyncBoard { acknowledged: string[]; conflicts: number; reminderAcknowledged?: {taskId:string;changeId:string}[] }
export interface PlainBoard { rows: Task[]; changeIds: Record<string,string>; timezone: string; nickname?: string; workspaceKey?: string; serverTime?: string; format?: number; pushEnabled?: boolean }
export interface Board extends PlainBoard { tasks: Task[]; day: string; week: string; serverTime: string; reminders: Task[] }
export interface PlainRecord { board: PlainBoard | null; pending: Change[]; offset: number; lastEdit: number; locked?: boolean }
export interface EncryptedRecord {
  revision: number; lockEpoch: number; config: VaultConfig | null; board: SyncBoard | null; pending: Envelope[]; offset: number; lastEdit: number;
  userId?: string | null; inactive?: boolean; locked?: boolean; online?: boolean; authRequired?: boolean;
  conflicts?: number; pushEnabled?: boolean; reminderOutbox?: Record<string,ReminderMetadata>; lastSync?: string; error?: string | null; reminderPublished?: Record<string,string>;
}
export interface RememberedKey { userId: string; vaultId: string; lockEpoch: number; key: CryptoKey }
export interface ArchiveReceipt { id:string; changeId:string }
export interface MutationResult { ok: boolean; task: Task; undo?: ArchiveReceipt[] }
export interface ArchiveResult { archived:number; restored:number; skipped:number; undo:ArchiveReceipt[] }
export interface ImportPreview { tasks:Task[]; skipped:number }
export type TaskInput = Partial<Task> & { beforeId?:string | null; action?:string };
export interface Route { view:'board'|'archive'; query:string; category:'all'|Category; tag:string }
export interface PushStatus { available:boolean; publicKey:string | null; subscriptionIds:string[]; enabled?:boolean }
