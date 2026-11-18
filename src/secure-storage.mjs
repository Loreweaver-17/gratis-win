// One lazily initialized Electron encryptor serves every vault. Serializing
// access prevents separate startup features from requesting a second unlock.
// macOS is the only platform with the asynchronous safeStorage API, which can
// prompt for Keychain access. Windows (DPAPI / Credential Manager) and Linux
// expose the synchronous API only, so both paths are supported here.
import { keyStoreName } from './platform.mjs';

export function createSecureStorageAccess(storage,{platform=process.platform}={}){
 let locked=false,initialized=false,mode=null,tail=Promise.resolve();
 const error=()=>Object.assign(new Error(`Secure storage is locked. Unlock ${keyStoreName(platform)} and choose Try again.`),{code:'GRATIS_STORAGE_LOCKED'});
 const basic=()=>platform==='linux'&&storage.getSelectedStorageBackend?.()==='basic_text';
 const hasAsyncProbe=()=>typeof storage.isAsyncEncryptionAvailable==='function';
 const hasAsyncEncrypt=()=>typeof storage.encryptStringAsync==='function';
 const hasAsyncDecrypt=()=>typeof storage.decryptStringAsync==='function';
 const hasSync=()=>typeof storage.isEncryptionAvailable==='function'&&typeof storage.encryptString==='function'&&typeof storage.decryptString==='function';
 const unlock=async()=>{
  if(hasAsyncProbe()&&await storage.isAsyncEncryptionAvailable()){
   if(basic())throw error();
   return 'async';
  }
  if(basic())throw error();
  if(!hasSync()||!storage.isEncryptionAvailable())throw error();
  return 'sync';
 };
 const access=operation=>{
  const task=tail.then(async()=>{
   if(locked)throw error();
   try{
    if(!initialized){mode=await unlock();initialized=true;}
    return await operation(mode);
   }catch{locked=true;throw error();}
  });
  tail=task.catch(()=>{});return task;
 };
 const encrypt=text=>access(async selected=>{
  if(selected==='async'&&hasAsyncEncrypt())return storage.encryptStringAsync(text);
  if(typeof storage.encryptString==='function')return Buffer.from(storage.encryptString(text));
  throw error();
 });
 const unpack=value=>typeof value==='string'?value:value.result;
 const decrypt=bytes=>access(async selected=>{
  if(selected==='async'&&hasAsyncDecrypt())return unpack(await storage.decryptStringAsync(bytes));
  if(typeof storage.decryptString==='function')return storage.decryptString(bytes);
  throw error();
 });
 const unwrapKey=bytes=>access(async selected=>{
  if(selected==='sync'||!hasAsyncDecrypt())return {value:storage.decryptString(bytes),rewrap:false};
  const result=await storage.decryptStringAsync(bytes);return typeof result==='string'?result:{value:result.result,rewrap:!!result.shouldReEncrypt};
 });
 return{encrypt,decrypt,get locked(){return locked;},keyring:{wrapKey:encrypt,unwrapKey}};
}
