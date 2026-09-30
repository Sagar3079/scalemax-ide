'use strict';
// Secret files in a project stay out of the model's (and the window's) reach: not listed, not
// readable. Committed templates that only name the variables stay readable.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspace } = require('../lib/workspace.cjs');

const HIDDEN = [
  '.env', '.env.local', '.env.production', '.envrc', '.dev.vars', '.pgpass', 'terraform.tfstate', 'terraform.tfstate.backup',
  'prod.tfvars', 'AuthKey_ABC123.p8', 'release.jks', 'server.ppk', 'vault.kdbx', 'service-account.json', 'id_ed25519', 'tls.pem',
];
const SHOWN = ['.env.example', '.env.sample', '.env.template', 'README.md', 'environment.ts', 'account.json'];

test('secret files are neither listed nor readable; templates without values are', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-secrets-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of [...HIDDEN, ...SHOWN]) fs.writeFileSync(path.join(root, name), `${name}=value\n`);
  const workspace = createWorkspace({ approve: async () => true });
  t.after(() => workspace.dispose());
  await workspace.select(root);
  const listed = (await workspace.list('')).entries.map((entry) => entry.name).sort();
  assert.deepEqual(listed, [...SHOWN].sort());
  for (const name of HIDDEN) await assert.rejects(workspace.read(name), (error) => Boolean(error?.code), name);
  for (const name of SHOWN) assert.equal((await workspace.read(name)).content, `${name}=value\n`, name);
});
