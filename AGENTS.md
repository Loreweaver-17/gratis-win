# AGENTS.md — working rules for this fork

This fork (`Loreweaver-17/gratis-win`) carries the Windows 11 port of Gratis Core.
`main` still builds for macOS and Linux; the Windows work must never regress them.
Read this file before changing anything under `src/`, `scripts/` or `test/`.

## Golden rules

1. **No POSIX-only assumptions.** Windows has no `/bin/sh`, no `unzip`, no `curl`,
   no `:`-separated `PATH`, and no `/opt/homebrew`. Anything that shells out must
   resolve its command first (see *External commands* below).
2. **Paths come from `node:path`.** Use `path.join`/`path.resolve`; never build a
   path with `'a/b/c'` literals or `split('/')`.
3. **Platform checks live in one place.** `src/platform.mjs` exports `isWindows`,
   `isMac`, `executableNames`, `withExecutableExtension`, `searchPath`,
   `childEnvironment`, `findExecutable` and `keyStoreName`. Add new shared
   platform behaviour there instead of scattering `process.platform` checks.
4. **Credentials only through Electron `safeStorage`.** macOS uses the async API
   (it may show a Keychain prompt); Windows DPAPI/Credential Manager and Linux
   libsecret only expose the sync API. Never add a plaintext fallback, and never
   write a token to JSON or `localStorage`.
5. **A hidden window must be reachable.** On Windows and Linux the tray icon is
   the only way back; only hide when `canKeepRunningInBackground()` says so.
6. **Local inference and macOS packaging are separate areas.** Touch them only
   when the task is about them, and read their file headers first:
   `src/claude-backend.mjs`, `src/codex-client.mjs`, `src/voice.mjs`,
   `src/hardware-capabilities.mjs`, `src/memory-embeddings.mjs`,
   `src/memory-embedding-worker.mjs`, plus `scripts/package.mjs`,
   `scripts/sign-mac.mjs`, `scripts/package-dmg.mjs`, `scripts/verify-mac.mjs`,
   `scripts/verify-dmg.mjs` and `assets/mac-info.plist` / `assets/gratis.icns`.

## Where the Windows work lives

| Concern | File |
| --- | --- |
| Path/env/PATHEXT/PATH helpers | `src/platform.mjs` |
| Credential store (async → sync fallback) | `src/secure-storage.mjs` |
| Tray, minimize-to-tray, platform window/menu | `src/main.cjs` |
| Layout without the macOS inset title bar | `src/styles.css` (`[data-platform]` rules), `src/renderer.mjs` |
| Node-only asset download/extract | `scripts/setup-assets.mjs`, `scripts/unzip.mjs` |
| Composio sign-in spawn env | `src/composio-signin.mjs` |
| T3 local install/discovery | `src/t3-local.mjs` |
| `pdftotext` discovery | `src/workspace-files.mjs` |
| Hardware probe (CPU flags, NVIDIA driver, threads) | `src/hardware-capabilities.mjs` |
| Whisper device/thread selection (CUDA → CPU retry), venv config | `src/voice.mjs`, `scripts/setup-whisper-win.mjs` |
| Embedding worker device selection (DirectML → CPU on Windows) | `src/memory-embeddings.mjs`, `src/memory-embedding-worker.mjs` |
| Windows installer packaging | `package.json` (`build`, `build:win`, `dist:win`), `scripts/make-ico.mjs`, `assets/gratis.ico` |
| Windows prerequisites (human + machine readable) | `BUILD_WINDOWS.md`, `requirements-windows.json` |
| One-command Windows bootstrap | `scripts/setup-win.mjs` (`npm run setup:win`), tested by `test/setup-win.test.mjs` |
| Hardware audit / E2E / installer QA | `scripts/qa-hardware-audit.mjs`, `test/qa-e2e-desktop.mjs`, `test/qa-installer-check.mjs` |

## External commands

To run a tool that may be installed by the user:

```js
import { childEnvironment, findExecutable } from './platform.mjs';

const binary = await findExecutable('pdftotext', { extraDirectories: [...] });
if (!binary) throw new Error('PDF text extraction is unavailable. …');
await exec(binary, args, { env: childEnvironment(), timeout, maxBuffer });
```

- `findExecutable` applies `PATHEXT` (`.exe`, `.cmd`, …) on Windows and checks that
  the candidate is a file, not a directory.
- `childEnvironment()` keeps Windows variable names (`Path`, `SystemRoot`, …) and
  adds `HOME`/`USER`/`TMPDIR` aliases for Node-based CLIs. It intentionally drops
  every other inherited variable so unrelated secrets never reach a child.
- Pass `withExecutableExtension(path)` when you build a path to a known binary.

## Inference and hardware (Windows x64)

`src/hardware-capabilities.mjs` probes once at startup and the result is injected
into the local-runtime consumers — do not re-probe inside them (each probe can run
`nvidia-smi`/PowerShell).

- DirectML-first, CPU fallback: on win32/x64 the embedded ONNX Runtime ships
  `DirectML.dll` but no CUDA provider, so `Auto` selects `device:'dml'` for the
  NVIDIA GPU and falls back to `device:'cpu'` (AVX2/FMA3) if the session fails.
  CUDA remains available as an explicit override for custom ORT builds.
- Whisper uses CUDA when an NVIDIA driver is present and retries the same WAV on
  CPU if the CUDA run fails. `npm run setup:whisper:win` creates an isolated
  CUDA-PyTorch venv and writes `<dataDir>/voice-runtime.json`; `src/voice.mjs`
  reads that file instead of relying on global PATH.
- Overrides for testing and support: `GRATIS_INFERENCE_DEVICE`
  (`auto|dml|cuda|cpu`), `GRATIS_WHISPER_DEVICE` (`auto|cuda|cpu`),
  `GRATIS_CUDA_AVAILABLE` (`0|1`).
- AVX2 + FMA3 + AES-NI are allowed in native builds, AVX-512 is deliberately
  excluded. `npm run setup:assets` writes the profile to the git-ignored
  `assets/runtime/native-build.json`; keep it in sync with `nativeBuildProfile()`.
- `src/voice.mjs` currently has its own `findTool()` (PATH + PATHEXT). Prefer
  `findExecutable()` from `src/platform.mjs` when touching that file so the two
  lookups cannot drift apart.

## Verification

```sh
npm ci                 # installs dev dependencies (Needed for the GUI tests)
npm run check          # verify:public + unit tests
npm run test:desktop   # real Electron window, Windows and macOS
npm run icons:win      # regenerate assets/gratis.ico
npm run build:win      # unpacked Windows build in dist/
```

Unit tests use mocked providers and isolated temp profiles. The GUI test writes
`docs/screenshots/*.png`; restore them with `git checkout -- docs/screenshots`
after a local run on a non-macOS machine.

Windows-specific test guards: symlink assertions only run when the account may
create symlinks (Developer Mode or elevated shell); the macOS signing test is
skipped off macOS.

## Regression traps already fixed — do not reintroduce

- Async-only `safeStorage` (throws `GRATIS_STORAGE_LOCKED` on Windows).
- `unzip`/`curl`/`shasum` shell-outs in `npm run setup:assets`.
- `PATH.split(':')` or `join(':')` in child environments (see the
  `claude-backend.mjs` / `codex-client.mjs` issues below).
- `titleBarStyle: 'hiddenInset'` and `trafficLightPosition` on Windows.
- Closing the window with enabled schedules while no tray exists.
- Treating `ERR_ABORTED` from an aborted first navigation as a fatal startup error.

## Known gaps (documented, not fixed here)

- `src/claude-backend.mjs` and `src/codex-client.mjs` still build `PATH` with `':'`
  and prepend `/opt/homebrew/bin`; the Codex launcher also writes a `#!/bin/sh`
  script. These are the remaining POSIX-only spots.
- `src/voice.mjs` resolves `ffmpeg`/`whisper` correctly now, but still expects the
  Whisper model in `~/.cache/whisper` regardless of platform, and duplicates the
  PATH lookup instead of calling `findExecutable()`.
- Composio publishes no Windows CLI in release 0.6.0; `npm run setup:assets` says
  so and Settings → Connections → *Advanced: use an API key* is the Windows path.
- `scripts/package.mjs` / the DMG scripts remain macOS-only by design.
