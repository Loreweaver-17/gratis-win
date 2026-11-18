// AGENT: coverage for the Windows bootstrapper's pure decision layer.
// No installs are executed; child process runners are injected where needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  parseVersion, versionAtLeast, versionWithin, resolveWhisperChoice,
  evaluateChecks, detectPython, parseArgs,
} from '../scripts/setup-win.mjs';

const requirements = JSON.parse(await readFile(new URL('../requirements-windows.json', import.meta.url), 'utf8'));
const flags = { mmx: true, sse42: true, aes: true, avx: true, avx2: true, fma3: true, tsx: false, avx512f: false };
const facts = {
  platform: 'win32', arch: 'x64', nodeVersion: '26.13.1', pythonVersion: 'Python 3.11.9',
  gpuAvailable: true, gpuName: 'NVIDIA GeForce RTX 5070 Ti', cpuFlags: flags, freeGB: 40,
};

test('version parsing honours the documented Node and Python ranges', () => {
  assert.deepEqual(parseVersion('v22.4.1'), { major: 22, minor: 4, patch: 1 });
  assert.equal(versionAtLeast('21.9.0', '22.0.0'), false);
  assert.equal(versionAtLeast('22.0.0', '22.0.0'), true);
  assert.equal(versionWithin('3.10.0', '3.10', '3.12'), true);
  assert.equal(versionWithin('3.12.9', '3.10', '3.12'), true);
  assert.equal(versionWithin('3.13.0', '3.10', '3.12'), false);
  assert.equal(versionWithin('3.9.9', '3.10', '3.12'), false);
});

test('Whisper choice honours flags and never prompts a non-interactive process', () => {
  assert.equal(resolveWhisperChoice({ withWhisper: true }), true);
  assert.equal(resolveWhisperChoice({ noWhisper: true, withWhisper: true }), false);
  assert.equal(resolveWhisperChoice({}), false);
  assert.equal(resolveWhisperChoice({ interactive: true }), null);
});

test('argument parsing covers every documented bootstrap option', () => {
  const options = parseArgs(['--with-whisper', '--model', 'base', '--data-dir', 'C:\\qa', '--skip-deps', '--skip-assets', '--dry-run']);
  assert.equal(options.withWhisper, true);
  assert.equal(options.model, 'base');
  assert.equal(options.dataDir, 'C:\\qa');
  assert.equal(options.skipDeps, true);
  assert.equal(options.skipAssets, true);
  assert.equal(options.dryRun, true);
  assert.throws(() => parseArgs(['--unknown']), /Unknown option/);
});

test('evaluateChecks reflects the requirements manifest', () => {
  const checks = evaluateChecks(requirements, facts);
  assert.equal(checks.find(check => check.id === 'platform').ok, true);
  assert.equal(checks.find(check => check.id === 'gpu').ok, true);
  assert.equal(checks.find(check => check.id === 'cpu-simd').ok, true);
  assert.equal(checks.find(check => check.id === 'disk').ok, true);
  const bad = evaluateChecks(requirements, {
    ...facts, platform: 'linux', arch: 'arm64', nodeVersion: '20.0.0',
    pythonVersion: 'Python 3.13.0', gpuAvailable: false,
    cpuFlags: { ...flags, avx2: false, avx512f: true }, freeGB: 2,
  });
  for (const id of ['platform', 'arch', 'node', 'python', 'gpu', 'cpu-simd', 'disk'])
    assert.equal(bad.find(check => check.id === id).ok, false, id);
});

test('detectPython selects the first usable python launcher', () => {
  const run = (command, args) => command === 'py' && args[0] === '-3.12'
    ? { status: 1, stdout: '', stderr: '' }
    : { status: 0, stdout: 'Python 3.11.9', stderr: '' };
  const found = detectPython('win32', run);
  assert.equal(found.command, 'py');
  assert.deepEqual(found.prefix, ['-3.11']);
  assert.match(found.version, /3\.11\.9/);
  assert.equal(detectPython('win32', () => ({ status: 1, stdout: '', stderr: '' })), null);
});

test('requirements manifest declares exact versions and verification commands', () => {
  assert.equal(requirements.target.platform, 'win32');
  assert.equal(requirements.prerequisites.node.minimumMajor, 22);
  assert.deepEqual(requirements.prerequisites.python.minimumMinor, 10);
  assert.equal(requirements.prerequisites.python.maximumMinor, 12);
  assert.match(requirements.prerequisites.gpu.minimumCudaVersion, /12\.8/);
  assert.deepEqual(requirements.prerequisites.cpu.requiredFlags, ['avx2', 'fma3', 'aes']);
  assert.match(requirements.verification.hardwareAudit, /qa-hardware-audit\.mjs/);
});
