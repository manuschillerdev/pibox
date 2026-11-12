import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTypeScript } from './load-typescript.mjs';

const { withMicrosandboxDefaults } = await loadTypeScript('../src/sandboxes/microsandbox.ts');

test('Microsandbox trusts host CAs unless configuration opts out', () => {
  assert.deepEqual(withMicrosandboxDefaults({ image: 'alpine' }), {
    image: 'alpine',
    trustHostCAs: true,
  });
  assert.deepEqual(withMicrosandboxDefaults({ trustHostCAs: false }), {
    trustHostCAs: false,
  });
});
