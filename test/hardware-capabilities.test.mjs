/**
 * AGENT: coverage map for the Windows/NVIDIA runtime work.
 *   - CPU override + AVX-512 lockout      -> parseCpuFlagOverride / detectHardware
 *   - GPU VRAM parsing + device choice    -> parseNvidiaSmi / detectHardware / log
 *   - CPU fallback + native build flags   -> deviceCandidates / nativeBuildProfile
 *   - Whisper device + CLI args           -> resolveWhisperDevice / whisperInvocation
 *   - Windows PATH/PATHEXT discovery      -> findTool
 * All probes are injected (no real nvidia-smi / PowerShell needed).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectHardware, deviceCandidates, logHardwareCapabilities, parseCpuFlagOverride,
  parseNvidiaSmi,
} from '../src/hardware-capabilities.mjs';
import { resolveWhisperDevice, whisperInvocation, findTool } from '../src/voice.mjs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const noRun = async () => { throw new Error('unavailable'); };
const probe = async () => ({ mmx: true, sse42: true, aes: true, avx: true, avx2: true, fma3: true, tsx: true, avx512f: true });
const base = { platform: 'win32', arch: 'x64', run: noRun, probeCpu: probe, probeOrt: async () => false, probeDml: async () => false };

test('CPU flags honour overrides and never enable AVX-512', async () => {
  const caps = await detectHardware({ ...base, env: { GRATIS_CPU_FLAGS: '+AVX2,+FMA3,+AES,-TSX,AVX512F' } });
  assert.equal(caps.cpu.flags.avx2, true);
  assert.equal(caps.cpu.flags.fma3, true);
  assert.equal(caps.cpu.flags.aes, true);
  assert.equal(caps.cpu.flags.tsx, false);
  assert.equal(caps.cpu.flags.avx512f, false);
  assert.equal(caps.cpu.source, 'override');
  assert.deepEqual(parseCpuFlagOverride('-AVX2,+AES'), { avx2: false, aes: true });
});

test('GPU VRAM and CUDA availability drive device preference', async () => {
  const run = async command => {
    if (command === 'nvidia-smi') return { stdout: '0, NVIDIA RTX 5070 Ti, 16384, 15000, 1384, 572.16\n' };
    throw new Error('unavailable');
  };
  const caps = await detectHardware({ ...base, env: { GRATIS_CUDA_AVAILABLE: '1' }, run });
  assert.equal(caps.gpu.name, 'NVIDIA RTX 5070 Ti');
  assert.equal(caps.gpu.vramTotalMB, 16384);
  assert.equal(caps.gpu.vramFreeMB, 15000);
  assert.equal(caps.gpu.driverVersion, '572.16');
  assert.equal(caps.gpu.cudaForInference, true);
  assert.equal(caps.inference.preferredDevice, 'cuda');
  assert.deepEqual(deviceCandidates(caps), ['cuda', 'cpu']);
  const lines = [];
  logHardwareCapabilities(caps, line => lines.push(line));
  assert.match(lines.join('\n'), /VRAM 15000\/16384 MB free/);
  assert.match(lines.join('\n'), /AVX2\+FMA3/);
  assert.match(lines.join('\n'), /AVX-512 disabled/);
  assert.deepEqual(parseNvidiaSmi('1, GPU, 8192, 7000, 1192, 1.2'), [{ index: 1, name: 'GPU', vramTotalMB: 8192, vramFreeMB: 7000, vramUsedMB: 1192, driverVersion: '1.2' }]);
});

test('Windows selects DirectML for the RTX 5070 Ti and logs it', async () => {
  const run = async command => {
    if (command === 'nvidia-smi') return { stdout: '0, NVIDIA GeForce RTX 5070 Ti, 16384, 15000, 1384, 572.16\n' };
    throw new Error('unavailable');
  };
  const caps = await detectHardware({ ...base, env: {}, run, probeDml: async () => true });
  assert.equal(caps.inference.preferredDevice, 'dml');
  assert.equal(caps.inference.ortDirectMLAvailable, true);
  assert.equal(caps.native.directml.enabled, true);
  assert.deepEqual(deviceCandidates(caps), ['dml', 'cpu']);
  const lines = [];
  logHardwareCapabilities(caps, line => lines.push(line));
  assert.match(lines.join('\n'), /DirectML \(NVIDIA GeForce RTX 5070 Ti\) active/);
  assert.match(lines.join('\n'), /inference dml preferred, CPU fallback/);
  const forced = await detectHardware({ ...base, env: { GRATIS_INFERENCE_DEVICE: 'dml' }, run });
  assert.deepEqual(deviceCandidates(forced), ['dml', 'cpu']);
});

test('missing CUDA falls back to AVX2 CPU with safe native flags', async () => {
  const caps = await detectHardware({ ...base, env: {} });
  assert.equal(caps.inference.preferredDevice, 'cpu');
  assert.deepEqual(deviceCandidates(caps), ['cpu']);
  assert.ok(caps.native.flags.includes('/arch:AVX2'));
  assert.ok(caps.native.flags.some(flag => flag.includes('NO_AVX512')));
  assert.equal(caps.native.cpu.avx2, true);
  assert.equal(caps.native.cpu.fma3, true);
  assert.equal(caps.native.cpu.aesNi, true);
  assert.equal(caps.native.cpu.avx512, false);
});

test('whisper device selection and args follow the detected GPU', () => {
  assert.equal(resolveWhisperDevice({ gpu: { cudaForInference: true }, inference: { allowCuda: true } }), 'cuda');
  assert.equal(resolveWhisperDevice({ gpu: { cudaDriverAvailable: true, cudaForInference: false } }), 'cuda');
  assert.equal(resolveWhisperDevice({ gpu: { cudaForInference: false } }), 'cpu');
  assert.equal(resolveWhisperDevice({ gpu: { cudaForInference: true } }, 'cpu'), 'cpu');
  const runtime = { whisper: 'whisper.exe', model: 'base.en', modelDir: 'models', device: 'cuda', threads: 6, fp16: true };
  const { args } = whisperInvocation({ runtime, wav: 'speech.wav', directory: 'tmp', language: 'en' });
  assert.deepEqual(args.slice(args.indexOf('--device'), args.indexOf('--device') + 2), ['--device', 'cuda']);
  assert.deepEqual(args.slice(args.indexOf('--fp16'), args.indexOf('--fp16') + 2), ['--fp16', 'True']);
  assert.ok(args.includes('6'));
});

test('Windows tool discovery uses PATH delimiter and PATHEXT', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gratis-tools-'));
  t.after(async () => { await import('node:fs/promises').then(fs => fs.rm(directory, { recursive: true, force: true })); });
  await writeFile(join(directory, 'whisper.exe'), '');
  const path = await findTool('whisper', { PATH: `/ignored;${directory}`, PATHEXT: '.EXE;.CMD' }, 'win32');
  assert.match(path, /whisper\.exe$/i);
});
