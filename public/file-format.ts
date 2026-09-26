import { exact, validId, validUserId, unbase64 } from './crypto.ts';
export const FILE_MAX = 10_000_000, FILE_HEADER_MAX = 8192, FILE_COUNT_MAX = 1000;
export interface FileMetadata { name:string; type:string; lastModified:number }
export interface FileEnvelope {
  version:1; userId:string; vaultId:string; fileId:string; contentId:string; createdAt:string;
  contentNonce:string; wrappedKey:{nonce:string; ciphertext:string};
  metadata:{changeId:string; editedAt:string; nonce:string; ciphertext:string};
}
export interface FileEntry { envelope:FileEnvelope; bytes:number }
export interface FileManifest { vaultId:string; quotaBytes:number; usedBytes:number; maxFileBytes:number; files:FileEntry[]; deleted:string[] }
export function fileQuota(value: string | undefined): number {
  if (value === undefined) return FILE_MAX;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value) * 1_000_000)) throw new Error('TASKPATH_FILE_QUOTA_MB must be a safe nonnegative whole number.');
  return Number(value) * 1_000_000;
}
const iso = (value:unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function fileEnvelope(raw:unknown, userId:string, vaultId:string):FileEnvelope {
  exact(raw, ['version','userId','vaultId','fileId','contentId','createdAt','contentNonce','wrappedKey','metadata']);
  if (JSON.stringify(raw).length > FILE_HEADER_MAX || raw.version !== 1 || raw.userId !== userId || !validUserId(userId) || raw.vaultId !== vaultId || !validId(vaultId) || !validId(raw.fileId) || !validId(raw.contentId) || !iso(raw.createdAt)) throw new Error('Invalid encrypted file.');
  exact(raw.wrappedKey, ['nonce','ciphertext']); exact(raw.metadata, ['changeId','editedAt','nonce','ciphertext']);
  unbase64(raw.contentNonce,12); unbase64(raw.wrappedKey.nonce,12); unbase64(raw.wrappedKey.ciphertext,48); unbase64(raw.metadata.nonce,12);
  if (!validId(raw.metadata.changeId) || !iso(raw.metadata.editedAt) || unbase64(raw.metadata.ciphertext).length < 16) throw new Error('Invalid encrypted file metadata.');
  return raw as unknown as FileEnvelope;
}
export function fileMetadata(raw:unknown):FileMetadata {
  exact(raw,['name','type','lastModified']);
  if (typeof raw.name !== 'string' || !raw.name.trim() || !raw.name.isWellFormed() || [...raw.name].length > 255 || /[\p{Cc}\/\\]/u.test(raw.name) || typeof raw.type !== 'string' || raw.type.length > 255 || /[\p{Cc}]/u.test(raw.type) || typeof raw.lastModified !== 'number' || !Number.isSafeInteger(raw.lastModified) || raw.lastModified < 0) throw new Error('Invalid filename or file metadata.');
  return raw as unknown as FileMetadata;
}
export function newerFile(a:FileEnvelope, b:FileEnvelope) { return a.metadata.editedAt > b.metadata.editedAt || a.metadata.editedAt === b.metadata.editedAt && a.metadata.changeId > b.metadata.changeId; }
export function sameFile(a:FileEnvelope, b:FileEnvelope) { return a.fileId === b.fileId && a.userId === b.userId && a.vaultId === b.vaultId && a.contentId === b.contentId && a.createdAt === b.createdAt && a.contentNonce === b.contentNonce && a.wrappedKey.nonce === b.wrappedKey.nonce && a.wrappedKey.ciphertext === b.wrappedKey.ciphertext; }
export function encodeFile(envelope:FileEnvelope, ciphertext:Uint8Array<ArrayBuffer>):Uint8Array<ArrayBuffer> {
  const header = new TextEncoder().encode(JSON.stringify(envelope));
  if (header.length > FILE_HEADER_MAX || ciphertext.length < 16 || ciphertext.length > FILE_MAX + 16) throw new Error('File is too large.');
  const output = new Uint8Array(4 + header.length + ciphertext.length); new DataView(output.buffer).setUint32(0, header.length); output.set(header,4); output.set(ciphertext,4+header.length); return output;
}
export function decodeFile(data:Uint8Array<ArrayBuffer>, userId:string, vaultId:string) {
  if (data.length < 20) throw new Error('Incomplete file.');
  const length = new DataView(data.buffer,data.byteOffset,data.byteLength).getUint32(0);
  if (length > FILE_HEADER_MAX || data.length < 4 + length + 16 || data.length > 4 + length + FILE_MAX + 16) throw new Error('Invalid file length.');
  const envelope = fileEnvelope(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data.slice(4,4+length))),userId,vaultId);
  return {envelope,ciphertext:data.slice(4+length)};
}
export function fileManifest(raw:unknown, userId:string, vaultId:string):FileManifest {
  exact(raw,['vaultId','quotaBytes','usedBytes','maxFileBytes','files','deleted']);
  if (raw.vaultId !== vaultId || ![raw.quotaBytes,raw.usedBytes,raw.maxFileBytes].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) || raw.maxFileBytes !== Math.min(FILE_MAX,raw.quotaBytes as number) || !Array.isArray(raw.files) || raw.files.length > FILE_COUNT_MAX || !Array.isArray(raw.deleted) || !raw.deleted.every(validId)) throw new Error('Invalid file manifest.');
  for (const entry of raw.files) { exact(entry,['envelope','bytes']); fileEnvelope(entry.envelope,userId,vaultId); if (typeof entry.bytes !== 'number' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > FILE_MAX) throw new Error('Invalid file size.'); }
  return raw as unknown as FileManifest;
}
