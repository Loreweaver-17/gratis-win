# Windows 11 support — change inventory

Branch `windows-11-support` is based on `52bf30f` (upstream `main`) and adds the
Windows 11 port while keeping macOS and Linux behaviour. Every change is listed
here so a reviewer — or an agent — can follow the reasoning without reading the
whole diff. Working rules live in [AGENTS.md](../AGENTS.md).

Commits on the branch:

1. `Land Windows 11 enablement groundwork from the working tree` — platform,
   storage, tray, scripts, tools, tests and docs (sections 1–7).
2. `Add the Windows 11 (win32 x64) build and packaging pipeline` — electron-builder,
   icon generation, CI/release workflows (section 8).
3. `Windows x64 inference hardening` — hardware probe, CUDA-first Whisper, embedding
   device selection, native build profile (section 9).
4. `docs(agents): add the platform contract and this inventory` — `AGENTS.md`,
   this file, and the pointer from `docs/DEVELOPMENT.md`.

## 1. Shared platform helpers — `src/platform.mjs` (new)

| Export | Why it exists |
| --- | --- |
| `isWindows`, `isMac` | Readable guards instead of repeated `process.platform === …` |
| `executableNames(name)` | Windows resolves `composio` through `PATHEXT` (`.exe`, `.cmd`, …) |
| `withExecutableExtension(file)` | Adds `.exe` when a binary path is built by hand |
| `searchPath(env)` | Splits `Path`/`PATH` on `;` on Windows and `:` elsewhere |
| `childEnvironment(env)` | Keeps Windows variable names, adds `HOME`/`USER`/`TMPDIR` aliases for Node CLIs, drops unrelated inherited secrets |
| `findExecutable(name)` | PATH + PATHEXT lookup that rejects directories |
| `keyStoreName()` | One place for "Credential Manager (DPAPI)" / "macOS keychain" / "OS keyring" wording |

`test/platform.test.mjs` (new) pins PATHEXT handling, PATH parsing, the child
environment contract and a real `findExecutable` lookup.

## 2. Credential storage — `src/secure-storage.mjs`

- Before: `createSecureStorageAccess` required `isAsyncEncryptionAvailable()` /
  `encryptStringAsync()` / `decryptStringAsync()`. Those only exist on macOS, so
  Windows threw `GRATIS_STORAGE_LOCKED` during startup.
- Now: async API first (macOS Keychain prompt), otherwise a single sync
  `isEncryptionAvailable()` check plus `encryptString`/`decryptString`
  (Windows DPAPI / Credential Manager, Linux libsecret).
- The Linux `basic_text` backend is still rejected, a denied operation still
  locks the vault for the process, and the error message names the platform store.
- `test/secure-storage.test.mjs`: added a Windows sync round-trip (encrypt,
  decrypt, `wrapKey`/`unwrapKey`) and a fail-closed test for unavailable stores.

## 3. Window, tray and scheduled work — `src/main.cjs`

- `Tray` + `nativeImage` are imported; the tray is created on Windows and Linux
  only (macOS keeps the Dock).
- `app.setAppUserModelId(edition.bundleId)` on Windows (taskbar grouping,
  notifications), window `icon`, and `autoHideMenuBar` for the native caption.
- `titleBarStyle: 'hiddenInset'` and `trafficLightPosition` are now applied on
  macOS only; Windows keeps the native frame, Snap Layouts and system menu.
- Tray menu: **Open**, a disabled schedule summary ("3 scheduled tasks · next …"),
  **Quit**. Tooltip and menu refresh every minute and whenever schedules change.
- Closing the window hides to the tray **only** when enabled schedules exist and a
  tray (or the macOS Dock) can bring the window back; otherwise the app quits.
- Minimizing on Windows with enabled schedules hides to the tray, with a one-time
  balloon explaining that work continues.
- Tray and its timer are torn down in `shutdown()`.
- Platform menu: macOS keeps the app menu (`about`, hide, quit); Windows/Linux get
  File → Hide to notification area / Show window / Quit (`Ctrl+Q`).
- `window.loadURL()` now tolerates `ERR_ABORTED`, which a reload or competing
  navigation raises; previously that surfaced as a fatal "Gratis could not start"
  dialog.
- Startup keychain wording is platform-neutral ("operating-system credential store").
- `src/renderer.mjs` exposes `data-platform`; `src/styles.css` removes the macOS
  title-bar padding and drag region on Windows/Linux.

## 4. Asset setup without POSIX tools — `scripts/`

- `scripts/unzip.mjs` (new): pure-Node ZIP reader/writer-free extractor using
  `zlib.inflateRawSync`, with entry-count/size limits, CRC-length verification,
  path-traversal rejection, Windows-reserved-name rejection and symlink rejection.
- `scripts/setup-assets.mjs`: no `unzip`, no `curl`; keeps SHA-256 pinning; adds the
  Linux Composio digests (`95cf45c5…d890`, `33354e86…aea3`, verified against the
  GitHub release API) next to the existing macOS digests; reports Windows clearly
  because Composio 0.6.0 publishes no Windows asset; both `composio` and
  `bin/composio` layouts are accepted.
- `test/unzip.test.mjs` (new): builds ZIPs in memory and covers stored/deflated
  entries, nested folders, traversal, absolute paths, symlinks and non-ZIP input.
  The extractor was also checked against a real `Compress-Archive` ZIP with
  backslash separators and Unicode names.

## 5. External tools — `src/`

- `src/composio-signin.mjs`: spawns with `childEnvironment()`, resolves
  `composio.exe` on Windows, and replaces a bare `ENOENT` with "browser sign-in is
  not available on Windows — add a project key in Settings → Connections" or
  "run `npm run setup:assets`" on macOS/Linux.
- `src/t3-local.mjs`: `path.join` paths, `findExecutable('t3')` with PATH/PATHEXT,
  POSIX-only directories skipped on Windows, an explicit guard for the `/bin/sh`
  installer, and neutral error text.
- `src/workspace-files.mjs`: `pdftotext` is discovered on PATH instead of the three
  hard-coded Homebrew/system paths.

## 6. Tests

- `test/storage-safety.test.mjs`, `test/workspace.test.mjs`: symlink assertions run
  only when the account may create symlinks (Windows needs Developer Mode or an
  elevated shell); `basename()` replaces `split('/')` for checkpoint names.
- `test/secure-storage.test.mjs`, `test/platform.test.mjs`, `test/unzip.test.mjs`
  as described above.

## 7. Documentation and in-app copy

- `SCHEDULES.md`: closing the window keeps schedules running; macOS = Dock,
  Windows/Linux = notification area; quitting stops execution.
- `README.md`, `docs/QUICKSTART.md`, `docs/DOWNLOADS.md`: source builds on
  Windows 11/macOS/Linux, Node-only asset setup, installers are macOS-only.
- `docs/RELIABILITY.md`: safeStorage mapping per platform (DPAPI, Keychain, libsecret).
- `docs/DEVELOPMENT.md`: new "Windows 11 notes" section plus the agent-rules link.
- `src/index.html`: "Runs on this computer", tray note, "Set up on this computer".
- `src/memory-ui.mjs`: "encrypted on this device".

## 8. Packaging pipeline (separate commit)

- `package.json`: `electron-builder` dev dependency, `build` configuration (appId,
  asar, asarUnpack for native modules, extraResources for models/Composio, NSIS +
  zip targets), scripts `icons:win`, `build:win`, `dist:win`, and `engines.node >= 22`.
- `scripts/make-ico.mjs` (new): dependency-free PNG → multi-size ICO generator;
  `assets/gratis.ico` is the generated artifact.
- `package-lock.json` regenerated; `.gitignore` covers the new `dist/` output.
- `.github/workflows/ci.yml` and `release.yml` extended for the Windows build.

## 9. Inference and hardware (separate commit)

- `src/hardware-capabilities.mjs` (new): one startup probe for CPU vendor/flags
  (AVX2, FMA3, AES-NI), NVIDIA driver presence and CPU thread count, with
  `GRATIS_INFERENCE_DEVICE` / `GRATIS_CUDA_AVAILABLE` overrides for testing. The
  result is injected into the consumers instead of each one probing again.
- `src/voice.mjs`: `findTool()` now splits `PATH` with `;` on Windows and honours
  `PATHEXT`, so `ffmpeg.exe`/`whisper.exe` are actually found; `whisperInvocation()`
  owns the CLI arguments (`--device`, `--fp16`, `--threads`); CUDA is tried first
  and the same WAV is retried on CPU if that run fails; the "on this Mac" error
  text is gone.
- `src/memory-embeddings.mjs` / `src/memory-embedding-worker.mjs`: execution
  provider follows the probe (CUDA when available, CPU otherwise) and the worker
  gets the hardware snapshot rather than re-detecting it.
- `scripts/setup-assets.mjs` writes the git-ignored `assets/runtime/native-build.json`
  (AVX2 + FMA3 + AES-NI enabled, AVX-512 excluded, provider load order) for native
  builds; `test/hardware-capabilities.test.mjs` and `test/voice.test.mjs` cover the
  probe and the invocation/device choice.

## Verification performed on Windows 11 (Node 26.13.1, Electron 42.11.16)

| Check | Result |
| --- | --- |
| `npm test` | 266 tests, 265 pass, 0 fail, 1 skipped (macOS-only signing test) |
| `npm run verify:public` | 205 distribution files, no forbidden data or credential patterns |
| `npm run test:desktop` | Real Electron window: passed, zero renderer errors |
| DPAPI round-trip | Encrypt/decrypt and key wrapping verified by `test/secure-storage.test.mjs` |
| ZIP extraction | Synthetic archives + real `Compress-Archive` output, including Unicode |
| Tray | Window created with tray on Windows, reload via `page.reload()` verified |

## Deliberately unchanged

macOS packaging is untouched: `scripts/package.mjs`, `scripts/sign-mac.mjs`,
`scripts/package-dmg.mjs`, `scripts/verify-mac.mjs`, `scripts/verify-dmg.mjs` with
`assets/mac-info.plist` / `assets/gratis.icns`.

Local inference was out of scope for the platform patch and was hardened
separately (section 9). Still unported: `src/claude-backend.mjs` and
`src/codex-client.mjs` join `PATH` with `:` and prepend `/opt/homebrew/bin`, the
Codex launcher writes a `#!/bin/sh` script, and `src/voice.mjs` still expects the
Whisper model in `~/.cache/whisper`.

These are tracked in [AGENTS.md](../AGENTS.md#known-gaps-documented-not-fixed-here).
