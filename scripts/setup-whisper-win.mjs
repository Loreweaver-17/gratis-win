/**
 * Windows 11 helper: isolated CUDA Whisper runtime for Gratis voice input.
 *
 * Creates <dataDir>/.venv-whisper, installs a Blackwell-compatible CUDA 12.8
 * PyTorch wheel plus openai-whisper, downloads the Whisper model and writes
 * <dataDir>/voice-runtime.json so src/voice.mjs uses that whisper.exe directly
 * (no global PATH or registry changes).
 *
 * Usage:
 *   node scripts/setup-whisper-win.mjs                 # full setup (auto model)
 *   node scripts/setup-whisper-win.mjs --model base    # automatic language mode
 *   node scripts/setup-whisper-win.mjs --check         # verify existing runtime
 *   node scripts/setup-whisper-win.mjs --data-dir DIR --python "py -3.11"
 *
 * Requires network access for pip and the PyTorch CUDA wheel index.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform as osPlatform } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback;
};
const has = flag => args.includes(flag);
const checkOnly = has('--check');

const dataDir = option('--data-dir', process.env.GRATIS_DATA_DIR || (process.env.APPDATA ? join(process.env.APPDATA, 'Gratis Core', 'data') : join(root, 'data')));
const venvDir = option('--venv', join(dataDir, '.venv-whisper'));
const modelsDir = join(venvDir, 'models');
const scriptsDir = join(venvDir, 'Scripts');
const pythonExe = join(scriptsDir, 'python.exe');
const whisperExe = join(scriptsDir, 'whisper.exe');
const configPath = join(dataDir, 'voice-runtime.json');
const model = option('--model', 'base.en');
const pythonOption = option('--python', '');

function run(command, commandArgs, label) {
  console.log(`> ${label || command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', windowsHide: true, timeout: 30 * 60 * 1000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label || command} exited with status ${result.status}`);
}

function capture(command, commandArgs) {
  return execFileSync(command, commandArgs, { encoding: 'utf8', timeout: 60000, windowsHide: true }).trim();
}

function hostPython() {
  if (pythonOption) {
    const parts = pythonOption.split(/\s+/);
    return { command: parts[0], prefix: parts.slice(1) };
  }
  if (osPlatform() === 'win32') {
    try { if (spawnSync('py', ['-3.11', '-c', 'print(1)'], { windowsHide: true, timeout: 10000 }).status === 0) return { command: 'py', prefix: ['-3.11'] }; } catch {}
  }
  return { command: 'python', prefix: [] };
}

async function main() {
  if (osPlatform() !== 'win32' && !has('--force')) throw new Error('This helper targets Windows 11. Use --force only for CI dry runs.');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  if (checkOnly) {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    await access(config.whisper, constants.X_OK);
    const info = capture(config.python, ['-c', "import torch, whisper; print('cuda=' + str(torch.cuda.is_available())); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'none'); print(whisper.__version__ if hasattr(whisper,'__version__') else 'whisper-ok')"]);
    console.log(info);
    if (!info.includes('cuda=True')) throw new Error('CUDA is not available in the Whisper venv.');
    console.log(`Whisper runtime OK: ${config.whisper}`);
    return;
  }

  const host = hostPython();
  const py = (commandArgs, label) => run(host.command, [...host.prefix, ...commandArgs], label);
  const venvPy = (commandArgs, label) => run(pythonExe, commandArgs, label);

  console.log(`Creating venv: ${venvDir}`);
  py(['-m', 'venv', venvDir], 'python -m venv');

  // Blackwell (RTX 50-series) needs CUDA 12.8+; cu128 is the stable wheel index.
  venvPy(['-m', 'pip', 'install', '--upgrade', 'pip'], 'pip upgrade');
  venvPy(['-m', 'pip', 'install', '--index-url', 'https://download.pytorch.org/whl/cu128',
    'torch', 'torchvision', 'torchaudio'], 'CUDA PyTorch (cu128)');
  venvPy(['-m', 'pip', 'install', 'openai-whisper'], 'openai-whisper');

  const cudaCheck = execFileSync(pythonExe, ['-c',
    "import torch; assert torch.cuda.is_available(), 'CUDA unavailable in venv'; print(torch.cuda.get_device_name(0))"],
    { encoding: 'utf8', timeout: 120000, windowsHide: true }).trim();
  console.log(`CUDA device: ${cudaCheck}`);

  await mkdir(modelsDir, { recursive: true, mode: 0o700 });
  venvPy(['-c', `import whisper; whisper.load_model(${JSON.stringify(model)}, download_root=${JSON.stringify(modelsDir)})`], `download ${model}`);

  const sitePackages = execFileSync(pythonExe, ['-c', 'import site; print(site.getsitepackages()[0])'],
    { encoding: 'utf8', timeout: 60000, windowsHide: true }).trim();
  const pathAdditions = [scriptsDir, join(sitePackages, 'torch', 'lib')];
  try {
    const nvidiaRoot = join(sitePackages, 'nvidia');
    for (const entry of await readdir(nvidiaRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) pathAdditions.push(join(nvidiaRoot, entry.name, 'bin'));
    }
  } catch { /* some wheel layouts keep DLLs only in torch/lib */ }

  const config = {
    name: 'Gratis Whisper CUDA runtime', platform: 'win32', python: pythonExe,
    whisper: whisperExe, modelDir: modelsDir, model, device: 'cuda', pathAdditions,
  };
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  console.log(`Wrote ${configPath}`);
  console.log(`Gratis will now use ${whisperExe} with ${model} on ${cudaCheck}.`);
}

main().catch(error => { console.error(String(error.stack || error)); process.exitCode = 1; });
