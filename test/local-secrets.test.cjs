'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLocalSecrets } = require('../lib/local-secrets.cjs');

const ROOT = path.join(__dirname, '..');

function tempKeyFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scalemax-secrets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'profile', 'secrets.key');
}

test('encrypts and decrypts text, with a new nonce every time and no plaintext in the value', (t) => {
  const secrets = createLocalSecrets({ keyFile: tempKeyFile(t) });
  assert.equal(secrets.isEncryptionAvailable(), true);
  const first = secrets.encryptString('sk-test-local-123456');
  const second = secrets.encryptString('sk-test-local-123456');
  assert.ok(Buffer.isBuffer(first));
  assert.equal(first.subarray(0, 4).toString(), 'SMK1');
  assert.notDeepEqual(first, second);
  assert.equal(first.includes('sk-test-local'), false);
  assert.equal(secrets.decryptString(first), 'sk-test-local-123456');
  assert.equal(secrets.decryptString(secrets.encryptString('')), '');
  assert.equal(secrets.decryptString(secrets.encryptString('ключ 🔑')), 'ключ 🔑');
  assert.throws(() => secrets.encryptString(42), TypeError);
});

test('keeps one key in a file only this account can read, and reuses it after a restart', (t) => {
  const keyFile = tempKeyFile(t);
  const value = createLocalSecrets({ keyFile }).encryptString('token');
  assert.equal(fs.statSync(keyFile).size, 32);
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(createLocalSecrets({ keyFile }).decryptString(value), 'token');
  // A key file someone opened up is closed again.
  fs.chmodSync(keyFile, 0o644);
  createLocalSecrets({ keyFile }).decryptString(value);
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
});

test('a value from another key, a changed value or a foreign value is refused', (t) => {
  const secrets = createLocalSecrets({ keyFile: tempKeyFile(t) });
  const other = createLocalSecrets({ keyFile: tempKeyFile(t) });
  const value = secrets.encryptString('token');
  assert.throws(() => other.decryptString(value));
  const changed = Buffer.from(value);
  changed[changed.length - 1] ^= 1;
  assert.throws(() => secrets.decryptString(changed));
  assert.throws(() => secrets.decryptString(Buffer.from('enc:token')), /not saved by this version/);
  assert.throws(() => secrets.decryptString('token'), /not saved by this version/);
});

test('a value saved with the keychain by beta 4 or earlier is named as such', (t) => {
  const secrets = createLocalSecrets({ keyFile: tempKeyFile(t) });
  const keychainValue = Buffer.concat([Buffer.from('v10'), Buffer.alloc(32, 7)]);
  assert.throws(() => secrets.decryptString(keychainValue), (error) => error.code === 'SECRET_IN_KEYCHAIN');
});

test('a damaged key file is set aside and replaced; an unreadable one makes encryption unavailable', (t) => {
  const keyFile = tempKeyFile(t);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, 'short');
  const secrets = createLocalSecrets({ keyFile, now: () => 123 });
  assert.equal(secrets.decryptString(secrets.encryptString('token')), 'token');
  assert.equal(fs.readFileSync(`${keyFile}.damaged-123`, 'utf8'), 'short');
  assert.equal(fs.statSync(keyFile).size, 32);

  const failing = { ...fs, readFileSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
  const locked = createLocalSecrets({ keyFile, io: failing });
  assert.equal(locked.isEncryptionAvailable(), false);
});

test('two copies starting together end up with the same key', (t) => {
  const keyFile = tempKeyFile(t);
  const winner = createLocalSecrets({ keyFile });
  const value = winner.encryptString('token');
  // The second copy found no file, then lost the race to create it.
  let reads = 0;
  const racing = {
    ...fs,
    readFileSync(file, ...rest) {
      reads += 1;
      if (reads === 1) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return fs.readFileSync(file, ...rest);
    },
  };
  assert.equal(createLocalSecrets({ keyFile, io: racing }).decryptString(value), 'token');
});

test('the app never opens the keychain: its stores get the local secrets and Chromium the mock keychain', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.doesNotMatch(main.split('\n')[0], /safeStorage/);
  assert.match(main, /app\.commandLine\.appendSwitch\('use-mock-keychain'\)/);
  const stores = main.match(/safeStorage: secrets,/g) || [];
  assert.equal(stores.length, 3);
  assert.doesNotMatch(main.replace(/safeStorage: secrets,/g, ''), /safeStorage/);
});
