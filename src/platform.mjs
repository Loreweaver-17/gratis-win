// Shared platform helpers. Desktop features must not assume a POSIX shell,
// ':'-separated PATH entries, or patches to the user's shell profile.
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const isWindows = process.platform === 'win32';
export const isMac = process.platform === 'darwin';

// Windows resolves executables through PATHEXT, so a bare name such as
// "composio" is stored as "composio.exe" while macOS and Linux use the name.
export function executableNames(name, platform = process.platform) {
  if (platform !== 'win32') return [name];
  const extensions = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';').map(extension => extension.trim().toLowerCase()).filter(Boolean);
  return [...new Set([name, ...extensions.map(extension => name + extension)])];
}

export function withExecutableExtension(file, platform = process.platform) {
  if (platform !== 'win32' || /\.(?:exe|cmd|bat|com)$/i.test(file)) return file;
  return `${file}.exe`;
}

// PATH is ';'-separated on Windows and case-insensitively named "Path".
export function searchPath(source = process.env, platform = process.platform) {
  const raw = platform === 'win32' ? source.Path ?? source.PATH ?? '' : source.PATH ?? '';
  return String(raw).split(platform === 'win32' ? ';' : ':').filter(Boolean);
}

// Environment for a spawn that must not inherit unrelated application
// secrets. Windows keeps its own variable names and adds the POSIX aliases
// that Node-based CLIs still read (HOME, USER, TMPDIR).
export function childEnvironment(source = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const env = {};
    for (const key of ['Path', 'PATHEXT', 'COMSPEC', 'SystemRoot', 'SystemDrive', 'windir', 'USERPROFILE', 'USERNAME',
      'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
      'PROGRAMW6432', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'SESSIONNAME', 'OS'])
      if (typeof source[key] === 'string') env[key] = source[key];
    if (!env.Path && typeof source.PATH === 'string') env.Path = source.PATH;
    if (!env.HOME) env.HOME = source.HOME || source.USERPROFILE || homedir();
    if (!env.USER) env.USER = source.USER || source.USERNAME || '';
    if (!env.TMPDIR) env.TMPDIR = source.TMPDIR || source.TEMP || source.TMP || '';
    if (!env.LANG) env.LANG = source.LANG || 'en_US.UTF-8';
    return env;
  }
  const env = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH'])
    if (typeof source[key] === 'string') env[key] = source[key];
  if (!env.HOME) env.HOME = homedir();
  return env;
}

export async function findExecutable(name, { platform = process.platform, extraDirectories = [] } = {}) {
  const directories = [...extraDirectories, ...searchPath(process.env, platform)];
  for (const file of executableNames(name, platform))
    for (const directory of directories) {
      const candidate = join(directory, file);
      // Windows treats access(X_OK) as an existence check, so directories must
      // be excluded explicitly.
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {}
    }
  return null;
}

export function keyStoreName(platform = process.platform) {
  if (platform === 'win32') return 'Windows Credential Manager (DPAPI)';
  if (platform === 'darwin') return 'your macOS keychain';
  return 'your operating-system keyring';
}
