// The guard probe's timeout seam, parsed strictly.
//
// `DSH_ANYPLUGIN_GUARD_PROBE_TIMEOUT_MS` exists so a test can prove the timeout
// branch without waiting 25 s, but `Number()` also read `0x10` (16 ms), `1e3`
// and `1.5` as overrides — an accidentally short timeout turns a slow probe into
// a false `unavailable`. Only positive decimal integers are a timeout; anything
// else falls back to the default, exactly as an unset variable does.
//
// The parse lives in its own module because `audit-evidence.mjs` runs its whole
// main body on import: the test imports this file instead of spawning the audit.

export const GUARD_PROBE_TIMEOUT_MS = 25_000

/** The timeout for the guard probe, in milliseconds. */
export function parseProbeTimeout(value) {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return GUARD_PROBE_TIMEOUT_MS
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : GUARD_PROBE_TIMEOUT_MS
}
