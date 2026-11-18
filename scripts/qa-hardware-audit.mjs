// Pre-launch hardware & instruction-set audit for the Windows 11 x64 port.
//
// WHAT IT CHECKS
//   1. CPU SIMD flags / GPU VRAM / CUDA runtime (via src/hardware-capabilities.mjs)
//   2. SIGILL under load: several child processes run real ONNX Runtime AVX2/FMA3
//      inference loops. Illegal instructions kill a child with a native status
//      code, so we inspect every exit status instead of trying to catch SIGILL.
//   3. VRAM: nvidia-smi is sampled while inference runs; a CUDA/EPT pipeline must
//      raise "memory.used" and appear in --query-compute-apps.
//   4. Whisper CLI availability and whether it can report a CUDA device.
//
// Run: node scripts/qa-hardware-audit.mjs [--iterations N] [--children N]
// Output: qa-hardware-audit.json (machine-readable) plus console summary.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { detectHardware, hardwareSummary, logHardwareCapabilities, deviceCandidates } from '../src/hardware-capabilities.mjs';
import { findExecutable } from '../src/platform.mjs';
import { readVoiceRuntimeConfig } from '../src/voice.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const value = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback; };
const iterations = value('--iterations', 12);
const childrenCount = value('--children', 3);

async function nvidia(query) {
  try {
    const { stdout } = await exec('nvidia-smi', query, { timeout: 5000, windowsHide: true, maxBuffer: 65536 });
    return stdout.trim();
  } catch (error) { return null; }
}

// One query returns both dedicated memory and SM utilization so a GPU kernel
// that does not allocate memory can still be detected.
async function gpuSample() {
  const out = await nvidia(['--query-gpu=memory.used,utilization.gpu', '--format=csv,noheader,nounits']);
  if (!out) return null;
  const first = out.split(/\r?\n/)[0].split(',').map(value => parseFloat(value.trim()));
  return { memoryMB: Number.isFinite(first[0]) ? first[0] : null, utilization: Number.isFinite(first[1]) ? first[1] : null };
}

async function vramUsedMB() { return (await gpuSample())?.memoryMB ?? null; }

async function computeApps() {
  return nvidia(['--query-compute-apps=pid,process_name,used_gpu_memory', '--format=csv,noheader']);
}

function runChild(modelPath, device) {
  const code = [
    "import { pipeline, env } from '@huggingface/transformers';",
    'env.allowRemoteModels=false; env.allowLocalModels=true; env.useBrowserCache=false; env.useFSCache=false;',
    "const pipe = await pipeline('feature-extraction', process.argv[1], { device: process.argv[2], dtype: 'q8', session_options: { intraOpNumThreads: 2, interOpNumThreads: 1, logSeverityLevel: 3 } });",
    `for (let i = 0; i < ${iterations}; i++) { const tensor = await pipe('QA AVX2/FMA3 load iteration ' + i, { pooling: 'mean', normalize: true }); if (!tensor?.data?.length) throw new Error('empty tensor at iteration ' + i); }`,
    'await pipe.dispose(); console.log("CHILD_OK");',
  ].join('\n');
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, modelPath, device],
      { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ ok: false, code: null, signal: null, spawnError: error.stack, stdout, stderr }));
    child.on('close', (code, signal) => resolve({
      ok: code === 0 && stdout.includes('CHILD_OK'), code, signal,
      spawnError: null, stdout: stdout.slice(-2000), stderr: stderr.slice(-4000),
    }));
  });
}

const report = { startedAt: new Date().toISOString(), hardware: null, sigill: null, vram: null, whisper: null, verdict: 'PASS' };
try {
  const hardware = await detectHardware();
  report.hardware = hardwareSummary(hardware);
  logHardwareCapabilities(hardware);
  console.log('[audit] CPU AVX2/FMA3 attempted; AVX-512 disabled:', hardware.native.flags.join(' '));

  const modelPath = join(root, 'assets', 'models', 'sentence-encoder') + (process.platform === 'win32' ? '\\' : '/');
  const baseline = await vramUsedMB();
  let sampling = true;
  const samples = [], utilizations = [];
  const sampler = (async () => {
    while (sampling) {
      const sample = await gpuSample();
      if (sample?.memoryMB !== null && sample?.memoryMB !== undefined) samples.push(sample.memoryMB);
      if (sample?.utilization !== null && sample?.utilization !== undefined) utilizations.push(sample.utilization);
      await delay(300);
    }
  })();

  // Use the exact same order as the production embedding worker. On Windows
  // this is ['dml','cpu']; the CPU leg still exercises AVX2/FMA3 for SIGILL.
  const candidates = deviceCandidates(hardware);
  const deviceAttempts = [], successfulDevices = [];
  const runs = [];
  for (let i = 0; i < childrenCount; i++) {
    let result;
    for (const candidate of candidates) {
      result = await runChild(modelPath, candidate);
      deviceAttempts.push({ child: i, device: candidate, ok: result.ok, code: result.code });
      if (result.ok) { successfulDevices.push(candidate); break; }
    }
    runs.push(result);
  }
  sampling = false;
  await sampler;

  // Windows reports native faults as large 0xC0000000-family exit codes;
  // 0xC000001D is STATUS_ILLEGAL_INSTRUCTION (SIGILL equivalent).
  const illegalInstruction = value => Number(value) === 0xC000001D || value === 'SIGILL';
  const failures = runs.filter(run => !run.ok);
  report.sigill = {
    passed: failures.length === 0 && !deviceAttempts.some(a => illegalInstruction(a.code) || illegalInstruction(a.signal)),
    children: childrenCount, iterationsPerChild: iterations, preferred: hardware.inference.preferredDevice,
    deviceAttempts,
    illegalInstructions: deviceAttempts.filter(a => illegalInstruction(a.code) || illegalInstruction(a.signal)),
    failures: failures.map(f => ({ code: f.code, signal: f.signal, spawnError: f.spawnError, stderr: f.stderr })),
  };
  const device = successfulDevices[0] || preferred;
  const peak = samples.length ? Math.max(...samples) : null;
  const peakUtilization = utilizations.length ? Math.max(...utilizations) : null;
  report.vram = {
    baselineMB: baseline, peakMB: peak, deltaMB: baseline !== null && peak !== null ? peak - baseline : null,
    peakUtilizationPercent: peakUtilization,
    computeApps: await computeApps(), samples: samples.length,
    device,
  };

  const dataDir = process.env.GRATIS_DATA_DIR || (process.env.APPDATA ? join(process.env.APPDATA, 'Gratis Core', 'data') : join(root, 'data'));
  const voiceConfig = await readVoiceRuntimeConfig(dataDir);
  const whisper = voiceConfig?.whisper || await findExecutable('whisper');
  let cudaAvailable = null, cudaDevice = null;
  if (voiceConfig?.python) {
    try {
      const { stdout } = await exec(voiceConfig.python, ['-c', 'import torch; print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else "none")'], { timeout: 120000, windowsHide: true });
      const lines = stdout.trim().split(/\r?\n/);
      cudaAvailable = lines[0]?.trim() === 'True'; cudaDevice = lines[1]?.trim() || null;
    } catch (error) { cudaDevice = String(error.message).slice(0, 500); }
  }
  report.whisper = {
    found: Boolean(whisper), path: whisper, configured: Boolean(voiceConfig?.whisper),
    device: voiceConfig?.device || null, cudaAvailable, cudaDevice,
  };
  if (whisper) {
    try {
      const { stdout } = await exec(whisper, ['--version'], { timeout: 15000, windowsHide: true });
      report.whisper.versionOutput = stdout.slice(0, 500);
    } catch (error) { report.whisper.versionError = String(error.stack || error).slice(0, 2000); }
  }

  const gpuActive = device === 'dml' || device === 'cuda';
  const usedGpu = (report.vram.deltaMB ?? 0) > 0 || (report.vram.peakUtilizationPercent ?? 0) > 0;
  if (failures.length) report.verdict = 'FAIL';
  else if (!gpuActive || !usedGpu) report.verdict = 'FAIL_GPU_NOT_USED';
} catch (error) {
  report.verdict = 'ERROR';
  report.error = String(error.stack || error);
} finally {
  await writeFile(join(root, 'qa-hardware-audit.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('\n[a report] ' + JSON.stringify({
    verdict: report.verdict, sigill: report.sigill?.passed, device: report.sigill?.device,
    vramBaselineMB: report.vram?.baselineMB, vramPeakMB: report.vram?.peakMB,
    peakGpuUtilizationPercent: report.vram?.peakUtilizationPercent,
    whisperFound: report.whisper?.found, whisperConfigured: report.whisper?.configured,
    whisperCuda: report.whisper?.cudaAvailable, whisperDevice: report.whisper?.cudaDevice,
    error: report.error,
  }, null, 2));
}
