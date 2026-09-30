import test from 'node:test';
import assert from 'node:assert/strict';
import { MCP_PRESETS, PRESET_GROUPS, presetCommand, presetServer } from '../src/mcp-presets.js';
import { MCP_LISTING_NAMES } from '../src/mcp-directory.js';

test('presets are unique, grouped, and well-formed', () => {
  const ids = MCP_PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length);
  const groups = new Set(PRESET_GROUPS.map(([group]) => group));
  for (const preset of MCP_PRESETS) {
    assert.ok(groups.has(preset.group), preset.id);
    assert.ok(preset.name && preset.description, preset.id);
    if (preset.url) assert.equal(new URL(preset.url).protocol, 'https:', preset.id);
    if (preset.group === 'local') {
      assert.ok(['npx', 'uvx'].includes(preset.command), preset.id);
      assert.equal(preset.folder === true, preset.args.includes('{folder}'), preset.id);
    }
  }
  // Every one-click directory listing is offered, with a connector id main can resolve.
  const directory = MCP_PRESETS.filter((preset) => preset.via === 'directory');
  assert.deepEqual(directory.map((preset) => preset.id).sort(), Object.keys(MCP_LISTING_NAMES).sort());
  assert.equal(MCP_PRESETS.find((preset) => preset.id === 'atlassian').connectorId, 'jira');
});

test('local presets are pinned to one exact release', () => {
  for (const preset of MCP_PRESETS.filter((item) => item.group === 'local')) {
    const pkg = preset.args.find((arg) => !arg.startsWith('-') && arg !== '{folder}');
    assert.match(pkg, /^(@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+$/, `${preset.id}: ${pkg}`);
    assert.doesNotMatch(pkg, /@latest$/, preset.id);
  }
});

test('folder presets use the workspace and saved servers are recognised', () => {
  const git = MCP_PRESETS.find((preset) => preset.id === 'git');
  assert.deepEqual(presetCommand(git, '/Users/you/project'), { command: 'uvx', args: ['mcp-server-git@2026.8.18', '--repository', '/Users/you/project'] });
  const servers = [
    { transport: 'http', url: 'https://mcp.deepwiki.com/mcp/' },
    { transport: 'http', url: 'https://mcp.notion.com/mcp', auth: { directoryId: 'notion' } },
    { transport: 'http', url: 'https://api.githubcopilot.com/mcp/', connector: 'github' },
    { transport: 'stdio', command: 'uvx', args: ['mcp-server-git', '--repository', '/x'] },
  ];
  const added = (id) => Boolean(presetServer(MCP_PRESETS.find((preset) => preset.id === id), servers));
  assert.deepEqual(['deepwiki', 'notion', 'github', 'git', 'context7', 'linear', 'fetch'].map(added),
    [true, true, true, true, false, false, false]);
});
