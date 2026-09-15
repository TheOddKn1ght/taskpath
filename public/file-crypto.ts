import { base64, unbase64, random, importVault } from './crypto.js';
import { fileEnvelope, fileMetadata, type FileEnvelope, type FileMetadata } from './file-format.js';
const encoder = new TextEncoder();
const aad = (e:FileEnvelope, purpose:string) => encoder.encode(JSON.stringify(['taskpath:file:v1',purpose,e.userId,e.vaultId,e.fileId,e.contentId,e.createdAt,...(purpose === 'metadata' ? [e.metadata.changeId,e.metadata.editedAt] : [])]));
const params = (e:FileEnvelope,purpose:string,nonce:string) => ({name:'AES-GCM',iv:unbase64(nonce,12),additionalData:aad(e,purpose),tagLength:128});
async function keyFor(key:CryptoKey,e:FileEnvelope) {
  const raw = new Uint8Array(await crypto.subtle.decrypt(params(e,'key',e.wrappedKey.nonce),key,unbase64(e.wrappedKey.ciphertext)));
  try { return await importVault(raw); } finally { raw.fill(0); }
}
export async function encryptFile(vaultKey:CryptoKey,userId:string,vaultId:string,bytes:Uint8Array<ArrayBuffer>,metadata:FileMetadata) {
  fileMetadata(metadata);
  const now = new Date().toISOString();
  const e:FileEnvelope = {version:1,userId,vaultId,fileId:crypto.randomUUID(),contentId:crypto.randomUUID(),createdAt:now,contentNonce:base64(random(12)),wrappedKey:{nonce:base64(random(12)),ciphertext:''},metadata:{changeId:crypto.randomUUID(),editedAt:now,nonce:base64(random(12)),ciphertext:''}};
  const raw = random(32);
  try {
    const key = await importVault(raw);
    e.wrappedKey.ciphertext = base64(await crypto.subtle.encrypt(params(e,'key',e.wrappedKey.nonce),vaultKey,raw));
    e.metadata.ciphertext = base64(await crypto.subtle.encrypt(params(e,'metadata',e.metadata.nonce),key,encoder.encode(JSON.stringify(metadata))));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(params(e,'content',e.contentNonce),key,bytes));
    return {envelope:e,ciphertext};
  } finally { raw.fill(0); }
}
export async function decryptFileMetadata(key:CryptoKey,e:FileEnvelope) {
  fileEnvelope(e,e.userId,e.vaultId);
  const raw = new Uint8Array(await crypto.subtle.decrypt(params(e,'metadata',e.metadata.nonce),await keyFor(key,e),unbase64(e.metadata.ciphertext)));
  try { return fileMetadata(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw))); } finally { raw.fill(0); }
}
export async function decryptFile(key:CryptoKey,e:FileEnvelope,ciphertext:Uint8Array<ArrayBuffer>) {
  fileEnvelope(e,e.userId,e.vaultId);
  return new Uint8Array(await crypto.subtle.decrypt(params(e,'content',e.contentNonce),await keyFor(key,e),ciphertext));
}
export async function renameFile(key:CryptoKey,e:FileEnvelope,name:string) {
  const metadata = fileMetadata({...await decryptFileMetadata(key,e),name});
  const next:FileEnvelope = {...e,metadata:{changeId:crypto.randomUUID(),editedAt:new Date(Math.max(Date.now(),Date.parse(e.metadata.editedAt)+1)).toISOString(),nonce:base64(random(12)),ciphertext:''}};
  next.metadata.ciphertext = base64(await crypto.subtle.encrypt(params(next,'metadata',next.metadata.nonce),await keyFor(key,e),encoder.encode(JSON.stringify(metadata))));
  return next;
}
export function imageType(bytes:Uint8Array):string | null {
  const starts = (...values:number[]) => values.every((value,i) => bytes[i] === value);
  if (starts(137,80,78,71,13,10,26,10)) return 'image/png';
  if (starts(255,216,255)) return 'image/jpeg';
  if (starts(71,73,70,56) && [55,57].includes(bytes[4]) && bytes[5] === 97) return 'image/gif';
  if (starts(82,73,70,70) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return 'image/webp';
  return null;
}
