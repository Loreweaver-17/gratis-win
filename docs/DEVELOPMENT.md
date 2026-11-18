# Development

```sh
npm ci
npm run check
npm run setup:assets
npm run test:desktop
node test/slack-desktop.mjs
```

`npm test` uses isolated temporary workspaces and mocked providers. It must not contact real mailboxes or spend provider usage. The desktop smoke test uses synthetic conversations, demonstrates key controls, and produces the documentation screenshots. It never opens your personal app profile.

`npm run verify:public` checks tracked files for accidental runtime data, unsupported bundled assets and obvious secret/path patterns. Run a dedicated secret scanner before publication as well; neither check proves the absence of every kind of sensitive information.

On macOS Apple Silicon, build a local ad-hoc signed app with:

```sh
npm run setup:assets
npm run package:mac
```

Output goes under `release/`. This is not a notarized distribution pipeline. Signing credentials, release notarization and any update service are deployment responsibilities and must stay outside Git.

## Editing the runtime

Add tool definitions in `src/agent-tools.mjs`. Keep IPC privilege checks in the main process. Test changes to group routing, queues, approvals and recovery with isolated fixtures. When adding a stored field, consider startup compatibility and what export can expose.

Use `edition.json` for edition-specific identity. Keep shared behavior in the core and community content in the separate overlay. Do not add a private endpoint, user transcript, production fixture, access token or machine-specific path as a default.

## Windows 11 notes

`src/platform.mjs` is the shared place for platform differences: `searchPath()` uses `;` on Windows, `withExecutableExtension()` adds `.exe`, `childEnvironment()` keeps Windows variable names and adds POSIX aliases for Node-based CLIs, and `keyStoreName()` names the credential store in messages. Prefer `node:path` joins over `/` string literals, and do not shell out to `unzip`, `open`, `codesign` or `hdiutil` outside the macOS packaging scripts.

Electron's `safeStorage` is the only credential store. macOS uses its asynchronous API, which may prompt for Keychain access; Windows (DPAPI / Credential Manager) and Linux use the synchronous API. Never add a plaintext fallback.

The Windows and Linux builds create a notification-area icon. Closing or minimizing the window while enabled schedules exist hides it to the tray and leaves `Schedules` running in the main process; quitting from the tray stops it. macOS keeps the Dock behaviour. `SCHEDULES.md` documents the user-visible contract, so update it when this changes.

## Windows 11 build and packaging

The Windows pipeline mirrors `package:mac` / `package-dmg` and runs entirely on Windows PowerShell, Command Prompt and Node.js 22+ (no POSIX shell, `unzip` or `curl`):

- `npm run setup:assets` — verifies the sentence-encoder model files. The Composio CLI helper is skipped on win32 because Composio does not publish a Windows binary; the app falls back to a Composio project key in Settings → Connections.
- `npm run icons:win` — writes `assets/gratis.ico` from `assets/gratis-icon.png` (gitignored, generated). `scripts/make-ico.mjs` decodes the PNG, area-averages it to 16/24/32/48/64/128/256 px, and packs one 32-bit BMP frame per size using only Node built-ins. BMP frames are used because legacy GDI+ consumers (including `System.Drawing`) cannot decode PNG-compressed ICO frames.
- `npm run build:win` — runs `icons:win` then `electron-builder --win --x64 --dir`, producing the unpacked app in `dist/win-unpacked` for quick inspection and desktop regressions.
- `npm run dist:win` — runs `icons:win` then `electron-builder --win --x64`, producing `dist/Gratis-Core-<version>-win-x64.exe` (NSIS installer) and `dist/Gratis-Core-<version>-win-x64.zip` (portable zip).

The electron-builder configuration lives in the `build` field of `package.json` (app id and product name come from `edition.json` values). Points that future changes must preserve:

- `asarUnpack` keeps every native binary outside `app.asar`: `**/*.node`, `onnxruntime-node` (its `.node` binding must stay next to its `onnxruntime.dll` and friends), `@img/sharp-win32-x64`, and `@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`. Windows Defender and Electron both refuse to load executables or loadable modules from inside the archive.
- `extraResources` copies `assets/models` to `resources/models` (read by `main.cjs` at `process.resourcesPath/models`), and matches `assets/composio-cli/**/*` with a filter that matches nothing when the helper is absent, so the build never fails on Windows where that asset does not exist.
- `files` includes `edition.json` (required by `require('../edition.json')` in `main.cjs`), excludes `assets/**` from the asar, and excludes `@openai/codex-win32-x64` and the non-Windows `onnxruntime-node` platform binaries exactly like the mac packaging excludes `@openai/codex-darwin-arm64` (Codex is resolved from `PATH`).
- `npmRebuild` stays `false`: the native modules ship prebuilt N-API binaries and have no source build.
- Code signing is optional; set `CSC_LINK` / `CSC_KEY_PASSWORD` for electron-builder to sign `Gratis Core.exe` and `claude.exe`. Unsigned installers trigger SmartScreen warnings.

CI runs the Windows layer in the `windows` job of `.github/workflows/ci.yml` (unpacked build + `test/package-edition.mjs` with `GRATIS_TEST_APP`), and `release.yml` has a `win` job that uploads the NSIS installer and portable zip alongside the Mac dmg artifacts.


## Cloud service checks

```sh
cd packages/cloud
npm ci
npm run typecheck
npx vitest run
```

These checks generate local type declarations and use test doubles. Deploy only to an account you control, after configuring the authentication secrets and reviewing expected costs.

The Mac packaging command signs nested code and seals the final bundle, then verifies it. This is ad-hoc integrity signing, not Developer ID signing or notarization. The app may still require explicit macOS approval. Existing `dist`/`release` output is excluded from the package. Settings shows the exact build identity for bug reports.

GUI tests use a shared launcher that requires a profile under the system temporary directory and passes Chromium’s mock-keychain flag on macOS. They must not access the installed app’s login-keychain item. Production encryption is unchanged; mock-keychain tests do not establish real Keychain permission or notarization behavior.

Linux GUI tests require an unlocked Secret Service. Release CI creates a disposable keyring inside its own D-Bus session and verifies it before launching the app; it does not enable the plaintext storage fallback.
