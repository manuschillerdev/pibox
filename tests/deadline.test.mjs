import assert from 'node:assert/strict';
import test from 'node:test';
import { withDeadline } from './deadline.mjs';
import { settleCreationForCleanup } from './provisioning.mjs';

test('a stalled receive rejects even if cancellation also stalls', async () => {
  let cancelled = false;
  await assert.rejects(withDeadline(
    () => new Promise(() => {}), 'stalled guest command', 20,
    { cancel: () => { cancelled = true; return new Promise(() => {}); } },
  ), /stalled guest command timed out/);
  assert.equal(cancelled, true);
});

test('late creation is removed and cannot be mistaken for completed cleanup', async () => {
  let release;
  let removed = false;
  const creation = new Promise(resolve => { release = resolve; });
  await assert.rejects(settleCreationForCleanup(creation, () => { removed = true; }, 20), /still pending; retain/);
  assert.equal(removed, false);
  release({ name: 'late-vm' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(removed, true);
});

test('late creation rejection also retries cleanup of partial provisioning', async () => {
  let rejectCreation;
  let removed = false;
  const creation = new Promise((_, reject) => { rejectCreation = reject; });
  await assert.rejects(settleCreationForCleanup(creation, () => { removed = true; }, 20), /still pending; retain/);
  rejectCreation(new Error('partial provisioning failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(removed, true);
});

test('abort interrupts a pending operation without waiting for it', async () => {
  const controller = new AbortController();
  const pending = withDeadline(() => new Promise(() => {}), 'pending', 1000, { signal: controller.signal });
  controller.abort(new Error('test shutdown'));
  await assert.rejects(pending, /test shutdown/);
});
