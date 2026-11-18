import test from 'node:test';
import assert from 'node:assert/strict';
import {createSecureStorageAccess} from '../src/secure-storage.mjs';

test('all vaults share one asynchronous unlock and serialize concurrent operations',async()=>{
 let unlocks=0,active=0,maxActive=0;
 const operation=async fn=>{active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,2));active--;return fn();};
 const storage={isAsyncEncryptionAvailable:async()=>{unlocks++;return true;},encryptStringAsync:text=>operation(()=>Buffer.from('v10'+text)),decryptStringAsync:bytes=>operation(()=>({result:bytes.toString().slice(3),shouldReEncrypt:false})),isEncryptionAvailable:()=>assert.fail('legacy probe'),encryptString:()=>assert.fail('legacy provider'),decryptString:()=>assert.fail('legacy provider')};
 const access=createSecureStorageAccess(storage,{platform:'darwin'});
 const encrypted=await Promise.all([access.encrypt('credentials'),access.keyring.wrapKey('memory key'),access.encrypt('pages')]);
 assert.deepEqual(await Promise.all([access.decrypt(encrypted[0]),access.keyring.unwrapKey(encrypted[1]),access.decrypt(encrypted[2])]),['credentials',{value:'memory key',rewrap:false},'pages']);
 assert.equal(unlocks,1);assert.equal(maxActive,1);assert.equal(access.locked,false);
});
test('one denied unlock blocks queued and future vault operations without another OS call',async()=>{
 let unlocks=0,operations=0;const access=createSecureStorageAccess({isAsyncEncryptionAvailable:async()=>{unlocks++;throw Error('Denied');},decryptStringAsync:async()=>operations++,encryptStringAsync:async()=>operations++},{platform:'darwin'});
 const attempts=await Promise.allSettled([access.decrypt(Buffer.from('saved')),access.encrypt('secret'),access.keyring.unwrapKey(Buffer.from('key')),access.keyring.wrapKey('key')]);
 assert.ok(attempts.every(r=>r.status==='rejected'&&r.reason.code==='GRATIS_STORAGE_LOCKED'));await assert.rejects(access.encrypt('later'),/locked/);assert.equal(unlocks,1);assert.equal(operations,0);assert.equal(access.locked,true);
});
test('failure after unlocking also blocks subsequent native operations',async()=>{
 let calls=0;const access=createSecureStorageAccess({isAsyncEncryptionAvailable:async()=>true,decryptStringAsync:async()=>{calls++;throw Error('Cannot decrypt');}},{platform:'darwin'});
 await assert.rejects(access.decrypt(Buffer.from('old')));await assert.rejects(access.decrypt(Buffer.from('old')));assert.equal(calls,1);
});
test('an explicit fresh process can retry and memory preserves key rotation metadata',async()=>{
 let available=false,unlocks=0;const storage={isAsyncEncryptionAvailable:async()=>{unlocks++;return available;},decryptStringAsync:async()=>({result:'key',shouldReEncrypt:true})};
 const first=createSecureStorageAccess(storage);await assert.rejects(first.decrypt(Buffer.from('key')));available=true;await assert.rejects(first.decrypt(Buffer.from('key')));
 const retry=createSecureStorageAccess(storage);assert.deepEqual(await retry.keyring.unwrapKey(Buffer.from('key')),{value:'key',rewrap:true});assert.equal(unlocks,2);
});
test('Linux plaintext fallback is rejected before or after provider initialization',async()=>{
 for(const mode of ['before','after']){let unlocks=0,writes=0;const access=createSecureStorageAccess({getSelectedStorageBackend:()=>mode==='before'||unlocks?'basic_text':'unknown',isAsyncEncryptionAvailable:async()=>{unlocks++;return true;},encryptStringAsync:async()=>writes++},{platform:'linux'});await assert.rejects(access.encrypt('secret'),/locked/);assert.equal(writes,0);}
});
test('Windows DPAPI storage uses the synchronous safeStorage API when async encryption is unavailable',async()=>{
 let writes=0,reads=0;
 const storage={isAsyncEncryptionAvailable:()=>false,isEncryptionAvailable:()=>true,
  encryptString:text=>{writes++;return Buffer.from('dpapi:'+text);},
  decryptString:bytes=>{reads++;return bytes.toString().slice(6);}};
 const access=createSecureStorageAccess(storage,{platform:'win32'});
 const encrypted=await access.encrypt('credential');
 assert.ok(Buffer.isBuffer(encrypted));
 assert.equal(await access.decrypt(encrypted),'credential');
 assert.equal(await access.decrypt(await access.keyring.wrapKey('memory key')),'memory key');
 assert.deepEqual(await access.keyring.unwrapKey(await access.keyring.wrapKey('vault key')),{value:'vault key',rewrap:false});
 assert.equal(writes,3);assert.equal(reads,3);assert.equal(access.locked,false);
});
test('Windows without a usable secure store fails closed instead of writing plaintext',async()=>{
 const access=createSecureStorageAccess({isAsyncEncryptionAvailable:()=>false,isEncryptionAvailable:()=>false},{platform:'win32'});
 await assert.rejects(access.encrypt('secret'),error=>error.code==='GRATIS_STORAGE_LOCKED'&&/Credential Manager/.test(error.message));
 assert.equal(access.locked,true);
});
