import { withDeadline } from './deadline.mjs';

// A native create() cannot necessarily be cancelled. Never interpret a
// temporary "not found" as proof it cannot finish creating a detached VM later.
export async function settleCreationForCleanup(creation, cleanupLate, timeoutMs = 20_000) {
  let settled = false;
  const observed = creation.then(
    value => { settled = true; return value; },
    error => { settled = true; throw error; },
  );
  try {
    await withDeadline(() => observed, 'settle VM provisioning before cleanup', timeoutMs);
  } catch (error) {
    if (settled) return; // Failed create: caller must still remove by name.
    // Rejection may also leave a partially provisioned VM registered by name.
    void observed.then(cleanupLate, cleanupLate).catch(error => {
      console.error(`Late VM cleanup failed: ${error.message}`);
      process.exitCode = 1;
    });
    throw new Error('VM provisioning is still pending; retain its cache directory', { cause: error });
  }
}
