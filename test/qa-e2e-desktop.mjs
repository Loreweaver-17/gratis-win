// Pre-launch E2E checklist for the Windows 11 port (demo + live status,
// group chat, semantic memory, tray/schedule, checkpoint restore, leak probe).
// Run: node test/qa-e2e-desktop.mjs
// Writes qa-e2e-report.json. Uses the isolated Electron fixture only.
import { launchTestApp } from './electron-fixture.mjs';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initialState } from '../src/store.mjs';

const root = process.cwd();
const dataDir = await mkdtemp(join(tmpdir(), 'gratis-qa-e2e-'));
const report = { startedAt: new Date().toISOString(), dataDir, checks: [], errors: [], memory: {} };
const check = (name, status, detail) => { report.checks.push({ name, status, detail }); console.log(`[${status}] ${name}${detail ? ' — ' + detail : ''}`); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await wait(500); }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

const state = initialState();
const lead = state.bots[0];
lead.promptMode = 'manual'; lead.promptGenerated = true;
const writer = { ...lead, id: 'qa-writer', name: 'Editor' };
const planner = { ...lead, id: 'qa-planner', name: 'Planner' };
state.bots.push(writer, planner);
await writeFile(join(dataDir, 'workspace.json'), JSON.stringify(state));
let groupId;

let app, page;
try {
  app = await launchTestApp({ directory: dataDir, projectDir: root });
  page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push('pageerror: ' + error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push('console: ' + message.text()); });
  await page.locator('#new-bot').waitFor({ timeout: 30000 });

  const edition = await page.evaluate(() => window.orbit.edition());
  check('demo launch on Windows', edition.platform === 'win32' ? 'PASS' : 'FAIL', JSON.stringify(edition));
  report.memory.mainStartMB = await app.evaluate(() => Math.round(process.memoryUsage().heapUsed / 1048576));
  report.memory.rendererStartMB = await page.evaluate(() => Math.round((performance.memory?.usedJSHeapSize || 0) / 1048576));

  // --- group chat with @everyone in demo mode -------------------------------
  // A real group must be created through the app so per-member child threads
  // exist; seeding group state alone would make peer delivery fail.
  const created = await page.evaluate(ids => window.orbit.createThread({ botIds: ids }), [lead.id, writer.id, planner.id]);
  groupId = created.activeConversationId;
  check('multi-bot group created', created.conversations?.find(c => c.id === groupId)?.participantIds?.length === 3 ? 'PASS' : 'FAIL', String(groupId));
  await page.evaluate(({ conversationId }) => window.orbit.send({ conversationId, text: '@everyone report in for QA.' }), { conversationId: groupId });
  const snapshot = await poll(async () => {
    const s = await page.evaluate(() => window.orbit.snapshot());
    const c = s.conversations.find(item => item.id === groupId);
    const replies = c?.messages?.filter(m => m.role === 'assistant') || [];
    return replies.length >= 3 ? { bots: [...new Set(replies.map(m => m.botId))], count: replies.length } : null;
  }, 45000, 'group replies');
  check('@everyone reaches all bots (demo)', snapshot.bots.length === 3 ? 'PASS' : 'FAIL', JSON.stringify(snapshot));

  // --- semantic memory ------------------------------------------------------
  const semantic = await poll(async () => {
    const view = await page.evaluate(({ conversationId }) => window.orbit.memoryView({ conversationId }), { conversationId: groupId });
    return view.semantic === 'ready' ? view.semantic : null;
  }, 30000, 'semantic encoder readiness').catch(error => 'unavailable: ' + error.message);
  check('semantic encoder starts with CPU fallback', typeof semantic === 'string' && semantic.startsWith('ready') ? 'PASS' : 'FAIL', String(semantic));
  await page.evaluate(({ conversationId }) => window.orbit.memoryAdd({
    conversationId, key: 'qa_passphrase', title: 'QA passphrase', content: 'The QA passphrase is blue-orange-42.',
    category: 'fact', scope: 'profile', stated: true, quote: 'The QA passphrase is blue-orange-42.',
  }), { conversationId: groupId });
  const recalled = await poll(async () => {
    const rows = await page.evaluate(({ conversationId }) => window.orbit.memorySearch({ conversationId, query: 'QA passphrase' }), { conversationId: groupId });
    return rows.some(row => String(row.content).includes('blue-orange-42')) ? rows.length : null;
  }, 30000, 'memory recall');
  check('semantic memory saved and retrieved', recalled > 0 ? 'PASS' : 'FAIL', `${recalled} rows`);

  // --- live-mode provider status (credentials are intentionally not present) -
  const live = await page.evaluate(async () => ({
    claude: await window.orbit.claudeStatus(), codex: await window.orbit.codexStatus(),
  }));
  check('live-mode provider availability', 'INFO', JSON.stringify(live).slice(0, 400));

  // --- tray lifecycle + one-minute cron schedule ----------------------------
  const schedule = await page.evaluate(({ conversationId }) => window.orbit.schedulesCreate({
    conversationId, title: 'QA minute heartbeat', prompt: 'Say QA heartbeat.',
    timing: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
  }), { conversationId: groupId });
  check('one-minute schedule created', schedule?.timing?.expression === '* * * * *' ? 'PASS' : 'FAIL', JSON.stringify(schedule?.timing || {}));
  const closed = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.close();
    return { pid: process.pid };
  });
  await wait(500);
  const trayState = await app.evaluate(({ BrowserWindow }) => ({
    windows: BrowserWindow.getAllWindows().length,
    visible: BrowserWindow.getAllWindows()[0]?.isVisible(),
    destroyed: BrowserWindow.getAllWindows()[0]?.isDestroyed(),
  }));
  check('close hides window to tray without quitting', trayState.windows === 1 && trayState.visible === false && trayState.destroyed === false ? 'PASS' : 'FAIL', JSON.stringify({ ...closed, ...trayState }));

  const ran = await poll(async () => {
    const s = await page.evaluate(() => window.orbit.snapshot());
    const c = s.conversations.find(item => item.id === groupId);
    const marker = c?.messages?.find(m => m.sourceScheduleRunId);
    return marker ? { id: marker.sourceScheduleRunId, at: marker.createdAt } : null;
  }, 100000, 'scheduled run').catch(error => ({ error: error.message }));
  const stillHidden = await app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0]?.isVisible());
  check('1-minute task ran without reopening window', ran.id && stillHidden ? 'PASS' : 'FAIL', JSON.stringify({ ran, stillHidden }));

  // --- checkpoint + restore -------------------------------------------------
  const checkpoint = await poll(async () => {
    try { return await page.evaluate(() => window.orbit.recoveryCheckpoint()) || null; }
    catch (error) { return /Stop active responses/.test(error.message) ? null : error; }
  }, 30000, 'idle state for checkpoint').catch(error => error);
  check('checkpoint created from Settings action', checkpoint && !checkpoint.message ? 'PASS' : 'FAIL', String(checkpoint).slice(0, 300));
  report.memory.mainEndMB = await app.evaluate(() => Math.round(process.memoryUsage().heapUsed / 1048576));
  report.memory.rendererEndMB = await page.evaluate(() => Math.round((performance.memory?.usedJSHeapSize || 0) / 1048576));
  report.memory.mainDeltaMB = report.memory.mainEndMB - report.memory.mainStartMB;
  report.memory.rendererDeltaMB = report.memory.rendererEndMB - report.memory.rendererStartMB;
  check('no runaway heap growth', report.memory.mainDeltaMB < 120 && report.memory.rendererDeltaMB < 120 ? 'PASS' : 'WARN', JSON.stringify(report.memory));

  await app.close();
  app = null;
  if (checkpoint) {
    const source = typeof checkpoint === 'string' ? checkpoint : checkpoint.directory || checkpoint.path;
    if (source) {
      try {
        const output = execFileSync(process.execPath, ['scripts/workspace-recovery.mjs', 'restore', dataDir, source],
          { cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true });
        check('checkpoint restore script', /restored/i.test(output) ? 'PASS' : 'FAIL', output.trim().slice(0, 300));
        app = await launchTestApp({ directory: dataDir, projectDir: root });
        page = await app.firstWindow();
        await page.locator('#new-bot').waitFor({ timeout: 30000 });
        const restored = await page.evaluate(() => window.orbit.snapshot());
        check('clean startup after restore', restored.bots?.length === 3 && restored.conversations?.some(c => c.participantIds?.length === 3) ? 'PASS' : 'FAIL', `bots=${restored.bots?.length}`);
      } catch (error) { check('checkpoint restore script', 'FAIL', String(error.stack || error).slice(0, 2000)); }
    }
  }
} catch (error) {
  check('E2E harness', 'FAIL', String(error.stack || error).slice(0, 4000));
} finally {
  if (app) await app.close().catch(() => {});
  report.finishedAt = new Date().toISOString();
  await writeFile(join(root, 'qa-e2e-report.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  console.log('\n[report] qa-e2e-report.json · checks: ' + report.checks.map(c => `${c.name}=${c.status}`).join(', '));
}

