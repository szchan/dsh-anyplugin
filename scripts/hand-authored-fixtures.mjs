/**
 * Fixtures no upstream command can inventory, shared by the capture script and
 * the conformance test so the two cannot disagree about which fixtures are
 * hand-authored.
 *
 * A fixture belongs here only when the pinned CLI cannot observe the surface
 * that makes it a fixture. The value is the reason the capture script prints
 * and the test asserts, so the skip is never silent.
 */
export const HAND_AUTHORED_FIXTURES = new Map([
  [
    'claude-output-styles',
    'claude plugin details at 2.1.322 prints no output-style line (D29); the body hash is the evidence, so there is no upstream inventory to capture',
  ],
])
