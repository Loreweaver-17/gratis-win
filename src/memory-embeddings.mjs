/**
 * AGENT: main-thread bridge to memory-embedding-worker.mjs.
 * Public API used by src/memory-service.mjs: start(), embed(text), close(),
 * plus `status` ('starting'|'ready'|'unavailable'|'closed') and `device`.
 *
 * What changed for Windows/NVIDIA:
 *   - constructor accepts `hardware` (from main.cjs) and passes it to the worker
 *   - worker reports its actual `device` and any fallback `notice` back here
 *   - `onDevice` / `onNotice` let callers surface diagnostics without changing
 *     the existing `onState(status)` contract (memory-service relies on it).
 */
import{Worker}from'node:worker_threads';
export class MemoryEmbeddings{
  constructor({modelPath,hardware,dtype='q8',deviceOverride,onState=()=>{},onDevice=()=>{},onNotice=message=>console.info('[gratis:memory] '+message)}){
    this.modelPath=modelPath;this.hardware=hardware;this.dtype=dtype;this.deviceOverride=deviceOverride;
    this.onState=onState;this.onDevice=onDevice;this.onNotice=onNotice;
    this.pending=new Map();this.sequence=0;this.status='starting';this.device=null;
  }
  // AGENT: workerData is the only config channel — keep it plain/cloneable.
  start(){
    if(this.worker)return;
    this.worker=new Worker(new URL('./memory-embedding-worker.mjs',import.meta.url),{workerData:{modelPath:this.modelPath,hardware:this.hardware,dtype:this.dtype,deviceOverride:this.deviceOverride},execArgv:process.execArgv.filter(a=>!a.startsWith('--input-type'))});
    this.worker.on('message',m=>{
      // AGENT: `ready` now carries the device actually used by the worker.
      if(m.ready&&this.status!=='closed'){this.status='ready';if(m.device){this.device=m.device;this.onDevice(m.device);}this.onState(this.status);}
      if(m.notice)this.onNotice(m.notice);
      if(m.failed){this.status='unavailable';this.onState(this.status);}
      if(m.id){const job=this.pending.get(m.id);if(job){clearTimeout(job.timer);this.pending.delete(m.id);m.error?job.reject(new Error(m.error)):job.resolve(m.vector);}}
    });
    this.worker.on('error',()=>{this.status='unavailable';this.onState(this.status);});
    this.worker.on('exit',()=>{if(this.status!=='closed'){this.status='unavailable';this.onState(this.status);}for(const job of this.pending.values()){clearTimeout(job.timer);job.reject(new Error('Meaning search stopped.'));}this.pending.clear();});
    this.worker.unref();
  }
  embed(text,{timeout=1500}={}){if(this.status!=='ready')return Promise.resolve(null);const id=++this.sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);resolve(null);},timeout);this.pending.set(id,{resolve,reject,timer});this.worker.postMessage({id,text:String(text).slice(0,6000)});});}
  async close(){if(this.closing)return this.closing;this.status='closed';const worker=this.worker;if(!worker||worker.threadId===-1)return;this.closing=new Promise(resolve=>{const timer=setTimeout(()=>{void worker.terminate().then(resolve);},30000);worker.once('exit',()=>{clearTimeout(timer);resolve();});worker.postMessage({close:true});});await this.closing;}
}
