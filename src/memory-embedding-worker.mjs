/**
 * AGENT: semantic-memory inference worker (Transformers.js / ONNX Runtime).
 * Role: loads the local quantized MiniLM encoder and answers embed requests
 * from the main thread through `parentPort`.
 *
 * Device policy — DO NOT hardcode 'cpu' again:
 *   1. deviceCandidates() returns ['cuda','cpu'] when CUDA is preferred.
 *   2. Each candidate is tried in order; a failure falls through to the next.
 *   3. The chosen device and any fallback notice are posted to the parent.
 * Why: CPU was previously hardcoded, ignoring the RTX 5070 Ti. CUDA is now
 * prioritised but guarded, because a missing native provider can abort Node.
 * Model stays `q8` (the only checksum-verified local ONNX asset available).
 */
import {parentPort,workerData} from 'node:worker_threads';
import {availableParallelism} from 'node:os';
import {deviceCandidates} from './hardware-capabilities.mjs';
try{
  const {env,pipeline}=await import('@huggingface/transformers');
  env.allowRemoteModels=false;env.allowLocalModels=true;env.useBrowserCache=false;env.useFSCache=false;
  // AGENT: `hardware` comes from main.cjs via MemoryEmbeddings (structured
  // clone). `deviceOverride` is an optional explicit 'cuda'/'cpu' escape hatch.
  const hardware=workerData.hardware;
  const candidates=deviceCandidates(hardware,workerData.deviceOverride);
  const threads=Math.max(1,Math.min(4,(hardware?.cpu?.threads||availableParallelism()||2)-1));
  // AGENT: thread count follows the detected CPU parallelism but stays <= 4
  // so the worker does not starve the renderer / voice transcription.
  let encoder,device,cudaFailed=false;
  for(const candidate of candidates){
    try{
      encoder=await pipeline('feature-extraction',workerData.modelPath,{
        dtype:workerData.dtype||'q8',device:candidate,
        session_options:{intraOpNumThreads:threads,interOpNumThreads:1,executionMode:'sequential',logSeverityLevel:3},
      });
      device=candidate;
      break;
    }catch(error){
      if(candidate==='cuda')cudaFailed=true;
    }
  }
  // AGENT: if every device fails, post `failed` so the parent marks embeddings
  // unavailable; memory search then works without semantic vectors.
  if(!encoder)throw new Error('Meaning search is unavailable.');
  parentPort.postMessage({ready:true,device,dtype:workerData.dtype||'q8'});
  if(device==='cpu'&&cudaFailed)parentPort.postMessage({notice:'CUDA unavailable; using AVX2 CPU inference.'});
  let queue=Promise.resolve(),closing=false;
  parentPort.on('message',message=>{
    if(message.close){closing=true;queue=queue.finally(async()=>{await encoder.dispose();parentPort.close();});return;}
    if(closing)return;
    const{id,text}=message;
    // Native inference finishes before the session is disposed or the worker exits.
    queue=queue.then(async()=>{try{const tensor=await encoder(text,{pooling:'mean',normalize:true});parentPort.postMessage({id,vector:Array.from(tensor.data)});}catch{parentPort.postMessage({id,error:'Meaning search could not process this text.'});}});
  });
}catch{parentPort.postMessage({failed:true});parentPort.close();}
