export async function withDeadline(operation, label, timeoutMs, { signal, cancel } = {}) {
  let timer;
  let onAbort;
  const stop = error => {
    // Cancellation is best-effort and must not delay rejection of the deadline.
    if (cancel) Promise.resolve().then(cancel).catch(() => {});
    return error;
  };
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(stop(new Error(`${label} timed out after ${timeoutMs}ms`))), timeoutMs);
        onAbort = () => reject(stop(signal.reason ?? new Error(`${label} aborted`)));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
