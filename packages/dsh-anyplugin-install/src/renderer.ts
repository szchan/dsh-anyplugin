// The derived renderer bridge (issue #281 slice 1), host half.
//
// What this module is: the main-process half of the request/response round
// trip the browser half polls. It owns a *registry* of render sources — the
// shipped producer is `dsh-anyplugin-materialize-hook`, which answers with the
// headless mod host's own snapshot (`readUi`), i.e. the validated element trees
// the sink recorded — and it normalises whatever a source returns into the one
// JSON shape the browser half draws. It draws nothing itself.
//
// What it deliberately is not: host layout, host focus routing, host invalidate
// pacing, or a push channel. It is a read: one loopback GET, one JSON response
// (S25 primitive 6 proved request/response through our own host half; the
// Desktop file:// + IPC transport is slice 2). Every served face is class
// `derived` with its reason in ../renderer-faces.js, and a pane's tree is
// capped so one pathological tree cannot become the whole response.
//
// Composition: the controller provides this registry as the optional
// `anypluginRenderer` service, passes a reader into the panel route, and the
// mod host's materializer registers one source. A missing service or a missing
// source is served as `sources: 0`, not as a crash: an absent producer is a
// degraded answer with a visible zero, not a hidden fallback.

import {
  ELEMENT_VOCABULARY,
  RENDERER_FACES,
  RENDERER_KIND,
  RENDERER_ROUTE,
  rendererFaces,
} from './renderer-faces.js'

/** Max panes kept from all sources; the rest are counted away. */
export const MAX_RENDERER_PANES = 64

/** Max serialised size of one pane's tree; a larger tree is refused, not clipped. */
export const MAX_PANE_BYTES = 96 * 1024

/** Per-source snapshot caps, so one broken source cannot exhaust the merge. */
const MAX_SOURCE_LOG_ENTRIES = 64
const MAX_SOURCE_REFUSALS = 32
const MAX_JSON_NODES = 8192
const MAX_JSON_DEPTH = 64

export interface RendererPane {
  [field: string]: unknown
  id: string
  title: string
  revision: number
  isPlaced: boolean
  placement: string
  tree?: unknown
  refusal?: unknown
}

export interface RendererPayload {
  [field: string]: unknown
  ok: true
  kind: string
  sources: number
  panes: RendererPane[]
  statuses: string[]
  logs: unknown[]
  refusals: unknown[]
  truncated: boolean
  vocabulary: readonly string[]
  faces: ReadonlyArray<{ face: string; class: string; reason: string }>
}

/** A render source answers with a mod-host snapshot or a pane list; both are data. */
export type RendererSource = () => unknown

export interface RendererRegistryOptions {
  readonly paneLimit?: number
  readonly paneBytes?: number
  readonly now?: () => number
}

export interface RendererRegistry {
  /** Register one producer; the returned disposer removes it. */
  register(source: RendererSource): () => void
  /** The normalised snapshot the browser half receives. */
  snapshot(): RendererPayload
  /** Number of registered sources (for tests and logs). */
  size(): number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const finiteNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const stringOf = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback)

/**
 * Convert arbitrary source output into JSON-safe data, dropping functions,
 * symbols, undefined members and cycles. The sink should already hand plain
 * descriptors; this is the defence that keeps a malformed producer a measured
 * refusal instead of `JSON.stringify` throwing on the route.
 */
const jsonSafe = (value: unknown, budget = { nodes: 0 }): unknown => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'undefined' || typeof value === 'bigint') {
    return undefined
  }
  if (budget.nodes >= MAX_JSON_NODES) return undefined
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const entry of value) {
      budget.nodes += 1
      const cleaned = jsonSafe(entry, budget)
      if (cleaned !== undefined) out.push(cleaned)
    }
    return out
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      budget.nodes += 1
      const cleaned = jsonSafe(entry, budget)
      if (cleaned !== undefined) out[key] = cleaned
    }
    return out
  }
  return undefined
}

/** A `mod-ui-headless` sink snapshot, a materializer `readUi` answer, or a bare pane array. */
const panesOf = (answer: unknown): unknown[] => {
  if (Array.isArray(answer)) return answer
  if (isRecord(answer) && Array.isArray(answer.panes)) return answer.panes
  return []
}

const statusesOf = (answer: unknown): string[] => {
  if (!isRecord(answer)) return []
  if (Array.isArray(answer.statuses)) return answer.statuses.filter((entry): entry is string => typeof entry === 'string')
  return []
}

const logsOf = (answer: unknown): unknown[] => (isRecord(answer) && Array.isArray(answer.logs) ? answer.logs.slice(0, MAX_SOURCE_LOG_ENTRIES) : [])

const refusalsOf = (answer: unknown): unknown[] =>
  isRecord(answer) && Array.isArray(answer.refusals) ? answer.refusals.slice(0, MAX_SOURCE_REFUSALS) : []

const refusalText = (refusal: unknown): string => {
  if (typeof refusal === 'string') return refusal
  if (isRecord(refusal) && typeof refusal.reason === 'string') return refusal.reason
  return typeof refusal === 'object' && refusal !== null ? JSON.stringify(refusal) : String(refusal)
}

/**
 * One source pane, normalised and capped. A tree above the wire budget is
 * replaced by a refusal naming the budget, so the pane still says what was
 * open and why nothing is drawn; the latest-valid-tree semantics stay in the
 * sink, not here.
 */
export const normalizeRendererPane = (pane: unknown, paneBytes = MAX_PANE_BYTES): RendererPane | undefined => {
  if (!isRecord(pane)) return undefined
  if (typeof pane.id !== 'string' || pane.id === '') return undefined
  const normalized: RendererPane = {
    id: pane.id,
    title: stringOf(pane.title, pane.id),
    revision: finiteNumber(pane.revision, 0),
    isPlaced: pane.isPlaced !== false,
    placement: stringOf(pane.placement, 'dock'),
  }
  if (typeof pane.plugin === 'string') normalized.plugin = pane.plugin
  if (typeof pane.surface === 'string') normalized.surface = pane.surface
  if (pane.tree !== undefined) {
    const tree = jsonSafe(pane.tree)
    let bytes = 0
    try {
      bytes = JSON.stringify(tree).length
    } catch {
      bytes = paneBytes + 1
    }
    if (bytes > paneBytes) {
      normalized.refusal = {
        code: 'pane-too-large',
        reason: `tree is ${bytes} bytes, above the ${paneBytes}-byte wire budget`,
      }
    } else {
      normalized.tree = tree
    }
  }
  if (pane.refusal !== undefined) normalized.refusal = jsonSafe(pane.refusal)
  return normalized
}

/**
 * One registry per bundled plugin instance. Its snapshot is the only thing the
 * route serves: read-only, bounded, and empty (with `sources: 0`) when no
 * producer has registered.
 */
export const createRendererRegistry = (options: RendererRegistryOptions = {}): RendererRegistry => {
  const sources = new Set<RendererSource>()
  const paneLimit = Math.max(1, Math.trunc(options.paneLimit ?? MAX_RENDERER_PANES))
  const paneBytes = Math.max(1024, Math.trunc(options.paneBytes ?? MAX_PANE_BYTES))
  const start = typeof options.now === 'function' ? options.now : () => Date.now()

  return {
    register(source) {
      if (typeof source !== 'function') return () => {}
      sources.add(source)
      return () => {
        sources.delete(source)
      }
    },
    size: () => sources.size,
    snapshot() {
      const panes: RendererPane[] = []
      const statuses: string[] = []
      const logs: unknown[] = []
      const refusals: unknown[] = []
      let truncated = false
      let sourceCount = 0
      for (const source of Array.from(sources)) {
        sourceCount += 1
        let answer: unknown
        try {
          answer = source()
        } catch (error) {
          refusals.push({
            code: 'source-threw',
            reason: typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
              ? (error as { message: string }).message
              : String(error),
          })
          continue
        }
        statuses.push(...statusesOf(answer))
        logs.push(...logsOf(answer))
        refusals.push(...refusalsOf(answer))
        for (const rawPane of panesOf(answer)) {
          const pane = normalizeRendererPane(rawPane, paneBytes)
          if (pane === undefined) {
            truncated = true
            continue
          }
          if (panes.length >= paneLimit) {
            truncated = true
            break
          }
          panes.push(pane)
        }
      }
      return {
        ok: true,
        kind: RENDERER_KIND,
        sources: sourceCount,
        panes,
        statuses,
        logs,
        refusals,
        truncated,
        vocabulary: ELEMENT_VOCABULARY,
        faces: rendererFaces(),
        servedAt: start(),
      }
    },
  }
}

/** The reader the panel route calls; kept a function so the route holds no registry. */
export const rendererPayloadOf = (registry: RendererRegistry | undefined): RendererPayload => {
  if (registry === undefined) {
    return {
      ok: true,
      kind: RENDERER_KIND,
      sources: 0,
      panes: [],
      statuses: [],
      logs: [],
      refusals: [],
      truncated: false,
      vocabulary: ELEMENT_VOCABULARY,
      faces: rendererFaces(),
      servedAt: Date.now(),
    }
  }
  return registry.snapshot()
}

/** The route path, re-exported so the panel and the tests name one string. */
export const RENDERER_PATH = RENDERER_ROUTE

/** Faces stay class `derived`; this is imported by the tests as the source of truth. */
export { RENDERER_FACES, rendererFaces, ELEMENT_VOCABULARY }
