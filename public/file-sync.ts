import { accountApi } from './api.js';
import { RequestError } from './errors.js';
import { fileState, fileBlob, writeFiles } from './file-persistence.js';
import { localState, selectedAccount, loadAccount } from './persistence.js';
import { newerFile, sameFile, type FileManifest } from './file-format.js';
const channel=typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('taskpath-files-v1') : null;
export function filesChanged() { channel?.postMessage('changed'); if(typeof window !== 'undefined') window.dispatchEvent(new Event('taskpath-files')); }
if(typeof window !== 'undefined' && channel) channel.onmessage=()=>window.dispatchEvent(new Event('taskpath-files'));
let syncing:Promise<void>|null=null;
export function syncFiles():Promise<void> {
  if(syncing)return syncing;
  const run=async()=>{
    if(typeof window === 'undefined')await loadAccount();
    const userId=selectedAccount();if(!userId)return;
    const record=await localState(undefined,userId);if(!record.config || record.inactive)return;
    const epoch=record.lockEpoch,vaultId=record.config.vaultId;
    const files = accountApi(userId).files;
    async function withAccount<T>(work:()=>Promise<T>):Promise<T> {
      const current=await localState(undefined,userId);
      if(current.inactive || current.lockEpoch !== epoch)throw new Error('Workspace changed.');
      return work();
    }
    const refresh=async()=>{
      const manifest=await withAccount(()=>files.manifest(vaultId));
      await writeFiles(userId,epoch,(state,blobs)=>{
        state.quota={quotaBytes:manifest.quotaBytes,usedBytes:manifest.usedBytes,maxFileBytes:manifest.maxFileBytes};state.error=undefined;
        for(const id of manifest.deleted){delete state.files[id];state.deletions=state.deletions.filter(x=>x!==id);blobs.delete([userId,id]);}
        for(const entry of manifest.files){
          const id=entry.envelope.fileId;if(state.deletions.includes(id))continue;
          const current=state.files[id];
          if(current && !sameFile(current.envelope,entry.envelope))throw new Error('Server file identity changed.');
          if(!current)state.files[id]={...entry,cached:false,uploaded:true};
          else {
            current.uploaded=true;current.uploadEnvelope=undefined;
            if(!current.pending || !newerFile(current.envelope,entry.envelope)){current.envelope=entry.envelope;current.pending=undefined;current.error=undefined;}
            else if(current.pending==='upload')current.pending='rename';
          }
        }
      });filesChanged();return manifest;
    };
    try {
      // Refresh quota and deletion markers before transferring anything.
      await refresh();
      for(const id of (await fileState(userId)).deletions){await withAccount(()=>files.delete(id));await writeFiles(userId,epoch,(s,b)=>{s.deletions=s.deletions.filter(x=>x!==id);delete s.files[id];b.delete([userId,id]);});}
      for(const initial of Object.values((await fileState(userId)).files)){
        const id=initial.envelope.fileId,current=(await fileState(userId)).files[id];if(!current?.pending)continue;
        const submitted=current.pending==='upload'?(current.uploadEnvelope || current.envelope):current.envelope;
        try {
          if(current.pending==='upload'){
            const bytes=await fileBlob(userId,id);if(!bytes)throw new Error('Local file data is missing.');
            await withAccount(()=>files.upload(submitted,bytes));
          } else await withAccount(()=>files.rename(current.envelope));
          await writeFiles(userId,epoch,s=>{const next=s.files[id];if(next){next.uploaded=true;next.uploadEnvelope=undefined;if(next.envelope.metadata.changeId===submitted.metadata.changeId){next.pending=undefined;next.error=undefined;}else next.pending='rename';}});
          const renamed=(await fileState(userId)).files[id];
          if(renamed?.pending==='rename'){
            await withAccount(()=>files.rename(renamed.envelope));
            await writeFiles(userId,epoch,s=>{const next=s.files[id];if(next?.envelope.metadata.changeId===renamed.envelope.metadata.changeId){next.pending=undefined;next.error=undefined;}});
          }
        } catch(error) {
          if(error instanceof RequestError && error.status===410){await writeFiles(userId,epoch,(s,b)=>{delete s.files[id];s.deletions=s.deletions.filter(x=>x!==id);b.delete([userId,id]);});continue;}
          await writeFiles(userId,epoch,s=>{if(s.files[id])s.files[id].error=error instanceof Error?error.message:'Could not transfer file.';});
          if(error instanceof RequestError && error.status===507){continue;}throw error;
        }
      }
      const manifest:FileManifest=await refresh();
      for(const entry of manifest.files){
        const id=entry.envelope.fileId,current=(await fileState(userId)).files[id];if(!current || current.cached)continue;
        const data=await withAccount(()=>files.download(id,entry.bytes));
        await writeFiles(userId,epoch,(s,b)=>{const next=s.files[id];if(next && !s.deletions.includes(id) && sameFile(next.envelope,entry.envelope)){b.put(data,[userId,id]);next.cached=true;}});filesChanged();
      }
    } catch(error){await writeFiles(userId,epoch,s=>{s.error=error instanceof Error?error.message:'File sync failed.';}).catch(()=>{});}
    finally{filesChanged();}
  };
  syncing=(globalThis.navigator?.locks?navigator.locks.request('taskpath-files-sync',run):run()).catch(()=>{filesChanged();}).finally(()=>{syncing=null;});return syncing;
}
