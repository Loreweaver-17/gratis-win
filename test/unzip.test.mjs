import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateRawSync,crc32} from 'node:zlib';
import {extractZip,listZipEntries} from '../scripts/unzip.mjs';

const LOCAL=0x04034b50,CENTRAL=0x02014b50,EOCD=0x06054b50;

// Builds a ZIP in memory so the extractor is tested without external tools.
function buildZip(files){
 const local=[],central=[];let offset=0;
 for(const {name,content='',mode=0o100644,method=8} of files){
  const data=Buffer.from(content),nameBytes=Buffer.from(name);
  const payload=method===8?deflateRawSync(data):data,checksum=crc32(data);
  const header=Buffer.alloc(30);
  header.writeUInt32LE(LOCAL,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);
  header.writeUInt16LE(method,8);header.writeUInt16LE(0,10);header.writeUInt16LE(0,12);
  header.writeUInt32LE(checksum,14);header.writeUInt32LE(payload.length,18);header.writeUInt32LE(data.length,22);
  header.writeUInt16LE(nameBytes.length,26);header.writeUInt16LE(0,28);
  local.push(header,nameBytes,payload);
  const entry=Buffer.alloc(46);
  entry.writeUInt32LE(CENTRAL,0);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x800,8);
  entry.writeUInt16LE(method,10);entry.writeUInt16LE(0,12);entry.writeUInt16LE(0,14);
  entry.writeUInt32LE(checksum,16);entry.writeUInt32LE(payload.length,20);entry.writeUInt32LE(data.length,24);
  entry.writeUInt16LE(nameBytes.length,28);entry.writeUInt16LE(0,30);entry.writeUInt16LE(0,32);
  entry.writeUInt16LE(0,34);entry.writeUInt16LE(0,36);entry.writeUInt32LE((mode<<16)>>>0,38);entry.writeUInt32LE(offset,42);
  central.push(entry,nameBytes);
  offset+=30+nameBytes.length+payload.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);
 end.writeUInt32LE(EOCD,0);end.writeUInt16LE(0,4);end.writeUInt16LE(0,6);
 end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);
 end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);end.writeUInt16LE(0,20);
 return Buffer.concat([...local,directory,end]);
}

async function withArchive(files,run){
 const directory=await mkdtemp(join(tmpdir(),'gratis-unzip-'));
 try{const archive=join(directory,'fixture.zip');await writeFile(archive,buildZip(files));return await run(archive,join(directory,'out'));}
 finally{await rm(directory,{recursive:true,force:true});}
}

test('extracts stored and deflated entries into nested folders',async()=>{
 await withArchive([
  {name:'composio',content:'#!/bin/sh\n',mode:0o100755},
  {name:'docs/README.txt',content:'nested',method:0},
 ],async(archive,destination)=>{
  assert.equal(await extractZip(archive,destination),2);
  assert.equal(await readFile(join(destination,'composio'),'utf8'),'#!/bin/sh\n');
  assert.equal(await readFile(join(destination,'docs','README.txt'),'utf8'),'nested');
  if(process.platform!=='win32')assert.equal((await stat(join(destination,'composio'))).mode&0o777,0o755);
 });
});

test('rejects path traversal, absolute paths and symbolic links before writing',async()=>{
 for(const files of [
  [{name:'../escape.txt',content:'no'}],
  [{name:'/absolute.txt',content:'no'}],
  [{name:'link',content:'target',mode:0o120777}],
 ]){
  await withArchive(files,async(archive,destination)=>{
   await assert.rejects(extractZip(archive,destination),/Unsafe archive path|symbolic links/);
  });
 }
});

test('rejects archives that are not ZIP files',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'gratis-unzip-'));
 try{
  const archive=join(directory,'bad.zip');await writeFile(archive,'not a zip');
  await assert.rejects(extractZip(archive,join(directory,'out')),/not a valid ZIP/);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('lists entry names for diagnostics',async()=>{
 assert.deepEqual(listZipEntries(buildZip([{name:'a.txt'},{name:'b/c.txt'}])).sort(),['a.txt','b/c.txt']);
});
