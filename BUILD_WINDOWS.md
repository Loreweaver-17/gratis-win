# Building Gratis Core on Windows 11

This is the supported Windows 11 (win32/x64) build path. The automated bootstrapper
`npm run setup:win` checks every prerequisite below, installs dependencies, fetches
assets and — optionally — creates an isolated CUDA Whisper runtime. The machine-readable
source of truth for these checks is [`requirements-windows.json`](requirements-windows.json).

## 1. Prerequisites (exact)

### Operating system
- **Windows 11 x64**, build **22000 or newer** (`winver`). Windows 10 is not a supported build target.
- **PowerShell 7** (`pwsh`) is recommended for the CPU SIMD probe. Windows PowerShell 5.1 works too, but
  falls back to CPU-model inference for AVX2/FMA3 detection.
- No administrator elevation is needed; Gratis never edits the registry, shell profile or global `PATH`.

### CPU
- **x64** processor with **AVX2**, **FMA3** and **AES-NI** (e.g. Intel Core 8th generation or newer).
- AVX-512 is deliberately **not used**: the native flags are `/arch:AVX2 /DGRATIS_FMA3=1
  /DGRATIS_AES_NI=1 /DGRATIS_NO_AVX512=1`. MMX/SSE4.2/TSX are optional.
- 16 GB RAM recommended (the Whisper venv plus Electron can use several GB).

### Node.js
- **Node.js 22+ x64** (tested with 26.13.1), **npm 10+**.
- Check: `node --version && npm --version`. The 64-bit build is required for ONNX Runtime and Electron.

### Python (only for GPU Whisper setup)
- **Python 3.10, 3.11 or 3.12 x64** (tested with 3.11.9), available as `py -3.11` or `python`.
- Used solely by `scripts/setup-whisper-win.mjs` to create `.venv-whisper`. Skip Whisper setup and Python
  is optional.

### GPU / drivers
- **NVIDIA RTX GPU** (tested: **GeForce RTX 5070 Ti**, driver **617.14**).
- **DirectML** is bundled with `onnxruntime-node` on win32/x64 and is the primary semantic-encoder backend
  (`device:'dml'`), with automatic AVX2 CPU fallback. No CUDA install is needed for embeddings.
- **CUDA 12.8+** is required for GPU Whisper. The setup script installs a Blackwell-compatible wheel set
  (`torch 2.11.0+cu128`, `torchvision`, `torchaudio`) from `https://download.pytorch.org/whl/cu128`
  inside the venv; you do **not** need a system-wide CUDA toolkit.
- Verify with `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv`.

### Disk and network
- **25 GB+ free** (CUDA PyTorch wheel ~2.8 GB download / ~8 GB installed, Whisper model ~140 MB, Electron
  and installer).
- Network access to `registry.npmjs.org`, `github.com`, `huggingface.co` and `download.pytorch.org`.

### Optional
- **FFmpeg** on `PATH` (or configured in `voice-runtime.json`) for audio decoding.
- Composio browser sign-in has no win32 release; use a Composio project key in Settings instead.

## 2. Quick start

```powershell
# Full bootstrap: dependencies + Electron + assets, then prompt for Whisper
npm run setup:win

# Non-interactive, with GPU Whisper and the English model
npm run setup:win -- --with-whisper --model base.en

# Dry run: print all checks and planned steps, change nothing
npm run setup:win -- --dry-run

# Start the app
npm start
```

The bootstrapper:
1. reads `requirements-windows.json` and verifies OS/architecture, Node.js, Python (when needed),
   NVIDIA GPU, AVX2/FMA3/AES and free disk space;
2. runs `npm ci` (unless `--skip-deps`) and `node node_modules/electron/install.js` — the latter is needed
   because some npm configurations block install scripts;
3. runs `npm run setup:assets` (checksum-verified semantic encoder) unless `--skip-assets`;
4. asks whether to set up GPU Whisper (or uses `--with-whisper` / `--no-whisper`), then delegates to
   `scripts/setup-whisper-win.mjs` — see [`docs/QUICKSTART.md`](docs/QUICKSTART.md) for voice usage.

Re-running is safe: every step is idempotent.

## 3. Manual equivalent

If you prefer to run each step yourself:

```powershell
npm ci
node node_modules/electron/install.js
npm run setup:assets
npm run setup:whisper:win -- --model base.en   # optional, needs Python 3.10-3.12
npm start
```

## 4. Verification

```powershell
npm test                                    # 279 tests (1 symlink test may skip)
npm run verify:public                       # distribution hygiene
node scripts/qa-hardware-audit.mjs          # CPU SIMD, SIGILL, VRAM + GPU utilization
node scripts/setup-whisper-win.mjs --check  # CUDA availability in the venv
npm run dist:win                            # NSIS .exe + .zip in dist/
node test/qa-installer-check.mjs            # clean install/start/uninstall
```

Expected audit result on the reference machine:
`verdict=PASS`, backend `dml`, no SIGILL, dedicated VRAM increases during inference,
`whisperCuda=true` with `NVIDIA GeForce RTX 5070 Ti`.

## 5. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ORT CUDA provider absent` in startup log | Expected on Windows: `onnxruntime-node` ships CPU + DirectML only. Embeddings use `dml`; CUDA needs a custom ORT build. |
| Electron does not launch after `npm ci` | Install scripts were blocked. Run `node node_modules/electron/install.js` (the bootstrapper does this). |
| `electron-fixture.test.mjs` fails | The clone is inside `%TEMP%`; run tests from a normal directory. |
| `storage-safety` symlink test skips | This account lacks symlink privilege; not a product failure. |
| Whisper falls back to CPU | The venv needs CUDA torch. Run `npm run setup:whisper:win -- --model base.en` and `--check`. |
| Uninstall appears to leave files | NSIS deletes asynchronously; allow ~15 s (the installer check polls). |

## 6. For agents

- Prerequisite versions live only in `requirements-windows.json`; `scripts/setup-win.mjs` reads it at
  runtime. Update both this document and the JSON when changing a version.
- All bootstrapper decisions are exported as pure helpers for unit tests; keep them side-effect free.
- Never write outside the project / Gratis data directory and never print credentials.
