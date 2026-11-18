// Windows Whisper venv integration: the setup helper writes voice-runtime.json
// and voice.mjs must use it instead of PATH discovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { voiceTools, readVoiceRuntimeConfig } from '../src/voice.mjs';

test('voice-runtime.json points transcription at the CUDA venv Whisper and model', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gratis-voice-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const models = join(dir, 'models');
  await mkdir(models, { recursive: true });
  await writeFile(join(models, 'base.en.pt'), '');
  const whisper = join(dir, 'whisper.exe'), ffmpeg = join(dir, 'ffmpeg.exe');
  await writeFile(whisper, '');
  await writeFile(ffmpeg, '');
  const pathAdditions = [join(dir, 'Scripts'), join(dir, 'torch', 'lib')];
  const config = { whisper, ffmpeg, modelDir: models, device: 'cuda', pathAdditions };
  await writeFile(join(dir, 'voice-runtime.json'), JSON.stringify(config));

  assert.deepEqual(await readVoiceRuntimeConfig(dir), config);
  const runtime = await voiceTools('en', {
    platform: 'win32', dataDir: dir,
    hardware: { gpu: { cudaDriverAvailable: true }, inference: { allowCuda: true }, cpu: { threads: 12 } },
  });
  assert.equal(runtime.whisper, whisper);
  assert.equal(runtime.ffmpeg, ffmpeg);
  assert.equal(runtime.modelDir, models);
  assert.equal(runtime.device, 'cuda');
  assert.equal(runtime.fp16, true);
  assert.ok(runtime.env.PATH.startsWith(pathAdditions[0]));
  assert.equal(runtime.env.Path, undefined);
});

test('missing config leaves PATH discovery untouched', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gratis-voice-no-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await readVoiceRuntimeConfig(dir), null);
});
