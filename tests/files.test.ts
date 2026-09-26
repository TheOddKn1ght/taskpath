import { test } from 'node:test';
import { expect } from '@std/expect';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/db/connection.ts';
import { encryptFile, decryptFile, decryptFileMetadata, renameFile, imageType } from '../public/file-crypto.ts';
import { encodeFile, decodeFile, fileQuota, FILE_MAX } from '../public/file-format.ts';
import { FileRepository } from '../src/db/files.ts';
import { Store } from '../src/store.ts';
import { createHandler } from '../src/server.ts';
import { fixture, login, testVault, testUserId, origin } from './auth-helpers.ts';
import { createVault, replacePassword, derive, unwrapRaw, importVault } from '../public/crypto.ts';
const metadata={name:'PRIVATE_FILE_NAME.txt',type:'text/plain',lastModified:123};
const payload=new TextEncoder().encode('DISTINCTIVE_PRIVATE_FILE_CONTENT');
const make=()=>encryptFile(testVault.key,testUserId,testVault.config.vaultId,payload,metadata);

test('file quota defaults, custom values, zero, and unsafe or malformed settings',()=>{
  expect(fileQuota(undefined)).toBe(10_000_000);expect(fileQuota('0')).toBe(0);expect(fileQuota('25')).toBe(25_000_000);
  for(const value of ['','-1','1.5','1e3',' 10','NaN','Infinity','9007199255'])expect(()=>fileQuota(value)).toThrow();
});
test('file encryption hides metadata, separates records, and authenticates identity and bytes',async()=>{
  const a=await make(),b=await make();expect(a.ciphertext).not.toEqual(b.ciphertext);
  expect(await decryptFile(testVault.key,a.envelope,a.ciphertext)).toEqual(payload);
  expect(await decryptFileMetadata(testVault.key,a.envelope)).toEqual(metadata);
  expect(JSON.stringify(a)).not.toContain(metadata.name);expect(new TextDecoder().decode(a.ciphertext)).not.toContain('DISTINCTIVE');
  for(const field of ['fileId','contentId','vaultId'] as const){const e=structuredClone(a.envelope);e[field]='substituted';await expect(decryptFile(testVault.key,e,a.ciphertext)).rejects.toThrow();}
  const changed=a.ciphertext.slice();changed[0]^=1;await expect(decryptFile(testVault.key,a.envelope,changed)).rejects.toThrow();
  const substituted={...a.envelope,metadata:b.envelope.metadata};await expect(decryptFileMetadata(testVault.key,substituted)).rejects.toThrow();
  const other=await createVault('different password for file tests');await expect(decryptFile(other.key,a.envelope,a.ciphertext)).rejects.toThrow();
  const renamed=await renameFile(testVault.key,a.envelope,'renamed.txt');expect((await decryptFileMetadata(testVault.key,renamed)).name).toBe('renamed.txt');expect(await decryptFile(testVault.key,renamed,a.ciphertext)).toEqual(payload);
  const replaced=await replacePassword('correct horse battery staple','replacement password for files',testVault.config);
  const derived=await derive('replacement password for files',replaced.config.kdf),raw=await unwrapRaw(derived.wrappingKey,replaced.config);
  try{expect(await decryptFile(await importVault(raw),a.envelope,a.ciphertext)).toEqual(payload);}finally{raw.fill(0);}
});
test('bounded binary file frames round trip and reject truncation and oversized headers',async()=>{
  const a=await make(),frame=encodeFile(a.envelope,a.ciphertext);expect(decodeFile(frame,testUserId,testVault.config.vaultId)).toEqual(a);
  expect(()=>decodeFile(frame.slice(0,12),testUserId,testVault.config.vaultId)).toThrow();
  const invalid=frame.slice();new DataView(invalid.buffer).setUint32(0,9000);expect(()=>decodeFile(invalid,testUserId,testVault.config.vaultId)).toThrow();
  expect(()=>decodeFile(frame,'u_'+'2'.repeat(32),testVault.config.vaultId)).toThrow();
  expect(imageType(new TextEncoder().encode('<svg><script>bad</script></svg>'))).toBeNull();
  expect(imageType(new Uint8Array([137,80,78,71,13,10,26,10]))).toBe('image/png');
});
test('quota is atomic, retries are free, renames preserve blobs, and deletion always wins',async()=>{
  const store=new Store();try{
    const files=new FileRepository(store.db,payload.length),a=await make(),b=await make();
    files.upload(a.envelope,a.ciphertext);files.upload(a.envelope,a.ciphertext);
    expect(files.manifest(testUserId,testVault.config.vaultId).usedBytes).toBe(payload.length);
    expect(()=>files.upload(b.envelope,b.ciphertext)).toThrow('Waiting for space');
    const other={...b.envelope,userId:'u_'+'2'.repeat(32)};files.upload(other,b.ciphertext);expect(files.manifest(other.userId,other.vaultId).files).toHaveLength(1);
    const rename=await renameFile(testVault.key,a.envelope,'latest.txt');files.rename(rename);files.rename(a.envelope);files.upload(a.envelope,a.ciphertext);
    expect(files.manifest(testUserId,a.envelope.vaultId).files[0].envelope).toEqual(rename);
    const lowered=new FileRepository(store.db,0);expect(()=>lowered.upload(b.envelope,b.ciphertext)).toThrow();lowered.upload(a.envelope,a.ciphertext);lowered.rename(rename);expect(lowered.content(testUserId,a.envelope.fileId)).toEqual(a.ciphertext);
    lowered.delete(testUserId,a.envelope.fileId);lowered.delete(testUserId,a.envelope.fileId);
    expect(()=>files.upload(a.envelope,a.ciphertext)).toThrow('permanently deleted');expect(()=>files.rename(rename)).toThrow('permanently deleted');
    expect(files.manifest(testUserId,a.envelope.vaultId).usedBytes).toBe(0);files.upload(b.envelope,b.ciphertext);
    const raw=JSON.stringify(store.db.prepare('SELECT * FROM encrypted_files').all());expect(raw).not.toContain(metadata.name);expect(raw).not.toContain('DISTINCTIVE_PRIVATE_FILE_CONTENT');
  }finally{store.close();}
});
test('10 MB single-file boundary and zero-size uploads respect disabled quota and live file count',async()=>{
  const store=new Store();try{
    const e=(await make()).envelope,files=new FileRepository(store.db,FILE_MAX*2);
    files.upload(e,new Uint8Array(FILE_MAX+16));expect(files.manifest(testUserId,e.vaultId).usedBytes).toBe(FILE_MAX);
    expect(()=>files.upload({...e,fileId:crypto.randomUUID()},new Uint8Array(FILE_MAX+17))).toThrow();
    const zero=new FileRepository(store.db,0);expect(()=>zero.upload({...e,fileId:crypto.randomUUID()},new Uint8Array(16))).toThrow();
    const small=new FileRepository(store.db,1);
    for(let i=0;i<1000;i++)small.upload({...e,userId:'u_'+'3'.repeat(32),fileId:String(i)},new Uint8Array(16));
    expect(()=>small.upload({...e,userId:'u_'+'3'.repeat(32),fileId:'overflow'},new Uint8Array(16))).toThrow();
  }finally{store.close();}
});
test('file endpoints require session, Origin and account binding before binary storage',async()=>{
  const {store,auth}=await fixture();try{
    const handle=createHandler(store,auth,origin,undefined,undefined,undefined,payload.length),{cookie}=await login(handle),a=await make();
    const req=(method:string,path:string,body?:BodyInit,overrides:Record<string,string>={})=>handle(new Request(origin+path,{method,headers:{cookie,origin,'x-taskpath-user':testUserId,'content-type':method==='PUT'?'application/octet-stream':'application/json',...overrides},body}));
    expect((await req('PUT','/api/files',encodeFile(a.envelope,a.ciphertext),{cookie:''}))!.status).toBe(401);
    expect((await req('PUT','/api/files',encodeFile(a.envelope,a.ciphertext),{origin:'https://evil.example'}))!.status).toBe(403);
    expect((await req('PUT','/api/files',encodeFile(a.envelope,a.ciphertext),{'x-taskpath-user':'u_'+'2'.repeat(32)}))!.status).toBe(401);
    expect((await req('PUT','/api/files',new Uint8Array(10)))!.status).toBe(400);
    expect((await req('PUT','/api/files',encodeFile(a.envelope,a.ciphertext)))!.status).toBe(200);
    expect((await req('PUT','/api/files',encodeFile(a.envelope,a.ciphertext)))!.status).toBe(200);
    const manifest=await (await req('GET','/api/files'))!.json();expect(manifest.usedBytes).toBe(payload.length);
    const downloaded=(await req('GET','/api/files/'+a.envelope.fileId))!;expect(downloaded.headers.get('cache-control')).toBe('no-store');expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(a.ciphertext);
    const b=await make();expect((await req('PUT','/api/files',encodeFile(b.envelope,b.ciphertext)))!.status).toBe(507);
    expect((await req('DELETE','/api/files/'+a.envelope.fileId,'{}'))!.status).toBe(200);
    expect((await req('PUT','/api/files',encodeFile(a.envelope,a.ciphertext)))!.status).toBe(410);
    expect((await req('GET','/api/files/'+a.envelope.fileId))!.status).toBe(404);
  }finally{store.close();}
});
test('file table migration preserves existing encrypted records and refuses legacy plaintext',()=>{
  const dir=mkdtempSync(join(tmpdir(),'taskpath-files-'));try{
    const path=join(dir,'vault.sqlite'),old=new Store(path);old.db.prepare("INSERT INTO settings VALUES ('sentinel','preserve')").run();old.db.exec('DROP TABLE encrypted_files');old.close();
    const updated=new Store(path);expect(updated.db.prepare("SELECT value FROM settings WHERE key='sentinel'").get()).toEqual({value:'preserve'});expect(updated.db.prepare('SELECT count(*) AS n FROM encrypted_files').get()).toEqual({n:0});updated.close();
    const legacyPath=join(dir,'legacy.sqlite'),legacy=new Database(legacyPath);legacy.exec("CREATE TABLE tasks(title TEXT);INSERT INTO tasks VALUES ('DO NOT DELETE')");legacy.close();expect(()=>new Store(legacyPath)).toThrow();const verify=new Database(legacyPath);expect(verify.prepare('SELECT * FROM tasks').all()).toEqual([{title:'DO NOT DELETE'}]);verify.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
