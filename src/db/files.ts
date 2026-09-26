import { Database, transaction } from './connection.ts';
import { FILE_COUNT_MAX, FILE_MAX, type FileEnvelope, sameFile, newerFile } from '../../public/file-format.ts';
import { InputError } from '../store.ts';

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
};

export class FileRepository {
  constructor(private db: Database, readonly quota: number) {}
  private usage(userId: string): { used: number; count: number } {
    return this.db.prepare('SELECT coalesce(sum(bytes),0) AS used, count(*) AS count FROM encrypted_files WHERE userId=? AND deleted=0').get(userId) as { used: number; count: number };
  }
  manifest(userId: string, vaultId: string) {
    const rows = this.db.prepare('SELECT envelope, fileId, bytes, deleted FROM encrypted_files WHERE userId=?').all(userId) as { envelope: string | null; fileId: string; bytes: number; deleted: number }[];
    return { vaultId, quotaBytes: this.quota, usedBytes: rows.reduce((n, r) => n + (r.deleted ? 0 : r.bytes), 0), maxFileBytes: Math.min(FILE_MAX, this.quota), files: rows.filter(r => !r.deleted).map(r => ({ envelope: JSON.parse(r.envelope!) as FileEnvelope, bytes: r.bytes })), deleted: rows.filter(r => r.deleted).map(r => r.fileId) };
  }
  content(userId: string, fileId: string): Uint8Array<ArrayBuffer> {
    const row = this.db.prepare('SELECT deleted, ciphertext FROM encrypted_files WHERE userId=? AND fileId=?').get(userId, fileId) as { deleted: number; ciphertext: Uint8Array<ArrayBuffer> | null } | undefined;
    if (!row || row.deleted) throw new InputError('File is unavailable.', 404);
    return new Uint8Array(row.ciphertext!);
  }
  upload(e: FileEnvelope, ciphertext: Uint8Array): void {
    return transaction(this.db, () => {
      const old = this.db.prepare('SELECT deleted, envelope, ciphertext FROM encrypted_files WHERE userId=? AND fileId=?').get(e.userId, e.fileId) as { deleted: number; envelope: string; ciphertext: Uint8Array } | undefined;
      if (old?.deleted) throw new InputError('File was permanently deleted.', 410);
      if (old) {
        if (!sameFile(JSON.parse(old.envelope!), e) || !bytesEqual(new Uint8Array(ciphertext), new Uint8Array(old.ciphertext!))) throw new InputError('File contents cannot be replaced.', 409);
        // A retry cannot overwrite a newer rename or consume quota again.
        return;
      }
      const bytes = ciphertext.byteLength - 16, usage = this.usage(e.userId);
      if (bytes < 0 || bytes > FILE_MAX) throw new InputError('File exceeds the 10 MB file limit.', 413);
      if (this.quota === 0 || bytes > this.quota || usage.used + bytes > this.quota || usage.count >= FILE_COUNT_MAX) throw new InputError('Waiting for space. Free storage or increase the file quota.', 507);
      this.db.prepare('INSERT INTO encrypted_files(userId, fileId, bytes, envelope, ciphertext, deleted) VALUES (?,?,?,?,?,0)').run(e.userId, e.fileId, bytes, JSON.stringify(e), ciphertext);
    });
  }
  rename(e: FileEnvelope): void {
    transaction(this.db, () => {
      const old = this.db.prepare('SELECT deleted, envelope FROM encrypted_files WHERE userId=? AND fileId=?').get(e.userId, e.fileId) as { deleted: number; envelope: string } | undefined;
      if (old?.deleted) throw new InputError('File was permanently deleted.', 410);
      if (!old) throw new InputError('Upload the file first.', 404);
      const previous = JSON.parse(old.envelope!) as FileEnvelope;
      if (!sameFile(previous, e)) throw new InputError('File identity cannot change.', 409);
      if (newerFile(e, previous)) this.db.prepare('UPDATE encrypted_files SET envelope=? WHERE userId=? AND fileId=?').run(JSON.stringify(e), e.userId, e.fileId);
    });
  }
  delete(userId: string, fileId: string): void {
    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO encrypted_files(userId, fileId, bytes, deleted) VALUES (?,?,0,1)
        ON CONFLICT(userId, fileId) DO UPDATE SET deleted=1, bytes=0, envelope=NULL, ciphertext=NULL`).run(userId, fileId);
    });
  }
}
