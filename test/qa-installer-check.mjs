// Verifies the packaged NSIS installer in a clean directory: silent install,
// clean startup, silent uninstall. Run after `npm run dist:win`.
import { readdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const report = { checks: [] };
const check = (name, status, detail) => { report.checks.push({ name, status, detail }); console.log(`[${status}] ${name}${detail ? ' — ' + detail : ''}`); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const dist = join(root, 'dist');
let installer;
try {
  const files = await readdir(dist);
  installer = files.find(file => /^Gratis-Core-.*-win-x64\.exe$/i.test(file));
  const zip = files.find(file => /\.zip$/i.test(file));
  check('installer artifacts present', installer && zip ? 'PASS' : 'FAIL', [installer, zip].filter(Boolean).join(', '));
  if (!installer) throw new Error('NSIS installer not found in dist/');
} catch (error) { check('installer artifacts present', 'FAIL', String(error.message)); }

if (installer) {
  const installDir = await mkdtemp(join(tmpdir(), 'gratis-qa-install-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'gratis-qa-install-data-'));
  const installerPath = join(dist, installer);
  try {
    // NSIS silent install; /D must be the last argument and unquoted.
    execFileSync(installerPath, ['/S', `/D=${installDir}`], { cwd: root, timeout: 180000, windowsHide: true });
    const entries = await readdir(installDir);
    check('silent install into clean directory', entries.length > 0 ? 'PASS' : 'FAIL', `${entries.length} entries`);
    const exe = entries.find(file => /^Gratis Core\.exe$/i.test(file));
    check('installed executable present', exe ? 'PASS' : 'FAIL', exe || entries.slice(0, 8).join(', '));

    if (exe) {
      const child = spawn(join(installDir, exe), [], {
        cwd: installDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GRATIS_DATA_DIR: dataDir, GRATIS_TEST_HIDDEN: '1' },
      });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      await wait(9000);
      const alive = child.exitCode === null && !child.killed;
      check('installed app starts without crashing', alive ? 'PASS' : 'FAIL', `exitCode=${child.exitCode} stderr=${stderr.slice(-800)}`);
      child.kill();
      await wait(1000);
    }

    const uninstaller = join(installDir, 'Uninstall Gratis Core.exe');
    try {
      await stat(uninstaller);
      execFileSync(uninstaller, ['/S'], { cwd: installDir, timeout: 180000, windowsHide: true });
      // NSIS copies its uninstaller to temp and exits immediately; the real
      // deletion is done by that copy, so poll rather than assume it is sync.
      let remaining = [];
      for (let attempt = 0; attempt < 30; attempt++) {
        await wait(500);
        remaining = await readdir(installDir).catch(() => []);
        if (!remaining.length) break;
      }
      check('silent uninstall removes installed files', remaining.length === 0 ? 'PASS' : 'WARN', `${remaining.length} entries remain: ${remaining.slice(0, 5).join(', ')}`);
    } catch (error) {
      check('silent uninstall', 'FAIL', String(error.message).slice(0, 500));
    }
  } catch (error) {
    check('installer flow', 'FAIL', String(error.stack || error).slice(0, 2500));
  } finally {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await rm(installDir, { recursive: true, force: true }).catch(() => {});
  }
}
console.log('\n[report] ' + report.checks.map(c => `${c.name}=${c.status}`).join(', '));
