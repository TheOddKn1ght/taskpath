import {test,expect} from 'bun:test';
import {fixture,testUserId,testVault,login,origin} from './auth-helpers';
import {acceptEncrypted} from '../public/offline';
import type {EncryptedRecord,Envelope} from '../public/types';

const envelope = (i:number, extra:Partial<Envelope> = {}):Envelope => ({
  version:1,vaultId:testVault.config.vaultId,taskId:'task-'+i,changeId:'change-'+i,
  editedAt:'2026-01-01T00:00:00.000Z',nonce:Buffer.alloc(12).toString('base64'),
  ciphertext:Buffer.alloc(32).toString('base64'),...extra,
});
const input = (changes:Envelope[]) => ({workspaceKey:testVault.config.vaultId,changes});
test('incremental pages retain edits across pagination, retries, conflicts and stale responses',async()=>{
  const {store}=await fixture();
  try {
    for(let i=0;i<125;i+=25) store.sync(testUserId,input(Array.from({length:25},(_,j)=>envelope(i+j))));
    const first=store.syncBoard(testUserId);
    expect(first.rows).toHaveLength(50);expect(first.hasMore).toBe(true);
    // Move an unread record to the end while another device is paging.
    const updated=envelope(60,{editedAt:'2026-01-02T00:00:00.000Z',changeId:'updated'});
    store.sync(testUserId,input([updated]));
    const local:EncryptedRecord={revision:0,lockEpoch:0,config:testVault.config,board:null,pending:[envelope(999)],offset:0,lastEdit:0};
    const pending=JSON.stringify(local.pending);
    acceptEncrypted(local,first,Date.now(),null);
    let cursor=first.cursor;
    do {
      const page=store.syncBoard(testUserId,cursor);
      acceptEncrypted(local,page,Date.now(),cursor);
      cursor=page.cursor;
    } while(!local.syncComplete);
    expect(local.board!.rows).toHaveLength(125);
    expect(local.board!.rows.find(e=>e.taskId===updated.taskId)).toEqual(updated);
    expect(JSON.stringify(local.pending)).toBe(pending);
    const saved=JSON.stringify(local);
    acceptEncrypted(local,first,Date.now(),null);
    expect(JSON.stringify(local)).toBe(saved);
    expect(store.syncBoard(testUserId,cursor).rows).toEqual([]);
    const retry=store.sync(testUserId,input([updated]));
    expect(retry.changed).toBe(false);
    expect(store.syncBoard(testUserId,cursor).cursor).toBe(cursor);
    const conflict=store.sync(testUserId,input([envelope(60)]));
    expect(conflict.rows).toEqual([updated]);expect(conflict.conflicts).toBe(1);
    expect(()=>store.syncBoard(testUserId,cursor+'x')).toThrow();
    expect(()=>store.syncBoard('other',cursor)).toThrow();
  } finally {store.close();}
});
test('pages respect ciphertext byte bounds and invalid envelopes do not advance local cursors',async()=>{
  const {store}=await fixture();
  try {
    store.sync(testUserId,input(Array.from({length:30},(_,i)=>envelope(i,{ciphertext:Buffer.alloc(65536).toString('base64')}))));
    const page=store.syncBoard(testUserId);
    expect(page.rows.length).toBeLessThan(50);expect(page.hasMore).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(page.rows))).toBeLessThan(1024*1024);
    const record:EncryptedRecord={revision:0,lockEpoch:0,config:testVault.config,board:null,pending:[],offset:0,lastEdit:0};
    const original=JSON.stringify(record);
    expect(()=>acceptEncrypted(record,{...page,rows:[{...page.rows[0],nonce:'bad'}]},Date.now(),null)).toThrow();
    expect(JSON.stringify(record)).toBe(original);
  } finally {store.close();}
});
test('old protocol rejects reads and writes without saving a change',async()=>{
  const {store,handle}=await fixture();
  try {
    const {cookie}=await login(handle);
    for(const method of ['GET','POST']) {
      const response=await handle(new Request(origin+'/api/sync',{method,headers:{cookie,origin,'content-type':'application/json'},body:method==='POST'?JSON.stringify(input([envelope(0)])):undefined}));
      expect(response!.status).toBe(426);
    }
    expect(store.syncBoard(testUserId).rows).toEqual([]);
  } finally {store.close();}
});
