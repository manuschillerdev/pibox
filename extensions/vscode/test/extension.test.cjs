'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(values = [], inputs = []) {
  const commands = new Map();
  const opened = [];
  const errors = [];
  const updates = [];
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    Uri: { from: parts => parts },
    workspace: { getConfiguration: () => ({
      get: () => values,
      update: async (...args) => { updates.push(args); values = args[1]; },
    }) },
    window: {
      showInputBox: async () => inputs.shift(),
      showQuickPick: async items => items[0],
      showErrorMessage: async message => errors.push(message),
    },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
      executeCommand: async (...args) => opened.push(args),
    },
  };
  const sandbox = {
    module: { exports: {} },
    require: name => name === 'vscode' ? vscode : require('../src/connections.cjs'),
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/extension.cjs'), 'utf8'), sandbox);
  const context = { subscriptions: [] };
  sandbox.module.exports.activate(context);
  return { commands, opened, errors, updates, vscode, context };
}

test('opens a saved profile in a new remote window', async () => {
  const h = harness([{ name: 'dev', host: 'pibox-dev', path: '/workspace' }]);
  await h.commands.get('pibox.connect')();
  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0][0], 'vscode.openFolder');
  assert.equal(h.opened[0][1].authority, 'ssh-remote+pibox-dev');
  assert.equal(h.opened[0][2].forceNewWindow, true);
  assert.equal(h.context.subscriptions.length, 2);
});

test('first connection saves user settings then opens the workspace', async () => {
  const h = harness([], ['pibox-dev', '/workspace/my project', 'Dev']);
  await h.commands.get('pibox.connect')();
  assert.equal(h.updates[0][0], 'connections');
  assert.equal(h.updates[0][2], 1);
  assert.equal(h.opened[0][1].path, '/workspace/my project');
});

test('cancelling any input makes no changes', async () => {
  for (const inputs of [[], ['pibox-dev'], ['pibox-dev', '/workspace']]) {
    const h = harness([], inputs);
    await h.commands.get('pibox.connect')();
    assert.equal(h.updates.length, 0);
    assert.equal(h.opened.length, 0);
    assert.equal(h.errors.length, 0);
  }
});

test('cancelling the picker does not connect', async () => {
  const h = harness([{ name: 'Dev', host: 'dev', path: '/workspace' }]);
  h.vscode.window.showQuickPick = async () => undefined;
  await h.commands.get('pibox.connect')();
  assert.equal(h.opened.length, 0);
});

test('malformed settings and duplicate names surface actionable errors', async () => {
  const malformed = harness([{ name: 'Dev', host: 'user@dev', path: '/workspace' }]);
  await malformed.commands.get('pibox.connect')();
  assert.equal(malformed.errors.length, 1);
  assert.equal(malformed.opened.length, 0);
  const duplicate = harness([{ name: 'Dev', host: 'dev', path: '/workspace' }], ['dev2', '/workspace', 'Dev']);
  await duplicate.commands.get('pibox.addConnection')();
  assert.match(duplicate.errors[0], /already exists/);
  assert.equal(duplicate.updates.length, 0);
});
