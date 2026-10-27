'use strict';
// Encryption for the secrets ScaleMax saves (provider keys, connector and OAuth tokens, MCP env
// and header values), with the same three methods as Electron's safeStorage, so the stores take
// either. safeStorage keeps its key in the macOS keychain, and macOS asks to allow the app again
// whenever its code signature changes, which for an ad-hoc signed app is every new build. This
// keeps a random 256-bit key in <userData>/secrets.key instead, readable only by this account:
// the state file still never holds a secret in the clear, and the model's sandboxed commands
// cannot read either file (lib/sandbox.cjs blocks the app's data), but unlike the keychain any
// program running as this user can read both.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// A value is "SMK1", a 12-byte nonce and a 16-byte tag, then the AES-256-GCM ciphertext.
const MAGIC = Buffer.from('SMK1');
// safeStorage's own values (saved by versions up to 1.0.0-beta.4) start with "v10" and cannot be
// read without the keychain; decryptString says so with the code SECRET_IN_KEYCHAIN.
const KEYCHAIN_PREFIX = Buffer.from('v10');
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES + TAG_BYTES;

function createLocalSecrets({ keyFile, io = fs, randomBytes = crypto.randomBytes, now = Date.now }) {
  let key = null;

  function readKey() {
    let existing;
    try {
      existing = io.readFileSync(keyFile);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (existing.length === KEY_BYTES) {
      try { io.chmodSync(keyFile, 0o600); } catch { /* keep using it */ }
      return existing;
    }
    // A key of the wrong size cannot decrypt anything: keep it aside and start a new one.
    io.renameSync(keyFile, `${keyFile}.damaged-${now()}`);
    return null;
  }

  function loadKey() {
    if (key) return key;
    key = readKey();
    if (key) return key;
    io.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    const fresh = randomBytes(KEY_BYTES);
    try {
      io.writeFileSync(keyFile, fresh, { mode: 0o600, flag: 'wx' });
      key = fresh;
    } catch (error) {
      // Another copy of the app made it first: use that one.
      if (error.code !== 'EEXIST') throw error;
      key = readKey();
      if (!key) throw new Error('The secrets key could not be read.');
    }
    return key;
  }

  return {
    isEncryptionAvailable() {
      try {
        loadKey();
        return true;
      } catch {
        return false;
      }
    },

    encryptString(plainText) {
      if (typeof plainText !== 'string') throw new TypeError('Only text can be encrypted.');
      const iv = randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
      const body = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
      return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
    },

    decryptString(encrypted) {
      if (Buffer.isBuffer(encrypted) && encrypted.subarray(0, KEYCHAIN_PREFIX.length).equals(KEYCHAIN_PREFIX)) {
        throw Object.assign(new Error('This value was saved with the macOS keychain, which ScaleMax IDE no longer uses.'),
          { code: 'SECRET_IN_KEYCHAIN' });
      }
      if (!Buffer.isBuffer(encrypted) || encrypted.length < HEADER_BYTES
        || !encrypted.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error('This value was not saved by this version of ScaleMax IDE.');
      }
      const iv = encrypted.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
      const tag = encrypted.subarray(MAGIC.length + IV_BYTES, HEADER_BYTES);
      const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted.subarray(HEADER_BYTES)), decipher.final()]).toString('utf8');
    },
  };
}

module.exports = { createLocalSecrets };
