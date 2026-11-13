'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateHost, validatePath, validateConnection, remoteFolder } = require('../src/connections.cjs');

const connection = { name: 'Development', host: 'pibox-dev', path: '/workspace' };

test('builds a Remote SSH folder without interpreting path characters', () => {
  assert.deepEqual(remoteFolder({ ...connection, path: '/workspace/a #b?c% d' }), {
    scheme: 'vscode-remote', authority: 'ssh-remote+pibox-dev', path: '/workspace/a #b?c% d',
  });
});

test('only accepts safe SSH config aliases', () => {
  for (const host of ['pibox-dev', '127.0.0.1', 'dev.example.com', 'dev_2']) assert.equal(validateHost(host), undefined);
  for (const host of ['', '-option', 'user@host', 'host:22', 'host/path', 'host+other', 'host\n', undefined]) {
    assert.equal(typeof validateHost(host), 'string');
  }
});

test('requires absolute guest paths without control characters', () => {
  for (const path of ['/', '/workspace', '/home/dev/my project']) assert.equal(validatePath(path), undefined);
  for (const path of ['', './workspace', '~/workspace', '/a\n', '/a\0', undefined]) assert.equal(typeof validatePath(path), 'string');
});

test('rejects malformed profiles before constructing remote URIs', () => {
  for (const value of [null, [], {}, { ...connection, name: ' ' }, { ...connection, host: 'a@b' }]) {
    assert.equal(typeof validateConnection(value), 'string');
    assert.throws(() => remoteFolder(value));
  }
  assert.equal(validateConnection(connection), undefined);
});
