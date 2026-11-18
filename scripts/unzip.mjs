// Minimal cross-platform ZIP extractor. The previous setup script shelled out
// to the macOS/Linux `unzip` binary; this keeps `npm run setup:assets` working
// on Windows without adding a dependency. Archives are already verified against
// a pinned SHA-256 before extraction, so only ZIP structural errors and unsafe
// paths are rejected here.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const MAX_ENTRIES = 20000;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const UNIX_SYMLINK = 0o120000;

function endOfCentralDirectory(buffer) {
  const oldest = Math.max(0, buffer.length - 65558);
  for (let offset = buffer.length - 22; offset >= oldest; offset--)
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  throw new Error('The downloaded archive is not a valid ZIP file.');
}

function readEntries(buffer) {
  const end = endOfCentralDirectory(buffer);
  const total = buffer.readUInt16LE(end + 10);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (total === 0xffff || directoryOffset === 0xffffffff) throw new Error('The downloaded archive needs ZIP64 support.');
  if (total > MAX_ENTRIES) throw new Error('The downloaded archive contains too many files.');
  const entries = [];
  let cursor = directoryOffset;
  for (let index = 0; index < total; index++) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_ENTRY) throw new Error('The downloaded archive has a damaged file list.');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'latin1');
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset, externalAttributes });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function segments(name, platform) {
  const normalized = name.replaceAll('\\', '/');
  if (isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/'))
    throw new Error('Unsafe archive path.');
  const parts = normalized.split('/').filter(part => part && part !== '.');
  if (!parts.length || parts.some(part => part === '..' || (platform === 'win32' && /[<>:"|?*\0]/.test(part))))
    throw new Error('Unsafe archive path.');
  return parts;
}

export async function extractZip(archive, destination, { platform = process.platform } = {}) {
  const buffer = await readFile(archive);
  const entries = readEntries(buffer);
  const root = resolve(destination);
  let total = 0;
  for (const entry of entries) {
    if (entry.name.endsWith('/') || entry.name.endsWith('\\')) continue;
    const mode = entry.externalAttributes >>> 16;
    if ((mode & 0o170000) === UNIX_SYMLINK) throw new Error('Archives with symbolic links are not supported.');
    if (![0, 8].includes(entry.method)) throw new Error('The downloaded archive uses an unsupported compression method.');
    total += entry.uncompressedSize;
    if (total > MAX_UNCOMPRESSED_BYTES) throw new Error('The downloaded archive is too large to install.');
    const target = resolve(root, ...segments(entry.name, platform));
    if (target !== root && !target.startsWith(root + sep)) throw new Error('Unsafe archive path.');
    const header = entry.localOffset;
    if (buffer.readUInt32LE(header) !== LOCAL_FILE_HEADER) throw new Error('The downloaded archive has a damaged file entry.');
    const start = header + 30 + buffer.readUInt16LE(header + 26) + buffer.readUInt16LE(header + 28);
    const compressed = buffer.subarray(start, start + entry.compressedSize);
    const bytes = entry.method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed);
    if (bytes.length !== entry.uncompressedSize) throw new Error('The downloaded archive failed verification.');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { mode: mode & 0o111 ? 0o755 : 0o600 });
  }
  return entries.filter(entry => !entry.name.endsWith('/') && !entry.name.endsWith('\\')).length;
}

export function listZipEntries(buffer) {
  return readEntries(buffer).map(entry => entry.name);
}
