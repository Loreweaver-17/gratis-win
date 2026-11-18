// Downloads the fixed model and Composio CLI assets used by this checkout.
// Everything here runs in Node so `npm run setup:assets` works on Windows 11,
// macOS and Linux without `unzip`, `curl` or a POSIX shell.
import {access,copyFile,mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {extractZip} from './unzip.mjs';
import {withExecutableExtension} from '../src/platform.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const COMPOSIO_RELEASE='https://github.com/ComposioHQ/composio/releases/download/%40composio%2Fcli%400.6.0';
// Composio publishes a ZIP per platform and CPU. The CLI is downloaded, its
// SHA-256 verified, then extracted with the Node.js ZIP reader in ./unzip.mjs.
const COMPOSIO_TARGETS=Object.freeze({
 darwin:{arm64:{arch:'aarch64',sha256:'c785c9ba4564341c78b22b2859cabe862c646bc2b8f8954fa46796b8b721a678'},x64:{arch:'x64',sha256:'4fc736496ffe880315a751179d1c8e8a7ae19650966de314dce1e7fd1241b2d5'}},
 linux:{arm64:{arch:'aarch64',sha256:'95cf45c584c1c1fc56fc5e9cdcf85f22f162bdb2e9f636c47049513b7427d890'},x64:{arch:'x64',sha256:'33354e86255d75c6ce531cc1c326e5211714f9bf98ffcc05186ea770d363aea3'}},
});

async function download(url,file,sha){
 try{if(createHash('sha256').update(await readFile(file)).digest('hex')===sha)return;}catch{}
 const response=await fetch(url,{signal:AbortSignal.timeout(300000)});
 if(!response.ok)throw new Error(`Download failed (${response.status}): ${url}`);
 const data=Buffer.from(await response.arrayBuffer());
 if(createHash('sha256').update(data).digest('hex')!==sha)throw new Error('Download checksum mismatch. No asset installed.');
 await mkdir(path.dirname(file),{recursive:true});
 await writeFile(file+'.part',data,{mode:0o600});
 await rename(file+'.part',file);
}

async function installComposio(){
 const target=COMPOSIO_TARGETS[process.platform]?.[process.arch];
 if(!target){
  console.log(`The Composio browser sign-in helper is not published for ${process.platform} ${process.arch}. Add a Composio project key in Settings → Connections instead.`);
  return;
 }
 const file=`composio-${process.platform}-${target.arch}.zip`;
 const zip=path.join(root,'.cache',file);
 await download(`${COMPOSIO_RELEASE}/${file}`,zip,target.sha256);
 const staging=path.join(root,'.cache','composio-'+randomUUID());
 await mkdir(staging,{recursive:true});
 try{
  await extractZip(zip,staging);
  let binary=null;
  for(const candidate of [path.join(staging,'composio'),path.join(staging,'bin','composio')].map(withExecutableExtension)){
   try{await access(candidate);binary=candidate;break;}catch{}
  }
  if(!binary)throw new Error('The Composio CLI archive did not include the expected command.');
  const destination=path.join(root,'assets','composio-cli');
  await rm(destination,{recursive:true,force:true});
  await rename(staging,destination);
  console.log('Verified Composio CLI installed.');
 }finally{await rm(staging,{recursive:true,force:true});}
}

const manifest=JSON.parse(await readFile(path.join(root,'assets/models/manifest.json')));
for(const file of manifest.files){
 await download(`https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/${manifest.revision}/${file.path}`,path.join(root,'assets/models/sentence-encoder',file.path),file.sha256);
 console.log('Verified model asset:',file.path);
}
for(const name of ['LICENSE','NOTICE'])await copyFile(path.join(root,'licenses','sentence-encoder-'+name),path.join(root,'assets/models/sentence-encoder',name));
await installComposio();
