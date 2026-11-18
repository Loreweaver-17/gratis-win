// Windows-specific path / executable resolution coverage.
// These use platform injection so they also run on CI hosts that are not Windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  searchPath, executableNames, withExecutableExtension, childEnvironment,
  findExecutable, keyStoreName, isWindows,
} from '../src/platform.mjs';
import { findTool } from '../src/voice.mjs';

test('Windows PATH resolution uses semicolons, case-insensitive Path and PATHEXT', () => {
  assert.deepEqual(searchPath({ Path: 'C:\\Tools;C:\\Bin' }, 'win32'), ['C:\\Tools', 'C:\\Bin']);
  assert.deepEqual(searchPath({ PATH: 'C:\\Tools;C:\\Bin' }, 'win32'), ['C:\\Tools', 'C:\\Bin']);
  assert.ok(executableNames('whisper', 'win32').includes('whisper.exe'));
  assert.equal(withExecutableExtension('C:\\tools\\ffmpeg', 'win32'), 'C:\\tools\\ffmpeg.exe');
  assert.equal(withExecutableExtension('C:\\tools\\ffmpeg.exe', 'win32'), 'C:\\tools\\ffmpeg.exe');
  assert.equal(withExecutableExtension('/usr/bin/ffmpeg', 'linux'), '/usr/bin/ffmpeg');
  assert.equal(keyStoreName('win32'), 'Windows Credential Manager (DPAPI)');
  assert.equal(isWindows, process.platform === 'win32');
});

test('Windows child environment keeps DPAPI variables and drops unrelated secrets', () => {
  const env = childEnvironment({
    Path: 'C:\\Tools', PATHEXT: '.COM;.EXE', USERPROFILE: 'C:\\Users\\QA',
    APPDATA: 'C:\\Users\\QA\\AppData\\Roaming', SystemRoot: 'C:\\Windows',
    ANTHROPIC_API_KEY: 'secret', OPENAI_API_KEY: 'secret',
  }, 'win32');
  assert.equal(env.Path, 'C:\\Tools');
  assert.equal(env.PATHEXT, '.COM;.EXE');
  assert.equal(env.HOME, 'C:\\Users\\QA');
  assert.equal(env.USER, '');
  assert.ok(env.SystemRoot);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test('findExecutable and voice.findTool locate .exe files on a Windows-style PATH', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gratis-win-path-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(dir, { recursive: true, force: true }); });
  await writeFile(join(dir, 'whisper.exe'), '');
  const pathValue = `C:\\missing;${dir}`;
  const priorPath = process.env.Path, priorPATH = process.env.PATH;
  try {
    process.env.Path = pathValue;
    const found = await findExecutable('whisper', { platform: 'win32' });
    assert.match(found || '', /whisper\.exe$/i);
  } finally {
    if (priorPath === undefined) delete process.env.Path; else process.env.Path = priorPath;
    if (priorPATH === undefined) delete process.env.PATH; else process.env.PATH = priorPATH;
  }
  const viaPath = await findTool('whisper', { Path: pathValue, PATHEXT: '.EXE;.CMD' }, 'win32');
  assert.match(viaPath, /whisper\.exe$/i);
});
