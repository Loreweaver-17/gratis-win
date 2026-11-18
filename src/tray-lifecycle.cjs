// Pure decision helpers for the Windows notification-area (system tray)
// lifecycle. Kept separate from main.cjs so Windows close/minimize behaviour is
// unit-testable without launching Electron. main.cjs supplies the real Tray and
// BrowserWindow objects; this module only answers "what should happen?".
function enabledSchedules(items = []) {
  return (Array.isArray(items) ? items : []).filter(item => item && item.enabled);
}

function traySummary(items = []) {
  const active = enabledSchedules(items);
  if (!active.length) return 'No scheduled tasks';
  const next = Math.min(...active.map(item => item.nextRunAt).filter(Number.isFinite));
  return `${active.length} scheduled ${active.length === 1 ? 'task' : 'tasks'}${Number.isFinite(next) ? ` · next ${new Date(next).toLocaleString()}` : ''}`;
}

function trayTooltip(name, items = []) {
  const count = enabledSchedules(items).length;
  return count
    ? `${name} · ${count} scheduled ${count === 1 ? 'task' : 'tasks'} enabled`
    : `${name} · running in the notification area`;
}

// Hiding the window is only safe when it can be reopened: the Dock on macOS,
// the notification area on Windows/Linux. Schedules alone are not enough.
function shouldKeepRunningInBackground({ platform = process.platform, trayPresent = false, enabledCount = 0 } = {}) {
  return enabledCount > 0 && (platform === 'darwin' || trayPresent);
}

function windowCloseAction(options) {
  return shouldKeepRunningInBackground(options) ? 'hide' : 'shutdown';
}

// Windows users need a one-time hint that the app is still running.
function shouldDisplayBalloon({ platform = process.platform, trayPresent = false, hintShown = false } = {}) {
  return platform === 'win32' && trayPresent && !hintShown;
}

function trayMenuTemplate({ name, summary, onOpen, onQuit }) {
  return [
    { label: `Open ${name}`, click: onOpen },
    { label: summary, enabled: false },
    { type: 'separator' },
    { label: `Quit ${name}`, click: onQuit },
  ];
}

function trayEvents() {
  return ['click', 'double-click'];
}

module.exports = {
  enabledSchedules, traySummary, trayTooltip, shouldKeepRunningInBackground,
  windowCloseAction, shouldDisplayBalloon, trayMenuTemplate, trayEvents,
};
