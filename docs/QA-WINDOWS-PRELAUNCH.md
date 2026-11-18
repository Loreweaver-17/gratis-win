# Windows 11 pre-launch QA report — Gratis Core 0.4.2

Target: Windows 11 x64, Intel Core i7-8700 (MMX/SSE4.2/AES/AVX/AVX2/FMA3, no AVX-512), NVIDIA GeForce RTX 5070 Ti (16,303 MB, driver 617.14).
Run date: 2026-11-18. Artifacts: `qa-hardware-audit.json`, `qa-e2e-report.json`, `qa-final-tests.log`, `qa-dist-win.log`.

## 1. Automated unit & smoke tests

| Suite | Result |
|---|---|
| Full `test/*.test.mjs` (run outside the system temp dir) | **275 pass / 0 fail / 1 skip** |
| Skip reason | `storage-safety`: symlink check — this account cannot create symlinks (environment limitation, not a product defect) |
| `npm test` from a clone inside `%TEMP%` | 1 false failure in `electron-fixture.test.mjs`: it asserts `process.cwd()` is outside `tmpdir()`. Verified passing when launched from a non-temp cwd. No source change needed. |

New Windows-specific tests (10/10 pass):

- `test/windows-platform.test.mjs` — `;` PATH, case-insensitive `Path`, PATHEXT, `childEnvironment` secret stripping, `.exe` discovery through `platform.findExecutable` and `voice.findTool`, `keyStoreName`.
- `test/windows-secure-storage.test.mjs` — synchronous `safeStorage` path, vault-key round-trip, locked-state latching, and a **real DPAPI** (`System.Security.ProtectedData`, CurrentUser) encrypt/decrypt and keyring round-trip.
- `test/windows-tray.test.mjs` — close-to-tray decision matrix, one-time balloon hint, tooltip/summary text, menu actions, click/double-click wiring.

Production change made for testability: `src/tray-lifecycle.cjs` holds the pure tray decisions; `src/main.cjs` now delegates to it. Behavior is unchanged.

## 2. Hardware & instruction-set audit

Run: `node scripts/qa-hardware-audit.mjs --iterations 8 --children 3`.

- **CPU flags (probed):** `MMX+SSE42+AES+AVX+AVX2+FMA3`; `avx512f=false`; native flags `/arch:AVX2 /DGRATIS_FMA3=1 /DGRATIS_AES_NI=1 /DGRATIS_NO_AVX512=1`.
- **SIGILL under load: PASS.** 3 child processes × 8 real ONNX-Runtime inference iterations on the AVX2/FMA3 CPU path; all exited 0, no `SIGILL`, no Windows `0xC000001D` (`STATUS_ILLEGAL_INSTRUCTION`) statuses.
- **VRAM/kernels on RTX 5070 Ti: FAIL.** `nvidia-smi` baseline 1,329 MB → peak 1,332 MB (Δ 3 MB = noise), no node.exe in `--query-compute-apps`. The encoder ran on CPU.
- **Whisper CLI: BLOCKED.** `whisper` is not on PATH and the available Python torch is CPU-only (`torch 2.11.0+cpu`, `cuda=False`), so no GPU transcription verification was possible.

### Root cause (exact stack trace)

All three CUDA attempts died before any kernel was dispatched:

```
Error: Unsupported device: "cuda". Should be one of: dml, webgpu, cpu.
    at deviceToExecutionProviders (node_modules/@huggingface/transformers/dist/transformers.node.mjs:12629:9)
    at getSession (node_modules/@huggingface/transformers/dist/transformers.node.mjs:23749:30)
    at constructSessions (node_modules/@huggingface/transformers/dist/transformers.node.mjs:23817:26)
    at BertModel.from_pretrained (node_modules/@huggingface/transformers/dist/transformers.node.mjs:25771:7)
    at async pipeline (node_modules/@huggingface/transformers/dist/transformers.node.mjs:34818:48)
```

Forcing the provider directly is also unsupported by the bundled binary:

```
Error: no available backend found. ERR: [CUDAExecutionProvider] backend not found.,
  [CPUExecutionProvider] backend not found.
    at resolveBackendAndExecutionProviders (node_modules/onnxruntime-common/dist/cjs/backend-impl.js:124:15)
    at async InferenceSession.create (node_modules/onnxruntime-common/dist/cjs/inference-session-impl.js:186:52)
```

`onnxruntime-node@1.30.0` ships only CPU + DirectML on win32/x64 (`script/install-metadata.js` has no `win32/x64:cuda12` manifest). Transformers.js 4.3.2 whitelists `dml, webgpu, cpu` on Windows. The app therefore correctly falls back to AVX2 CPU (`memory-embedding-worker.mjs`), but the CUDA/VRAM launch criterion cannot be met with these dependencies.

### Fixes

1. **Use DirectML on Windows** (`device:'dml'`) for NVIDIA GPU execution without CUDA — supported by the bundled ORT binary; update the device probe to prefer `dml` when `cuda` is unavailable. This uses the GPU but **not** cuBLAS/CUDA.
2. **For true CUDA/cuBLAS:** install CUDA 12.x runtime, add a CUDA-enabled `onnxruntime-node` build (NuGet `Microsoft.ML.OnnxRuntime.Gpu.Windows`, matching version) with `onnxruntime_providers_cuda.dll` + `onnxruntime_providers_shared.dll`, and pass `session_options.executionProviders = ['CUDAExecutionProvider','CPUExecutionProvider']` while leaving `device:'cpu'` (Transformers.js applies explicit providers at `transformers.node.mjs:23772`). Verify with `nvidia-smi` before launch; guard with the existing probe because a missing provider can abort Node.
3. **Whisper:** `python -m pip install openai-whisper` in a venv with a CUDA build of torch, download `base.en`, activate the venv, then rerun the audit.

## 3. Functional E2E checklist

Run: `node test/qa-e2e-desktop.mjs` (isolated temp profile, demo provider). Full output in `qa-e2e-report.json`.

| Check | Result |
|---|---|
| Demo launch reports `platform=win32, arch=x64` | PASS |
| Create 3-bot group via `createThread` | PASS |
| `@everyone` yields replies from lead + 2 peers | PASS |
| Semantic encoder ready (CPU fallback) | PASS |
| Save + retrieve semantic memory | PASS |
| Live providers | INFO — Claude Code and Codex CLIs are not installed/signed in on this machine; live mode cannot be exercised |
| Create `* * * * *` cron schedule | PASS (note: `kind:'interval'` enforces a 15-minute minimum, so a 1-minute task must use cron) |
| Close window to tray; app stays alive, window hidden, not destroyed | PASS |
| Scheduled task ran within 1 minute while window stayed hidden | PASS |
| Checkpoint created via Settings action | PASS |
| Restore via `scripts/workspace-recovery.mjs restore` and clean relaunch | PASS |
| Heap growth (main and renderer) | PASS — main 31→29 MB (−2), renderer 10→10 MB (0); no leak signal |

## 4. Packaging & installer

`npm run dist:win` **PASS** — produced `dist/Gratis-Core-0.4.2-win-x64.exe` (NSIS), `.zip`, `.blockmap`; no code-signing certificate configured (warning only).

`node test/qa-installer-check.mjs` — all PASS:

| Check | Result |
|---|---|
| Installer artifacts present | PASS |
| Silent install (`/S /D=<clean dir>`) | PASS (21 entries) |
| `Gratis Core.exe` present | PASS |
| Installed app starts with an isolated data dir, no crash | PASS (`exitCode=null`, empty stderr) |
| Silent uninstall (`/S`) removes all files | PASS (0 entries, after polling — NSIS deletes asynchronously) |

The first uninstall run reported a false WARN after a 1.5 s wait; the harness now polls up to 15 s. No product change was needed.


## 5. Warnings

- `npm ci` blocked install scripts for `onnxruntime-node`, `electron-winstaller`, `protobufjs` (environment allow-scripts policy); the Electron binary had to be fetched separately via `node node_modules/electron/install.js`.
- `nvidia-smi --query-compute-apps` showed several shell/Explorer processes with `[N/A]` memory; VRAM was heavily contended early in the run (15,646 MB used). Re-run GPU checks on an idle machine.
- No native compiler (`gcc`/`clang`/`cl`) is installed, so the SIGILL check used the shipped AVX2/FMA3 ONNX Runtime binaries rather than a purpose-built assembly stub.
