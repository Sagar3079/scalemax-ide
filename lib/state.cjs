'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_BYTES = 12 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_ENTRIES = 100_000;
const PUBLIC_KEYS = new Set([
  'tasks', 'settings', 'automations', 'skillStates', 'connectorStates', 'currentTaskId',
]);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validate(root) {
  if (!isRecord(root)) throw new TypeError('State root must be a JSON object.');
  const seen = new Set();
  const pending = [{ value: root, depth: 0 }];
  let entries = 0;
  let bytes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop();
    if (depth > MAX_DEPTH) throw new RangeError('State JSON nesting exceeds the limit.');
    if (++entries > MAX_ENTRIES) throw new RangeError('State JSON has too many entries.');
    if (typeof value === 'string') bytes += Buffer.byteLength(value);
    else if (value === null || typeof value === 'boolean') bytes += 5;
    else if (typeof value === 'number' && Number.isFinite(value)) bytes += 8;
    else if (Array.isArray(value) || isRecord(value)) {
      if (seen.has(value)) throw new TypeError('State JSON cannot contain cycles or shared objects.');
      seen.add(value);
      const keys = Reflect.ownKeys(value);
      if (keys.length + entries + pending.length > MAX_ENTRIES) {
        throw new RangeError('State JSON has too many entries.');
      }
      if (Array.isArray(value) && keys.length !== value.length + 1) {
        throw new TypeError('State arrays must not be sparse.');
      }
      for (const key of keys) {
        if (Array.isArray(value) && key === 'length') continue;
        if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)) {
          throw new TypeError('State JSON contains a forbidden key.');
        }
        if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) {
          throw new TypeError('State arrays must contain only indexed values.');
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError('State JSON must contain only enumerable data properties.');
        }
        bytes += Buffer.byteLength(key) + 4;
        pending.push({ value: descriptor.value, depth: depth + 1 });
      }
    } else {
      throw new TypeError('State values must be finite JSON data.');
    }
    if (bytes > MAX_BYTES) throw new RangeError('State exceeds the 12 MB limit.');
  }

  for (const key of PUBLIC_KEYS) {
    if (!Object.hasOwn(root, key)) continue;
    const value = root[key];
    if (key === 'tasks' || key === 'automations') {
      if (!Array.isArray(value)) throw new TypeError(`${key} must be an array.`);
    } else if (key === 'currentTaskId') {
      if (value !== null && (typeof value !== 'string' || value.length > 512)) {
        throw new TypeError('currentTaskId must be null or a string of at most 512 characters.');
      }
    } else if (!isRecord(value)) {
      throw new TypeError(`${key} must be a JSON object.`);
    }
  }
}

function requirePublicKey(key) {
  if (typeof key !== 'string' || !PUBLIC_KEYS.has(key)) {
    throw new TypeError('State key is not publicly accessible.');
  }
}

function createStore(filename, { io = fs } = {}) {
  if (typeof filename !== 'string' || !filename) throw new TypeError('A state filename is required.');

  function readAll() {
    let text;
    try {
      const stat = io.statSync(filename);
      if (!stat.isFile()) throw new TypeError('State path must be a regular file.');
      if (stat.size > MAX_BYTES) throw new RangeError('State exceeds the 12 MB limit.');
      text = io.readFileSync(filename);
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
    if (Buffer.byteLength(text) > MAX_BYTES) throw new RangeError('State exceeds the 12 MB limit.');
    let data;
    try {
      data = JSON.parse(text.toString('utf8'));
    } catch {
      throw new Error('State file contains corrupt JSON; the original was not changed.');
    }
    validate(data);
    return data;
  }

  function update(mutator) {
    if (typeof mutator !== 'function') throw new TypeError('A synchronous state mutator is required.');
    const draft = readAll();
    const result = mutator(draft);
    const next = result === undefined ? draft : result;
    validate(next);
    // Legacy identity data is never carried into a newly written state file.
    delete next.user;
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw new RangeError('State exceeds the 12 MB limit.');
    const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
    let fd;
    try {
      fd = io.openSync(temporary, 'wx', 0o600);
      io.fchmodSync(fd, 0o600);
      io.writeFileSync(fd, serialized, 'utf8');
      io.fsyncSync(fd);
      io.closeSync(fd);
      fd = undefined;
      io.renameSync(temporary, filename);
    } catch {
      if (fd !== undefined) {
        try { io.closeSync(fd); } catch { /* Preserve the original write failure. */ }
      }
      // Failed temporary files stay private; never delete or overwrite the original.
      throw new Error('State could not be saved; the original was not changed.');
    }
    return JSON.parse(serialized);
  }

  readAll();
  return {
    get(key) {
      requirePublicKey(key);
      const data = readAll();
      return Object.hasOwn(data, key) ? data[key] : undefined;
    },
    set(key, value) {
      requirePublicKey(key);
      const result = update((draft) => { draft[key] = value; });
      return result[key];
    },
    readAll,
    update,
  };
}

module.exports = { createStore };
