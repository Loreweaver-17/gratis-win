import test from 'node:test';
import assert from 'node:assert/strict';
import {childEnvironment,executableNames,findExecutable,searchPath,withExecutableExtension,keyStoreName} from '../src/platform.mjs';

test('Windows executable names follow PATHEXT and keep the bare name',()=>{
 const names=executableNames('composio','win32');
 assert.equal(names[0],'composio');
 assert.ok(names.includes('composio.exe'));
 assert.deepEqual(executableNames('composio','darwin'),['composio']);
 assert.equal(withExecutableExtension('/opt/homebrew/bin/t3','darwin'),'/opt/homebrew/bin/t3');
 assert.equal(withExecutableExtension('C:\\tools\\t3','win32'),'C:\\tools\\t3.exe');
 assert.equal(withExecutableExtension('C:\\tools\\t3.exe','win32'),'C:\\tools\\t3.exe');
});

test('PATH parsing uses the platform delimiter instead of pushing every drive into one entry',()=>{
 assert.deepEqual(searchPath({PATH:'C:\\Windows;C:\\Tools'},'win32'),['C:\\Windows','C:\\Tools']);
 assert.deepEqual(searchPath({Path:'C:\\Windows;C:\\Tools',PATH:'ignored'},'win32'),['C:\\Windows','C:\\Tools']);
 assert.deepEqual(searchPath({PATH:'/usr/bin:/bin'},'darwin'),['/usr/bin','/bin']);
});

test('child environment keeps Windows variable names and adds POSIX aliases for Node CLIs',()=>{
 const source={Path:'C:\\Windows',PATHEXT:'.EXE;.CMD',USERPROFILE:'C:\\Users\\Ada',USERNAME:'Ada',TEMP:'C:\\Temp',SystemRoot:'C:\\Windows',HOME:'/stale',API_TOKEN:'secret'};
 const env=childEnvironment(source,'win32');
 assert.equal(env.Path,'C:\\Windows');
 assert.equal(env.HOME,'/stale');
 assert.equal(env.USER,'Ada');
 assert.equal(env.TMPDIR,'C:\\Temp');
 assert.equal(env.API_TOKEN,undefined);
 assert.equal(childEnvironment({USERPROFILE:'C:\\Users\\Ada'},'win32').HOME,'C:\\Users\\Ada');
});

test('POSIX child environment is unchanged and drops unrelated secrets',()=>{
 const env=childEnvironment({HOME:'/home/ada',USER:'ada',PATH:'/usr/bin',LANG:'en_GB.UTF-8',COMPOSIO_CACHE_DIR:'/tmp/x'},'darwin');
 assert.deepEqual(env,{HOME:'/home/ada',USER:'ada',PATH:'/usr/bin',LANG:'en_GB.UTF-8'});
 assert.equal(keyStoreName('win32'),'Windows Credential Manager (DPAPI)');
 assert.equal(keyStoreName('darwin'),'your macOS keychain');
});

test('findExecutable resolves an absolute executable from PATH',async()=>{
 const found=await findExecutable(process.platform==='win32'?'cmd':'node');
 assert.ok(found,`expected ${process.platform==='win32'?'cmd.exe':'node'} on PATH`);
 assert.ok(found.toLowerCase().includes(process.platform==='win32'?'cmd':'node'));
 assert.equal(await findExecutable('definitely-not-a-real-executable-xyz'),null);
});
