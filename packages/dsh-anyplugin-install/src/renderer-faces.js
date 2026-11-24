// The derived renderer bridge (issue #281 slice 1): every face this bridge
// serves against a foreign mod's element tree, and why each one is `derived`.
//
// The classification is *at the source*, as the fidelity contract requires
// (AGENTS.md §3.1): the face table below is the one source of truth, imported
// by the browser half (`client/renderer.js`), the host half (`renderer.ts`)
// and the tests. Nothing here may be reclassified without editing this file
// and a decision entry; the bridge deliberately never claims `equivalent`.
//
// Basis: spikes/s25-client-surface (PR #287, ticket/280) measured the client
// seams at 0.2.2-rc.2 and 0.2.2-rc.5. What S25 could not prove is written
// into the reasons ("no focus primitive", "no geometry prop", "no host
// pacing", "Desktop file:// + IPC transport untested") rather than papered
// over. The vocabulary is deliberately four tags: the pin's Pane trees can
// carry twelve to sixteen, and every tag we do not translate is refused by
// name (`element.unsupported`) instead of guessed at.

/** The element tags this bridge translates. Keep it small and keep it stated. */
export const ELEMENT_VOCABULARY = Object.freeze(['Box', 'Text', 'Button', 'Input'])

/** One sentence the pane renders verbatim, so the smallness is served, not hidden. */
export const ELEMENT_VOCABULARY_NOTE = Object.freeze(
  'translated vocabulary: Box, Text, Button, Input (4 of the pin\'s surface tags; anything else is refused by name)',
)

/** The wire kind both halves agree on. */
export const RENDERER_KIND = Object.freeze('anyplugin-renderer')

/** The one read route the browser half polls; it is loopback-guarded like /anyplugin/installs. */
export const RENDERER_ROUTE = Object.freeze('/anyplugin/render')

/**
 * The faces, each with its `derived` reason. `face` is the stable id the
 * payload, the pane footer and the tests use; `class` is the fidelity class
 * of the served face (not of the foreign element runtime it imitates).
 */
export const RENDERER_FACES = Object.freeze([
  Object.freeze({
    face: 'shell.main.pane',
    class: 'derived',
    reason:
      'registered into the host layout\'s keyed `main` slot, whose seat this bridge does not own; the host decides whether and where the pane is placed (S25 primitives 1 and 2)',
  }),
  Object.freeze({
    face: 'shell.overlay',
    class: 'derived',
    reason:
      'registered into the additive `shell.overlay` list slot; the overlay is an extra line of ours, not a mod surface the host places or focuses',
  }),
  Object.freeze({
    face: 'element.box',
    class: 'derived',
    reason:
      'flex/space/border props mapped onto this pane\'s own CSS box model; the host hands a keyed seat no geometry (S25 primitive 4), so the layout mapping is ours rather than the pin\'s terminal renderer',
  }),
  Object.freeze({
    face: 'element.text',
    class: 'derived',
    reason:
      'text size/weight/color vocabulary mapped to CSS in the page realm; no terminal grid, no true-color resolution and no line wrapping contract',
  }),
  Object.freeze({
    face: 'element.button',
    class: 'derived',
    reason:
      'drawn as a pointer target and labelled from `label`/`key`; the pin\'s `press` member is a recorded handle, and dispatching it is planned, not served (ui.ts:38)',
  }),
  Object.freeze({
    face: 'element.input',
    class: 'derived',
    reason:
      'a local field with its own value, placeholder and submit label; host focus routing and the pin\'s line editing are absent (S25 primitive 3 found no focus primitive)',
  }),
  Object.freeze({
    face: 'element.unsupported',
    class: 'derived',
    reason:
      'a pinned tag outside the four-tag vocabulary is drawn as a named placeholder and reported as a lost prop, never guessed at',
  }),
  Object.freeze({
    face: 'geometry.measured',
    class: 'derived',
    reason:
      'geometry is observed by this pane through ResizeObserver and measured inside requestAnimationFrame; it is feedback we collect, not a size or a layout input the host promises',
  }),
  Object.freeze({
    face: 'redraw.paced',
    class: 'derived',
    reason:
      'redraws are coalesced to one callback per animation frame in the page realm; the host\'s own invalidate pacing is not exposed (S25 primitive 5)',
  }),
  Object.freeze({
    face: 'keyboard.shortcut',
    class: 'derived',
    reason:
      'keyboard enters through `ctx.shortcuts` declarable commands (S25 primitive 3); there is no host focus/route primitive and the web defaults are restricted',
  }),
  Object.freeze({
    face: 'transport.loopback',
    class: 'derived',
    reason:
      'the browser half reads a snapshot from our own host half over the loopback HTTP route (S25 primitive 6); the Desktop file:// + IPC transport is untested and is slice 2 of #281',
  }),
])

/** Every face's `derived` reason as a plain `face: reason` list for the pane footer. */
export const RENDERER_FACE_LINES = Object.freeze(
  RENDERER_FACES.map((entry) => `${entry.face}: ${entry.class} — ${entry.reason}`),
)

/** The faces, shaped for the payload: plain data only. */
export const rendererFaces = () => RENDERER_FACES.map(({ face, class: fidelityClass, reason }) => ({ face, class: fidelityClass, reason }))

/** Fail closed if a class or reason is ever wrong: an empty reason is a bug (AGENTS.md §3.1). */
export const rendererFacesAreDerived = () =>
  RENDERER_FACES.length > 0 &&
  RENDERER_FACES.every(
    (entry) =>
      typeof entry.face === 'string' &&
      entry.face.length > 0 &&
      entry.class === 'derived' &&
      typeof entry.reason === 'string' &&
      entry.reason.trim().length > 0,
  )
