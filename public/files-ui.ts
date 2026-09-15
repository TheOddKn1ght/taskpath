import { addFile, listFiles, readStoredFile, renameStoredFile, deleteStoredFile, fileStatus, syncFiles } from './file-client.js';
import { isUnlocked } from './offline.js';
const root=document.getElementById('files-view')!;
let visible=false, generation=0, renderId=0, query='', busy=false;
const urls=new Set<string>();
const text=(tag:string,value:string,className='')=>{const el=document.createElement(tag);el.textContent=value;el.className=className;return el;};
const button=(label:string,action:()=>void,className='secondary-button')=>{const el=document.createElement('button');el.type='button';el.textContent=label;el.className=className;el.addEventListener('click',action);return el;};
const size=(bytes:number)=>bytes>=1_000_000?`${(bytes/1_000_000).toLocaleString('en',{maximumFractionDigits:2})} MB`:`${bytes.toLocaleString('en')} bytes`;
const heading=text('header','','files-heading'), title=text('div',''),usage=text('p','Connecting…','files-usage');title.append(text('h2','Files'),usage);
const picker=document.createElement('input');picker.type='file';picker.multiple=true;picker.hidden=true;
const upload=button('Upload files',()=>picker.click(),'primary-button');heading.append(title,upload,picker);
const search=document.createElement('input');search.type='search';search.placeholder='Search filenames';search.setAttribute('aria-label','Search files');search.addEventListener('input',()=>{query=search.value;void render();});
const status=text('p','','files-status');status.setAttribute('role','status');
const list=text('div','','files-list');root.append(heading,search,status,list);
function clearURLs(){for(const url of urls)URL.revokeObjectURL(url);urls.clear();}
const preview=document.createElement('dialog');preview.className='file-preview';preview.setAttribute('aria-label','Image preview');document.body.append(preview);
preview.addEventListener('close',()=>{preview.replaceChildren();clearURLs();});
const edit=document.createElement('dialog');edit.className='file-action-dialog';document.body.append(edit);
function ask(title:string,message:string,value?:string):Promise<string|null> {
  edit.replaceChildren();edit.setAttribute('aria-label',title);edit.append(text('h2',title),text('p',message));
  const input=document.createElement('input');input.value=value || '';input.maxLength=255;input.setAttribute('aria-label','Filename');
  if(value!==undefined)edit.append(input);
  let result:string|null=null;
  const actions=text('div','','dialog-actions');actions.append(button('Cancel',()=>edit.close()),button(value===undefined?'Delete permanently':'Save',()=>{result=value===undefined?'delete':input.value;edit.close();},'primary-button'));edit.append(actions);edit.showModal();
  if(value!==undefined)input.focus();
  return new Promise(resolve=>edit.addEventListener('close',()=>{edit.replaceChildren();resolve(result);},{once:true}));
}
async function action(work:()=>Promise<void>) {const current=generation;if(busy)return;busy=true;upload.disabled=true;try{await work();}catch(error){if(current===generation && isUnlocked())status.textContent=error instanceof Error?error.message:'File operation failed.';}finally{if(current===generation){busy=false;upload.disabled=false;}}}
async function openFile(id:string,view:boolean) {
  const started=generation, file=await readStoredFile(id);
  try {
    if(started!==generation || !isUnlocked())return;
    if(view && !file.imageType)throw new Error('This file format is download-only.');
    if(view){preview.replaceChildren();clearURLs();}
    const url=URL.createObjectURL(new Blob([file.bytes],{type:view?file.imageType!:'application/octet-stream'}));urls.add(url);
    if(view){
      const img=document.createElement('img');img.alt=file.details.name;img.src=url;
      img.onerror=()=>{img.replaceWith(text('p','This image cannot be displayed. You can still download the original file.'));};
      preview.replaceChildren(text('h2',file.details.name),button('Close',()=>preview.close(),'icon-button file-preview-close'),img);if(!preview.open)preview.showModal();
    } else {const a=document.createElement('a');a.href=url;a.download=file.details.name;document.body.append(a);a.click();a.remove();setTimeout(()=>{URL.revokeObjectURL(url);urls.delete(url);},30000);}
  } finally {file.bytes.fill(0);}
}
async function render() {
  const token=++renderId,started=generation;if(!visible || !isUnlocked())return;
  try {
    const result=await listFiles();if(token!==renderId || started!==generation || !visible || !isUnlocked())return;
    const used=result.files.reduce((sum,file)=>sum+file.bytes,0);
    usage.textContent=result.quota?`${size(used)} on this device · ${size(result.quota.usedBytes)} / ${size(result.quota.quotaBytes)} synced${result.quota.usedBytes>result.quota.quotaBytes?' · Over quota':''}`:'Connect once to refresh the storage allowance. Default: 10 MB.';
    status.textContent=result.error || (result.deletions.length?`${result.deletions.length} deletion(s) waiting to sync`:'Files are encrypted before leaving this device.');
    const focus=document.activeElement as HTMLElement|null,focusId=focus?.dataset.fileId,focusAction=focus?.dataset.fileAction;
    list.replaceChildren();
    const filtered=result.files.filter(file=>file.details.name.normalize('NFC').toLocaleLowerCase().includes(query.normalize('NFC').toLocaleLowerCase())).sort((a,b)=>b.envelope.createdAt.localeCompare(a.envelope.createdAt)||a.envelope.fileId.localeCompare(b.envelope.fileId));
    for(const file of filtered){
      const id=file.envelope.fileId,row=text('article','','file-row'),info=text('div','','file-info');
      info.append(text('h3',file.details.name),text('p',`${size(file.bytes)} · ${new Date(file.envelope.createdAt).toLocaleDateString('en')} · ${fileStatus(file)}`));
      const actions=text('div','','file-actions');
      const add=(label:string,fn:()=>Promise<void>,disabled=false)=>{const b=button(label,()=>void action(fn));b.disabled=disabled;b.dataset.fileId=id;b.dataset.fileAction=label;actions.append(b);};
      add('Download',()=>openFile(id,false),!file.cached || 'unreadable' in file);
      if(['image/png','image/jpeg','image/webp','image/gif'].includes(file.details.type))add('Preview',()=>openFile(id,true),!file.cached || 'unreadable' in file);
      add('Rename',async()=>{const name=await ask('Rename file','Choose a filename.',file.details.name);if(name!==null)await renameStoredFile(id,name);},'unreadable' in file);
      add(file.pending==='upload'?'Discard':'Delete',async()=>{if(await ask('Delete file',`Permanently delete “${file.details.name}”? This cannot be undone.`))await deleteStoredFile(id);});
      row.append(info,actions);list.append(row);
    }
    if(!filtered.length)list.append(text('p',query?'No matching files.':'Drop files here or choose Upload files.','files-empty'));
    for(const b of list.querySelectorAll<HTMLElement>('button'))if(b.dataset.fileId===focusId && b.dataset.fileAction===focusAction)b.focus({preventScroll:true});
  } catch(error){if(started===generation && visible && isUnlocked())status.textContent=error instanceof Error?error.message:'Could not open files.';}
}
async function uploadFiles(files:File[]) {const started=generation;await action(async()=>{for(const file of files){if(started!==generation || !isUnlocked())return;await addFile(file);}await render();});}
picker.addEventListener('change',()=>{const files=Array.from(picker.files || []);picker.value='';void uploadFiles(files);});
root.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files')){event.preventDefault();root.classList.add('files-dragover');}});
root.addEventListener('dragleave',()=>root.classList.remove('files-dragover'));
root.addEventListener('drop',event=>{event.preventDefault();root.classList.remove('files-dragover');void uploadFiles(Array.from(event.dataTransfer?.files || []));});
heading.append(button('Retry sync',()=>void syncFiles()));
window.addEventListener('taskpath-files',()=>void render());
window.addEventListener('taskpath-locked',()=>{generation++;renderId++;busy=false;visible=false;query='';search.value='';picker.value='';upload.disabled=false;list.replaceChildren();usage.textContent='';status.textContent='';root.hidden=true;document.body.classList.remove('files-view');if(preview.open)preview.close();if(edit.open)edit.close();preview.replaceChildren();edit.replaceChildren();clearURLs();});
export function showFiles(show:boolean) {visible=show;root.hidden=!show;document.body.classList.toggle('files-view',show);if(show)void render();}
