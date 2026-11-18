// System Tray lifecycle coverage for Windows 11. The decisions live in the
// pure helper used by src/main.cjs, so no GUI is required to test them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enabledSchedules, traySummary, trayTooltip, shouldKeepRunningInBackground,
  windowCloseAction, shouldDisplayBalloon, trayMenuTemplate, trayEvents,
} from '../src/tray-lifecycle.cjs';

const schedule = (nextRunAt, enabled = true) => ({ enabled, nextRunAt });

test('Windows close hides to tray only when a schedule is enabled and the icon exists', () => {
  assert.equal(shouldKeepRunningInBackground({ platform: 'win32', trayPresent: true, enabledCount: 1 }), true);
  assert.equal(windowCloseAction({ platform: 'win32', trayPresent: true, enabledCount: 1 }), 'hide');
  assert.equal(windowCloseAction({ platform: 'win32', trayPresent: false, enabledCount: 1 }), 'shutdown');
  assert.equal(windowCloseAction({ platform: 'win32', trayPresent: true, enabledCount: 0 }), 'shutdown');
  assert.equal(windowCloseAction({ platform: 'darwin', trayPresent: false, enabledCount: 1 }), 'hide');
});

test('one-time Windows balloon hint fires only on first hide with a tray icon', () => {
  assert.equal(shouldDisplayBalloon({ platform: 'win32', trayPresent: true, hintShown: false }), true);
  assert.equal(shouldDisplayBalloon({ platform: 'win32', trayPresent: true, hintShown: true }), false);
  assert.equal(shouldDisplayBalloon({ platform: 'win32', trayPresent: false, hintShown: false }), false);
  assert.equal(shouldDisplayBalloon({ platform: 'darwin', trayPresent: true, hintShown: false }), false);
});

test('tray summary and tooltip report schedules and next run time', () => {
  assert.equal(traySummary([]), 'No scheduled tasks');
  assert.equal(traySummary([schedule(0, false)]), 'No scheduled tasks');
  assert.equal(enabledSchedules([schedule(1000), schedule(0, false)]).length, 1);
  assert.match(traySummary([schedule(Date.UTC(2030, 0, 1))]), /^1 scheduled task · next /);
  assert.match(traySummary([schedule(1000), schedule(2000)]), /^2 scheduled tasks/);
  assert.equal(trayTooltip('Gratis Core', []), 'Gratis Core · running in the notification area');
  assert.equal(trayTooltip('Gratis Core', [schedule(1000)]), 'Gratis Core · 1 scheduled task enabled');
});

test('tray wiring uses click/double-click to reopen and menu actions to open/quit', () => {
  assert.deepEqual(trayEvents(), ['click', 'double-click']);
  let opened = 0, quit = 0;
  const template = trayMenuTemplate({ name: 'Gratis Core', summary: '1 scheduled task', onOpen: () => opened++, onQuit: () => quit++ });
  assert.equal(template[0].label, 'Open Gratis Core');
  assert.equal(template[1].label, '1 scheduled task');
  assert.equal(template[2].type, 'separator');
  assert.equal(template[3].label, 'Quit Gratis Core');
  template[0].click(); template[3].click();
  assert.equal(opened, 1);
  assert.equal(quit, 1);
  assert.equal(template[1].enabled, false);
});
