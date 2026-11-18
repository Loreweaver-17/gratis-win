/**
 * AGENT MAP — hardware capability check for local inference, audio and memory.
 *
 * Why this module exists:
 *   Node-only probes (no third-party imports) run BEFORE any native inference
 *   binding is loaded. Asking ONNX Runtime for CUDA without the matching native
 *   provider can abort the process, so we always probe before requesting it.
 *
 * Call flow — follow this order when changing behaviour:
 *   src/main.cjs ................ detectHardware() at startup, logs the summary
 *     |-- src/memory-embeddings.mjs .... passes `hardware` into the worker
 *     |     `-- src/memory-embedding-worker.mjs
 *     |           deviceCandidates() -> ['dml','cpu'] on Windows (or
 *     |           ['cuda','cpu'] where CUDA is real), then CPU fallback
 *     `-- src/voice.mjs ................ resolveWhisperDevice() picks
 *                                       --device cuda|cpu for the Whisper CLI
 *   scripts/setup-assets.mjs .... nativeBuildProfile() writes the Windows x64
 *                                 profile to assets/runtime/native-build.json
 *
 * WINDOWS GPU BACKEND: onnxruntime-node ships DirectML (DirectML.dll) on
 * win32/x64 but no CUDA provider, so Auto selects 'dml' for the RTX 5070 Ti.
 * CUDA remains available as an explicit override for custom ORT builds.
 *
 * Overrides (agents: check these first when a user reports the wrong device):
 *   GRATIS_INFERENCE_DEVICE = auto | dml | cuda | cpu  (embeddings; default auto)
 *   GRATIS_WHISPER_DEVICE   = auto | cuda | cpu          (Whisper; default auto)
 *   GRATIS_CUDA_AVAILABLE   = 1 | 0               (force CUDA runtime on/off)
 *   GRATIS_CPU_FLAGS        = +AVX2,+FMA3,-TSX...  (override the CPUID probe)
 *
 * Target machine: Windows 11 x64, Intel AVX2/FMA3/AES, NVIDIA RTX 5070 Ti.
 * AVX-512 is deliberately NEVER enabled here (it would crash this CPU).
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { availableParallelism, arch as osArch, cpus, platform as osPlatform } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const runCommand = promisify(execFile);
export const CPU_FEATURE_KEYS = ['mmx', 'sse42', 'aes', 'avx', 'avx2', 'fma3', 'tsx', 'avx512f'];
const CPU_FLAG_ALIASES = {
  MMX: 'mmx', SSE: 'sse42', SSE4: 'sse42', SSE42: 'sse42', SSE4_2: 'sse42',
  AES: 'aes', AESNI: 'aes', AVX: 'avx', AVX2: 'avx2',
  FMA: 'fma3', FMA3: 'fma3', TSX: 'tsx', AVX512: 'avx512f', AVX512F: 'avx512f',
};

const toNumber = value => { const number = parseFloat(String(value)); return Number.isFinite(number) ? Math.round(number) : 0; };
const bool = value => value === true || value === 'True' || value === 'true' || value === '1';

// AGENT: CPU step 1/3 — parse the optional env override (+FLAG / -FLAG).
// GRATIS_CPU_FLAGS is explicit, e.g. "+AVX2,+FMA3,+AES,-TSX".
export function parseCpuFlagOverride(value = '') {
  const flags = {};
  for (const token of String(value).split(/[,\s]+/).filter(Boolean)) {
    const sign = /^[+-]/.test(token) ? token[0] : '';
    const name = (sign ? token.slice(1) : token).toUpperCase();
    const key = CPU_FLAG_ALIASES[name];
    if (key) flags[key] = sign !== '-';
  }
  return flags;
}

// AGENT: CPU step 2a/3 — last-resort inference from the CPU model name when a
// real CPUID probe is unavailable. Conservative on purpose: only x64 baseline
// flags are claimed. Never returns avx512f=true (see AGENT MAP above).
function inferCpuFlags(model = '') {
  const text = String(model || '').toLowerCase();
  const legacy = /pentium|celeron|atom|core\s?2|nehalem|westmere|clarkdale|sandy bridge|ivy bridge/i.test(text);
  return {
    mmx: true,
    sse42: !legacy,
    aes: /nehalem|core\s?2/i.test(text) ? false : true,
    avx: !legacy,
    avx2: !legacy,
    fma3: !legacy,
    tsx: false,
    avx512f: false,
  };
}

// AGENT: CPU step 2b/3 — the real probe. PowerShell 7 exposes intrinsics via
// .NET; PowerShell 5.1 does not, so the `probe` marker rejects its all-false
// result. Mmx/Tsx have no .NET type and are filled in separately.
export async function probeCpuFlagsWithPowerShell(run = runCommand) {
  // System.Runtime.Intrinsics.X86 is only available in PowerShell 7+ (.NET 5+).
  // Several flags (MMX, TSX) have no matching type, so each probe is guarded
  // and a marker rejects PowerShell 5.1 where every type is missing.
  const intrinsic = (key, type) => `try{$f.${key}=[System.Runtime.Intrinsics.X86.${type}]::IsSupported}catch{$f.${key}=$false};`;
  const script = [
    "$ErrorActionPreference='SilentlyContinue'; $f=@{}; $f.mmx=$true;",
    intrinsic('sse42', 'Sse42'),
    intrinsic('aes', 'Aes'),
    intrinsic('avx', 'Avx'),
    intrinsic('avx2', 'Avx2'),
    intrinsic('fma3', 'Fma'),
    intrinsic('tsx', 'Tsx'),
    intrinsic('avx512f', 'Avx512F'),
    "try{[void][System.Runtime.Intrinsics.X86.Avx2];$f.probe=$true}catch{$f.probe=$false};",
    "[Console]::WriteLine((($f.GetEnumerator()|Sort-Object Name|ForEach-Object{$_.Key+'='+$_.Value}) -join ','))",
  ].join('');
  for (const shell of ['pwsh', 'powershell']) {
    try {
      const { stdout } = await run(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000, windowsHide: true, maxBuffer: 65536 });
      const found = {};
      for (const part of String(stdout).trim().split(',')) {
        const [key, value] = part.split('=');
        if (key && value !== undefined) found[key.trim()] = bool(value.trim());
      }
      if (found.probe === true) { delete found.probe; return found; }
    } catch { /* shell or .NET intrinsics unavailable */ }
  }
  return null;
}

// AGENT: CPU step 3/3 — merge probe + override, then force avx512f=false.
// Result shape: { model, flags, source ('inferred'|'probed'|'override'), threads }.
export async function resolveCpuFlags({ env = process.env, platform = osPlatform(), arch = osArch(), model, probe } = {}) {
  const override = parseCpuFlagOverride(env.GRATIS_CPU_FLAGS);
  let flags = arch === 'x64' ? inferCpuFlags(model) : Object.fromEntries(CPU_FEATURE_KEYS.map(key => [key, false]));
  let source = 'inferred';
  if (arch === 'x64') {
    const probed = await (probe || (() => probeCpuFlagsWithPowerShell()))();
    if (probed) { flags = { ...flags, ...probed }; source = 'probed'; }
  }
  flags = { ...flags, ...override };
  // AVX-512 is never enabled on this target, even if a probe reports it.
  flags.avx512f = false;
  return {
    model: String(model || 'Unknown CPU').trim(),
    flags: Object.fromEntries(CPU_FEATURE_KEYS.map(key => [key, !!flags[key]])),
    source: Object.keys(override).length ? 'override' : source,
    threads: Math.max(1, typeof availableParallelism === 'function' ? availableParallelism() : (cpus()?.length || 1)),
  };
}

// AGENT: GPU step 1/2 — parse `nvidia-smi --query-gpu=...` CSV (MB units).
export function parseNvidiaSmi(text) {
  const devices = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [index, name, total, free, used, driver] = line.split(',').map(part => part.trim());
    if (name === undefined) continue;
    devices.push({
      index: toNumber(index), name,
      vramTotalMB: toNumber(total), vramFreeMB: toNumber(free), vramUsedMB: toNumber(used),
      driverVersion: driver || '',
    });
  }
  return devices;
}

function cudaRuntimeAvailable(env, platform) {
  const directories = [];
  if (env.CUDA_PATH) directories.push(join(env.CUDA_PATH, 'bin'), join(env.CUDA_PATH, 'lib64'));
  directories.push(...String(env.PATH || env.Path || '').split(delimiter).filter(Boolean).slice(0, 250));
  const prefixes = platform === 'win32'
    ? ['cudart64_', 'cublas64_', 'cublasLt64_', 'curand64_']
    : ['libcudart', 'libcublas', 'libcublasLt', 'libcurand'];
  for (const directory of directories) {
    try {
      if (readdirSync(directory).some(file => prefixes.some(prefix => file.startsWith(prefix)))) return true;
    } catch { /* unreadable directory */ }
  }
  return false;
}

// AGENT: GPU step 2/2 — nvidia-smi provides the card/VRAM/driver; PATH and
// CUDA_PATH provide the CUDA runtime. `cudaDriverAvailable` is separate from
// `cudaForInference` because PyTorch (Whisper) bundles its own CUDA runtime,
// while ONNX Runtime needs system CUDA libraries on PATH.
export async function probeGpu({ env = process.env, platform = osPlatform(), run = runCommand } = {}) {
  let devices = [];
  try {
    const { stdout } = await run('nvidia-smi', [
      '--query-gpu=index,name,memory.total,memory.free,memory.used,driver_version',
      '--format=csv,noheader,nounits',
    ], { timeout: 5000, windowsHide: true, maxBuffer: 65536 });
    devices = parseNvidiaSmi(stdout);
  } catch { /* no NVIDIA driver or nvidia-smi on PATH */ }
  const primary = devices.slice().sort((a, b) => b.vramFreeMB - a.vramFreeMB)[0] || null;
  let runtime = cudaRuntimeAvailable(env, platform);
  if (env.GRATIS_CUDA_AVAILABLE === '1') runtime = true;
  if (env.GRATIS_CUDA_AVAILABLE === '0') runtime = false;
  return {
    available: !!primary,
    name: primary?.name || null,
    vramTotalMB: primary?.vramTotalMB || 0,
    vramFreeMB: primary?.vramFreeMB || 0,
    vramUsedMB: primary?.vramUsedMB || 0,
    driverVersion: primary?.driverVersion || '',
    devices,
    cudaRuntimeAvailable: runtime,
    cudaDriverAvailable: !!primary,
    // PyTorch (used by the Whisper CLI) bundles its own CUDA runtime, so a
    // detected NVIDIA driver is enough to attempt CUDA for speech-to-text.
    cudaForInference: !!primary && runtime,
  };
}

// AGENT: resolve the onnxruntime-node package root from Transformers.js's own
// module scope (npm may install two copies). `exports` blocks './package.json',
// so walk up from the resolved entry point until the real package.json is found.
function onnxRuntimeRoot(fileExists = existsSync) {
  const packageRoot = (requireFn, name) => {
    const entry = requireFn.resolve(name);
    let dir = join(entry, '..');
    while (dir && dir !== join(dir, '..')) {
      if (fileExists(join(dir, 'package.json'))) return dir;
      dir = join(dir, '..');
    }
    return null;
  };
  try {
    const require = createRequire(import.meta.url);
    const transformersDir = packageRoot(require, '@huggingface/transformers');
    if (!transformersDir) return null;
    return packageRoot(createRequire(join(transformersDir, 'package.json')), 'onnxruntime-node');
  } catch { return null; }
}

// AGENT: ORT provider probe — ORT 1.30.0 has no win32/x64 cuda12 manifest, so
// this is false on Windows; the worker still falls back cleanly if forced.
export function probeOnnxRuntimeCuda(fileExists = existsSync) {
  const ortDir = onnxRuntimeRoot(fileExists);
  if (!ortDir) return false;
  return [
    join(ortDir, 'bin', 'napi-v6', 'win32', 'x64', 'onnxruntime_providers_cuda.dll'),
    join(ortDir, 'bin', 'napi-v6', 'linux', 'x64', 'libonnxruntime_providers_cuda.so'),
  ].some(fileExists);
}

// AGENT: ORT DirectML probe — the bundled win32/x64 binary DOES contain
// DirectML.dll, so this is the primary GPU backend on Windows.
export function probeOnnxRuntimeDirectML(fileExists = existsSync) {
  const ortDir = onnxRuntimeRoot(fileExists);
  if (!ortDir) return false;
  return [
    join(ortDir, 'bin', 'napi-v6', 'win32', 'x64', 'DirectML.dll'),
    join(ortDir, 'bin', 'napi-v6', 'win32', 'arm64', 'DirectML.dll'),
  ].some(fileExists);
}

// AGENT: native build flags — consumed by scripts/setup-assets.mjs and written
// to assets/runtime/native-build.json. AVX2 + FMA3 + AES-NI on; AVX-512 off.
export function nativeBuildProfile({ platform = osPlatform(), arch = osArch(), cpu = {}, gpu = {}, directml = false } = {}) {
  const win64 = platform === 'win32' && arch === 'x64';
  return {
    target: win64 ? 'x86_64-pc-windows-msvc' : `${arch}-${platform}`,
    abi: 'napi-v6',
    cpu: {
      avx2: !!cpu.flags?.avx2,
      fma3: !!cpu.flags?.fma3,
      aesNi: !!cpu.flags?.aes,
      avx512: false,
    },
    cuda: { enabled: !!gpu.cudaForInference, cublas: !!gpu.cudaForInference },
    directml: { enabled: !!directml && win64 },
    flags: win64
      ? ['/arch:AVX2', '/DGRATIS_FMA3=1', '/DGRATIS_AES_NI=1', '/DGRATIS_NO_AVX512=1']
      : ['-mavx2', '-mfma', '-maes', '-mno-avx512f'],
    note: 'AVX2 + FMA3 + AES-NI enabled; AVX-512 deliberately excluded for this CPU.',
  };
}

// AGENT: device selection used by the embedding worker. The preferred GPU
// backend is tried FIRST; any load/session failure falls through to the AVX2
// CPU backend. 'dml' is the real Windows GPU path for the bundled ORT binary.
export function deviceCandidates(hardware, override) {
  const requested = override || hardware?.inference?.preferredDevice || 'cpu';
  return requested === 'cuda' || requested === 'dml' ? [requested, 'cpu'] : ['cpu'];
}

// AGENT: main entry point — called once at startup by src/main.cjs. Just call
// detectHardware() and pass the returned object to MemoryEmbeddings and
// transcribeAudio. All sub-probes are injectable for tests.
export async function detectHardware({ env = process.env, platform = osPlatform(), arch = osArch(), run = runCommand, probeCpu, probeOrt, probeDml } = {}) {
  const cpu = await resolveCpuFlags({ env, platform, arch, model: cpus()[0]?.model, probe: probeCpu });
  const gpu = await probeGpu({ env, platform, run });
  const ortCuda = await (probeOrt || (() => Promise.resolve(probeOnnxRuntimeCuda())))();
  const ortDirectML = await (probeDml || (() => Promise.resolve(probeOnnxRuntimeDirectML())))();
  const requested = String(env.GRATIS_INFERENCE_DEVICE || 'auto').toLowerCase();
  let preferredDevice;
  if (requested === 'dml' || requested === 'cuda' || requested === 'cpu') preferredDevice = requested;
  else if (platform === 'win32' && arch === 'x64' && gpu.available && ortDirectML) preferredDevice = 'dml';
  else if (gpu.cudaForInference) preferredDevice = 'cuda';
  else preferredDevice = 'cpu';
  const hardware = {
    platform, arch, cpu, gpu,
    inference: {
      preferredDevice,
      fallbackDevice: 'cpu',
      requested,
      ortCudaAvailable: ortCuda,
      ortDirectMLAvailable: ortDirectML,
      allowCuda: platform === 'win32' ? arch === 'x64' : true,
    },
  };
  hardware.native = nativeBuildProfile({ ...hardware, directml: ortDirectML });
  return hardware;
}

export function hardwareSummary(hardware = {}) {
  const { cpu = {}, gpu = {}, inference = {}, native = {} } = hardware;
  return {
    platform: hardware.platform, arch: hardware.arch,
    cpu: { model: cpu.model, flags: cpu.flags, detectedVia: cpu.source, threads: cpu.threads },
    gpu: {
      name: gpu.name, vramTotalMB: gpu.vramTotalMB, vramFreeMB: gpu.vramFreeMB,
      driverVersion: gpu.driverVersion, cudaRuntimeAvailable: gpu.cudaRuntimeAvailable,
    },
    inference: {
      preferredDevice: inference.preferredDevice, fallbackDevice: 'cpu',
      ortCudaAvailable: inference.ortCudaAvailable, ortDirectMLAvailable: inference.ortDirectMLAvailable,
    },
    native,
  };
}

// AGENT: startup log — one line per fact (CPU/SIMD, GPU/VRAM, CUDA, native
// target). Keep this human-readable; it is the primary diagnostic output.
export function logHardwareCapabilities(hardware, log = console.info) {
  const { platform, arch, cpu = {}, gpu = {}, inference = {}, native = {} } = hardware;
  const flags = cpu.flags || {};
  const enabled = CPU_FEATURE_KEYS.filter(key => key !== 'avx512f' && flags[key]).map(key => key.toUpperCase()).join('+') || 'baseline';
  log(`[gratis:hardware] ${platform} ${arch} · CPU ${cpu.model || 'Unknown CPU'} · ${cpu.threads || 1} threads`);
  log(`[gratis:hardware] SIMD ${enabled} (${cpu.source || 'inferred'}; AVX-512 disabled)`);
  if (gpu.available) {
    log(`[gratis:hardware] GPU ${gpu.name} · VRAM ${gpu.vramFreeMB}/${gpu.vramTotalMB} MB free · driver ${gpu.driverVersion || 'unknown'}`);
    if (inference.preferredDevice === 'dml')
      log(`[gratis:hardware] DirectML (${gpu.name}) active · dedicated GPU memory used for embeddings`);
    else
      log(`[gratis:hardware] CUDA runtime ${gpu.cudaRuntimeAvailable ? 'available' : 'not found'} · ORT CUDA provider ${inference.ortCudaAvailable ? 'present' : 'absent'} · ORT DirectML ${inference.ortDirectMLAvailable ? 'present' : 'absent'}`);
  } else {
    log('[gratis:hardware] GPU none detected (nvidia-smi unavailable)');
  }
  log(`[gratis:hardware] inference ${inference.preferredDevice || 'cpu'} preferred, CPU fallback · native ${native.target || `${arch}-${platform}`} [${(native.flags || []).join(', ')}]`);
}

export async function toolAvailable(name, { run = runCommand, args = ['--version'] } = {}) {
  try { await run(name, args, { timeout: 3000, windowsHide: true }); return true; } catch { return false; }
}

export async function hasExecutable(path, name) {
  try { await access(join(path, name), constants.X_OK); return true; } catch { return false; }
}
