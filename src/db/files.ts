import { and, eq, sql } from 'drizzle-orm';
import type { AppDatabase } from './connection';
import { encryptedFiles } from './schema';
import { FILE_COUNT_MAX, FILE_MAX, type FileEnvelope, sameFile, newerFile } from '../../public/file-format';
import { InputError } from '../store';
export class FileRepository {
  constructor(private db:AppDatabase, readonly quota:number) {}
  private where(userId:string,fileId:string) { return and(eq(encryptedFiles.userId,userId),eq(encryptedFiles.fileId,fileId)); }
  private usage(userId:string) { return this.db.select({used:sql<number>`coalesce(sum(${encryptedFiles.bytes}),0)`,count:sql<number>`count(*)`}).from(encryptedFiles).where(and(eq(encryptedFiles.userId,userId),eq(encryptedFiles.deleted,false))).get()!; }
  manifest(userId:string,vaultId:string) {
    const rows = this.db.select({envelope:encryptedFiles.envelope,fileId:encryptedFiles.fileId,bytes:encryptedFiles.bytes,deleted:encryptedFiles.deleted}).from(encryptedFiles).where(eq(encryptedFiles.userId,userId)).all();
    return {vaultId,quotaBytes:this.quota,usedBytes:rows.reduce((n,r)=>n+(r.deleted?0:r.bytes),0),maxFileBytes:Math.min(FILE_MAX,this.quota),files:rows.filter(r=>!r.deleted).map(r=>({envelope:JSON.parse(r.envelope!) as FileEnvelope,bytes:r.bytes})),deleted:rows.filter(r=>r.deleted).map(r=>r.fileId)};
  }
  content(userId:string,fileId:string) {
    const row = this.db.select().from(encryptedFiles).where(this.where(userId,fileId)).get();
    if (!row || row.deleted) throw new InputError('File is unavailable.',404);
    return new Uint8Array(row.ciphertext!);
  }
  upload(e:FileEnvelope, ciphertext:Uint8Array<ArrayBuffer>) {
    return this.db.transaction(() => {
      const old = this.db.select().from(encryptedFiles).where(this.where(e.userId,e.fileId)).get();
      if (old?.deleted) throw new InputError('File was permanently deleted.',410);
      if (old) {
        if (!sameFile(JSON.parse(old.envelope!),e) || !Buffer.from(ciphertext).equals(old.ciphertext!)) throw new InputError('File contents cannot be replaced.',409);
        // A retry cannot overwrite a newer rename or consume quota again.
        return;
      }
      const bytes = ciphertext.length - 16, usage = this.usage(e.userId);
      if (bytes < 0 || bytes > FILE_MAX) throw new InputError('File exceeds the 10 MB file limit.',413);
      if (this.quota === 0 || bytes > this.quota || usage.used + bytes > this.quota || usage.count >= FILE_COUNT_MAX) throw new InputError('Waiting for space. Free storage or increase the file quota.',507);
      this.db.insert(encryptedFiles).values({userId:e.userId,fileId:e.fileId,bytes,envelope:JSON.stringify(e),ciphertext:Buffer.from(ciphertext),deleted:false}).run();
    });
  }
  rename(e:FileEnvelope) {
    this.db.transaction(() => {
      const old = this.db.select({deleted:encryptedFiles.deleted,envelope:encryptedFiles.envelope}).from(encryptedFiles).where(this.where(e.userId,e.fileId)).get();
      if (old?.deleted) throw new InputError('File was permanently deleted.',410);
      if (!old) throw new InputError('Upload the file first.',404);
      const previous = JSON.parse(old.envelope!) as FileEnvelope;
      if (!sameFile(previous,e)) throw new InputError('File identity cannot change.',409);
      if (newerFile(e,previous)) this.db.update(encryptedFiles).set({envelope:JSON.stringify(e)}).where(this.where(e.userId,e.fileId)).run();
    });
  }
  delete(userId:string,fileId:string) {
    this.db.transaction(() => this.db.insert(encryptedFiles).values({userId,fileId,deleted:true,bytes:0}).onConflictDoUpdate({target:[encryptedFiles.userId,encryptedFiles.fileId],set:{deleted:true,bytes:0,envelope:null,ciphertext:null}}).run());
  }
}
