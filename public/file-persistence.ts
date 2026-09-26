import { openDatabase, selectedAccount } from './persistence.ts';
import type { FileEntry, FileManifest, FileEnvelope } from './file-format.ts';
export interface LocalFile extends FileEntry { cached:boolean; uploaded:boolean; uploadEnvelope?:FileEnvelope; pending?:'upload'|'rename'; error?:string }
export interface FileState { revision:number; files:Record<string,LocalFile>; deletions:string[]; quota:Pick<FileManifest,'quotaBytes'|'usedBytes'|'maxFileBytes'> | null; error?:string }
export const emptyFiles = ():FileState => ({revision:0,files:{},deletions:[],quota:null});
export async function fileState(userId = selectedAccount()):Promise<FileState> {
  if (!userId) return emptyFiles();
  const db = await openDatabase();
  return new Promise((resolve,reject) => { const request:IDBRequest<FileState | undefined> = db.transaction('files').objectStore('files').get(userId); request.onsuccess=()=>resolve(request.result || emptyFiles()); request.onerror=()=>reject(request.error); });
}
export async function fileBlob(userId:string,id:string):Promise<Uint8Array<ArrayBuffer> | undefined> {
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{const r:IDBRequest<Uint8Array<ArrayBuffer>|undefined>=db.transaction('fileBlobs').objectStore('fileBlobs').get([userId,id]);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
}
export async function writeFiles(userId:string,epoch:number,change:(state:FileState,blobs:IDBObjectStore)=>void) {
  const db=await openDatabase();
  return new Promise<void>((resolve,reject)=>{
    const tx=db.transaction(['state','files','fileBlobs'],'readwrite');let problem:unknown;
    const active=tx.objectStore('state').get('active');
    active.onsuccess=()=>{
      if (active.result?.userId !== userId || active.result.epoch !== epoch) {problem=new Error('Workspace locked or account changed.');tx.abort();return;}
      const store=tx.objectStore('files'),r:IDBRequest<FileState|undefined>=store.get(userId);
      r.onsuccess=()=>{try {const state=r.result || emptyFiles();change(state,tx.objectStore('fileBlobs'));state.revision++;store.put(state,userId);}catch(e){problem=e;tx.abort();}};
    };
    tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(problem || tx.error || new Error('Could not save file on this device.'));
  });
}
