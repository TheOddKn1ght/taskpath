import { withFileKey } from './offline.ts';
import { encryptFile, decryptFile, decryptFileMetadata, renameFile, imageType } from './file-crypto.ts';
import { FILE_MAX, FILE_COUNT_MAX } from './file-format.ts';
import { fileState, fileBlob, writeFiles, type LocalFile } from './file-persistence.ts';
import { filesChanged, syncFiles } from './file-sync.ts';
export { fileState, syncFiles };
export async function listFiles() {
  return withFileKey(async(key,userId)=>{
    const state=await fileState(userId), files=[];
    for(const entry of Object.values(state.files)){
      try {files.push({...entry,details:await decryptFileMetadata(key,entry.envelope)});}
      catch {files.push({...entry,details:{name:'Unreadable file',type:'',lastModified:0},unreadable:true});}
    }
    return {...state,files};
  });
}
export async function addFile(file:File) {
  if(file.size>FILE_MAX)throw new Error('Each file must be 10 MB or smaller.');
  await withFileKey(async(key,userId,vaultId,epoch)=>{
    const raw=new Uint8Array(await file.arrayBuffer());
    try {
      const encrypted=await encryptFile(key,userId,vaultId,raw,{name:file.name,type:file.type,lastModified:file.lastModified});
      await writeFiles(userId,epoch,(s,b)=>{
        const quota=s.quota?.quotaBytes ?? FILE_MAX;
        if(quota===0 || file.size>Math.min(FILE_MAX,quota) || Object.values(s.files).reduce((sum,e)=>sum+e.bytes,0)+file.size>quota || Object.keys(s.files).length>=FILE_COUNT_MAX)throw new Error('Not enough file storage. Free space before adding this file.');
        const id=encrypted.envelope.fileId;
        s.files[id]={envelope:encrypted.envelope,uploadEnvelope:encrypted.envelope,bytes:file.size,cached:true,uploaded:false,pending:'upload'};b.put(encrypted.ciphertext,[userId,id]);
      });
    } finally {raw.fill(0);}
  });
  filesChanged();void syncFiles();
  void navigator.storage?.persist?.().catch(()=>{});
}
export async function renameStoredFile(id:string,name:string) {
  await withFileKey(async(key,userId,_vaultId,epoch)=>{
    const old=(await fileState(userId)).files[id];if(!old)throw new Error('File was deleted.');
    const envelope=await renameFile(key,old.envelope,name);
    await writeFiles(userId,epoch,s=>{const current=s.files[id];if(!current || current.envelope.metadata.changeId!==old.envelope.metadata.changeId)throw new Error('File changed in another tab. Try again.');current.envelope=envelope;current.pending=current.uploaded?'rename':'upload';current.error=undefined;});
  });filesChanged();void syncFiles();
}
export async function deleteStoredFile(id:string) {
  await withFileKey(async(_key,userId,_vaultId,epoch)=>{
    await writeFiles(userId,epoch,(s,b)=>{delete s.files[id];b.delete([userId,id]);if(!s.deletions.includes(id))s.deletions.push(id);});
  });filesChanged();void syncFiles();
}
export async function readStoredFile(id:string) {
  return withFileKey(async(key,userId)=>{
    const entry=(await fileState(userId)).files[id];if(!entry)throw new Error('File was deleted.');
    const encrypted=await fileBlob(userId,id);if(!encrypted)throw new Error('This file has not finished downloading. Connect to download it.');
    const [bytes,details]=await Promise.all([decryptFile(key,entry.envelope,encrypted),decryptFileMetadata(key,entry.envelope)]);
    return {bytes,details,imageType:imageType(bytes)};
  });
}
export function fileStatus(file:LocalFile) {
  return file.error || (file.pending==='upload'?'Pending upload':file.pending==='rename'?'Pending rename':file.cached?'Available offline':'Downloading');
}
