// Windows credential protection coverage: Electron's synchronous safeStorage
// path (DPAPI / Windows Credential Manager) is exercised both with a mock and,
// on Windows hosts, against the real System.Security.ProtectedData API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createSecureStorageAccess } from '../src/secure-storage.mjs';

function mockWindowsSafeStorage() {
  const key = randomBytes(32);
  return {
    isAsyncEncryptionAvailable: () => false,
    isEncryptionAvailable: () => true,
    encryptString(text) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const payload = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), payload]);
    },
    decryptString(bytes) {
      const raw = Buffer.from(bytes), decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

function powershell(script) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 }).trim();
}

function dpapiProtect(text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String('${b64}'); [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($b,[byte[]]@(),[System.Security.Cryptography.DataProtectionScope]::CurrentUser))`;
  return Buffer.from(powershell(script), 'base64');
}

function dpapiUnprotect(bytes) {
  const b64 = Buffer.from(bytes).toString('base64');
  const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String('${b64}'); [Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect($b,[byte[]]@(),[System.Security.Cryptography.DataProtectionScope]::CurrentUser))`;
  return powershell(script);
}

test('win32 uses the synchronous encryptor and round-trips a vault key', async () => {
  const storage = mockWindowsSafeStorage();
  const access = createSecureStorageAccess(storage, { platform: 'win32' });
  const secret = 'vault-key-qa-' + randomBytes(8).toString('hex');
  const encrypted = await access.encrypt(secret);
  assert.ok(Buffer.isBuffer(encrypted));
  assert.notEqual(encrypted.toString('utf8'), secret);
  assert.equal(await access.decrypt(encrypted), secret);
  const wrapped = await access.keyring.wrapKey(secret);
  const unwrapped = await access.keyring.unwrapKey(wrapped);
  assert.equal(typeof unwrapped === 'string' ? unwrapped : unwrapped.value, secret);
  assert.equal(unwrapped.rewrap, false);
});

test('a failed Windows unlock latches the locked state with a Credential Manager hint', async () => {
  const storage = {
    isAsyncEncryptionAvailable: () => false,
    isEncryptionAvailable: () => true,
    encryptString: () => { throw new Error('DPAPI unavailable'); },
    decryptString: () => { throw new Error('DPAPI unavailable'); },
  };
  const access = createSecureStorageAccess(storage, { platform: 'win32' });
  await assert.rejects(access.encrypt('x'), /Credential Manager/);
  assert.equal(access.locked, true);
  await assert.rejects(access.decrypt(Buffer.from('x')), error => error.code === 'GRATIS_STORAGE_LOCKED');
});

test('real Windows DPAPI round-trip through createSecureStorageAccess', { skip: process.platform !== 'win32' }, async () => {
  const access = createSecureStorageAccess({
    isEncryptionAvailable: () => true,
    encryptString: dpapiProtect,
    decryptString: dpapiUnprotect,
  }, { platform: 'win32' });
  const secret = 'gratis-qa-dpapi-' + randomBytes(8).toString('hex');
  const first = await access.encrypt(secret), second = await access.encrypt(secret);
  assert.ok(Buffer.isBuffer(first));
  assert.notEqual(first.toString('base64'), second.toString('base64')); // DPAPI salts each blob
  assert.equal(await access.decrypt(first), secret);
  const unwrapped = await access.keyring.unwrapKey(await access.keyring.wrapKey(secret));
  assert.equal(typeof unwrapped === 'string' ? unwrapped : unwrapped.value, secret);
});
