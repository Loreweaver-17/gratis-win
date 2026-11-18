/**
 * AGENT: safe Windows 11 bootstrapper (`npm run setup:win`).
 *
 * Reads requirements-windows.json (single source of truth for versions), checks
 * the host, then runs only idempotent, project-local steps:
 *   1. npm ci                         (unless --skip-deps)
 *   2. node node_modules/electron/install.js  (npm may block install scripts)
 *   3. npm run setup:assets           (checksum-verified semantic encoder)
 *   4. node scripts/setup-whisper-win.mjs (prompt / --with-whisper / --no-whisper)
 *
 * Safety rules — do not break these:
 *   - no elevation, registry edits, shell-profile edits or global PATH changes
 *   - never print credentials; child stdio is inherited only for installers
 *   - --dry-run performs checks and prints the plan but executes nothing
 *   - all decision helpers are exported and side-effect free for unit tests
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const root = fileURLToPath(new URL('../', import.meta.url));
const requirementsPath = join(root, 'requirements-windows.json');

// AGENT: parse "v22.4.1" / "Python 3.11.9" into comparable parts.
export function parseVersion(value) {
  const match = String(value ?? '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] || 0) } : null;
}

export function versionAtLeast(value, minimum) {
  const found = parseVersion(value), required = parseVersion(minimum);
  if (!found || !required) return false;
  if (found.major !== required.major) return found.major > required.major;
  if (found.minor !== required.minor) return found.minor > required.minor;
  return found.patch >= required.patch;
}

export function versionWithin(value, minimum, maximum) {
  const found = parseVersion(value), high = parseVersion(maximum);
  if (!found || !high || !versionAtLeast(value, minimum)) return false;
  if (found.major !== high.major) return found.major < high.major;
  return found.minor <= high.minor;
}

// AGENT: null means "ask the user"; only an interactive TTY is ever prompted.
export function resolveWhisperChoice({ withWhisper = false, noWhisper = false, interactive = false } = {}) {
  if (noWhisper) return false;
  if (withWhisper) return true;
  return interactive ? null : false;
}

export function pythonCandidates(platformName = process.platform) {
  return platformName === 'win32'
    ? [['py', ['-3.12']], ['py', ['-3.11']], ['py', ['-3.10']], ['python', []]]
    : [['python3', []], ['python', []]];
}

// AGENT: probe candidate interpreters without changing state. `run` is injected
// so tests can supply a fake executor.
export function detectPython(platformName = process.platform, run = spawnSync) {
  for (const [command, prefix] of pythonCandidates(platformName)) {
    try {
      const result = run(command, [...prefix, '--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      const text = `${result.stdout || ''}${result.stderr || ''}`.trim();
      if (result.status === 0 && parseVersion(text)) return { command, prefix, version: text };
    } catch { /* interpreter missing */ }
  }
  return null;
}

// AGENT: pure evaluation of the requirements file against collected facts.
export function evaluateChecks(requirements, facts) {
  const { prerequisites: p } = requirements;
  const flags = facts.cpuFlags || {};
  const missingFlags = (p.cpu.requiredFlags || []).filter(flag => !flags[flag]);
  const forbidden = (p.cpu.forbiddenFlags || []).filter(flag => flags[flag]);
  const diskOk = facts.freeGB === null || facts.freeGB === undefined || facts.freeGB >= p.disk.minimumFreeGB;
  return [
    { id: 'platform', label: `OS ${facts.platform}`, severity: 'error', ok: facts.platform === requirements.target.platform, detail: `requires ${requirements.target.platform}` },
    { id: 'arch', label: `Architecture ${facts.arch}`, severity: 'error', ok: facts.arch === requirements.target.arch, detail: `requires ${requirements.target.arch}` },
    { id: 'node', label: `Node.js ${facts.nodeVersion || 'missing'}`, severity: 'error', ok: versionAtLeast(facts.nodeVersion, `${p.node.minimumMajor}.0.0`), detail: `requires >= ${p.node.minimumMajor}` },
    { id: 'python', label: facts.pythonVersion ? `Python ${parseVersion(facts.pythonVersion) ? Object.values(parseVersion(facts.pythonVersion)).slice(0, 2).join('.') : facts.pythonVersion}` : 'Python not found', severity: 'error-if-whisper', ok: facts.pythonVersion ? versionWithin(facts.pythonVersion, `${p.python.minimumMajor}.${p.python.minimumMinor}`, `${p.python.maximumMajor}.${p.python.maximumMinor}`) : false, detail: `requires ${p.python.minimumMajor}.${p.python.minimumMinor}-${p.python.maximumMajor}.${p.python.maximumMinor}` },
    { id: 'gpu', label: facts.gpuName || 'No NVIDIA GPU detected', severity: 'warning', ok: Boolean(facts.gpuAvailable), detail: 'NVIDIA driver via nvidia-smi' },
    { id: 'cpu-simd', label: `CPU ${[...(p.cpu.requiredFlags || [])].filter(flag => flags[flag]).join('+') || 'flags unknown'}`, severity: 'warning', ok: !missingFlags.length && !forbidden.length, detail: missingFlags.length ? `missing ${missingFlags.join(',')}` : forbidden.length ? `unexpected ${forbidden.join(',')}` : 'AVX2/FMA3/AES OK' },
    { id: 'disk', label: facts.freeGB === null || facts.freeGB === undefined ? 'Free disk unknown' : `Free disk ${facts.freeGB} GB`, severity: 'warning', ok: diskOk, detail: `requires >= ${p.disk.minimumFreeGB} GB` },
  ];
}

export function parseArgs(argv) {
  const args = { withWhisper: false, noWhisper: false, skipDeps: false, skipAssets: false, dryRun: false, help: false, model: 'base.en', dataDir: null };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--with-whisper') args.withWhisper = true;
    else if (value === '--no-whisper') args.noWhisper = true;
    else if (value === '--skip-deps') args.skipDeps = true;
    else if (value === '--skip-assets') args.skipAssets = true;
    else if (value === '--dry-run') args.dryRun = true;
    else if (value === '--help' || value === '-h') args.help = true;
    else if (value === '--model' && argv[i + 1]) args.model = argv[++i];
    else if (value === '--data-dir' && argv[i + 1]) args.dataDir = argv[++i];
    else throw new Error(`Unknown option: ${value} (use --help)`);
  }
  return args;
}

function runStep(label, command, commandArgs, { dryRun, shell = false } = {}) {
  console.log(`\n> ${label}: ${command} ${commandArgs.join(' ')}`);
  if (dryRun) return;
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', windowsHide: true, shell, timeout: 30 * 60 * 1000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with status ${result.status}`);
}

// AGENT: spawn npm's JS entry with the current Node binary instead of npm.cmd.
// This avoids Node's DEP0190 (shell:true with args) and works in restricted
// shells where .cmd shims are not resolvable.
function npmRunner() {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(cli)) return { command: process.execPath, prefix: [cli], shell: false };
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [], shell: process.platform === 'win32' };
}

async function confirmWhisper() {
  if (!input.isTTY) return false;
  const prompt = createInterface({ input, output });
  try {
    const answer = await prompt.question('Set up the isolated CUDA Whisper runtime now? [y/N] ');
    return /^y(?:es)?$/i.test(answer.trim());
  } finally { prompt.close(); }
}

function printPlan(checks, options, whisper) {
  console.log('\nPrerequisite checks:');
  for (const check of checks) console.log(`  ${check.ok ? 'OK  ' : 'WARN'} ${check.label} — ${check.detail}`);
  const steps = [
    ...(options.skipDeps ? [] : ['npm ci']),
    'Electron binary install',
    ...(options.skipAssets ? [] : ['npm run setup:assets']),
    ...(whisper ? [`Whisper venv (${options.model})`] : ['Whisper setup skipped']),
  ];
  console.log('\nPlanned steps:');
  for (const step of steps) console.log(`  - ${step}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(await readFile(join(root, 'BUILD_WINDOWS.md'), 'utf8'));
    return;
  }
  const requirements = JSON.parse(await readFile(requirementsPath, 'utf8'));

  // AGENT: reuse the app's own probe so bootstrap telemetry matches startup.
  const { detectHardware } = await import('../src/hardware-capabilities.mjs');
  const hardware = await detectHardware();
  const python = detectPython(process.platform);
  let freeGB = null;
  try { freeGB = Math.round(statfsSync(root).bavail * statfsSync(root).bsize / 1073741824); } catch {}

  const checks = evaluateChecks(requirements, {
    platform: process.platform, arch: process.arch, nodeVersion: process.versions.node,
    pythonVersion: python?.version || null, gpuAvailable: hardware.gpu.available,
    gpuName: hardware.gpu.name, cpuFlags: hardware.cpu.flags, freeGB,
  });

  const needWhisper = resolveWhisperChoice({
    withWhisper: options.withWhisper, noWhisper: options.noWhisper, interactive: Boolean(input.isTTY) && !options.dryRun,
  });
  const whisper = needWhisper === null ? await confirmWhisper() : needWhisper;
  printPlan(checks, options, whisper);

  const blocking = checks.filter(check => check.ok === false && (check.severity === 'error' || (check.id === 'python' && whisper)));
  if (blocking.length) throw new Error(`Blocking prerequisite failure: ${blocking.map(check => `${check.id} (${check.detail})`).join('; ')}`);
  if (!hardware.gpu.available) console.log('\nWARNING: no NVIDIA GPU found — embeddings will use the AVX2 CPU fallback and Whisper must use CPU.');
  if (options.dryRun) { console.log('\nDry run complete; nothing was changed.'); return; }

  const npm = npmRunner();
  if (!options.skipDeps) runStep('Install npm dependencies', npm.command, [...npm.prefix, 'ci', '--no-audit', '--no-fund'], { shell: npm.shell });
  runStep('Ensure Electron binary', process.execPath, ['node_modules/electron/install.js']);
  if (!options.skipAssets) runStep('Download verified assets', npm.command, [...npm.prefix, 'run', 'setup:assets'], { shell: npm.shell });
  if (whisper) {
    const whisperArgs = ['scripts/setup-whisper-win.mjs', '--model', options.model];
    if (options.dataDir) whisperArgs.push('--data-dir', options.dataDir);
    runStep('Set up CUDA Whisper venv', process.execPath, whisperArgs);
  }

  console.log('\nSetup complete. Next: npm start');
  console.log('Verify with: npm test · node scripts/qa-hardware-audit.mjs · node scripts/setup-whisper-win.mjs --check');
}

// AGENT: importing this module for tests must not execute the bootstrapper.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(String(error.stack || error)); process.exitCode = 1; });
}
