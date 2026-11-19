/**
 * The behavioral half of the rig: turn a host's turn trace into a sequence of
 * events that can be diffed across hosts.
 *
 * Inventory answers "what did the host load". A trace answers "what did the
 * host actually do with it": which tools the model was given, what it called,
 * what the host answered, and what text reached the model's context. Both
 * halves are needed, because a plugin can load perfectly and still be
 * delivered differently (D16 found exactly that for skills).
 *
 * Normalization is part of the contract, not a convenience. Paths, ids and
 * timestamps differ per run and per machine; leaving them in makes every diff
 * red for reasons that are not behavior.
 */

import { readFileSync } from 'node:fs'

export type TraceEvent =
  | { kind: 'init'; tools: string[] }
  | { kind: 'tool-call'; name: string; input: unknown }
  | { kind: 'tool-result'; text: string }
  | { kind: 'user-text'; text: string }
  | { kind: 'assistant-text'; text: string }

export interface TraceRecord {
  type?: string
  subtype?: string
  tools?: unknown
  message?: { content?: unknown }
  [key: string]: unknown
}

/** Read a JSONL trace, naming the line that failed instead of the whole file. */
export function readTraceFile(path: string): TraceRecord[] {
  const text = readFileSync(path, 'utf8')
  const records: TraceRecord[] = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '') continue
    try {
      records.push(JSON.parse(line) as TraceRecord)
    } catch (error) {
      throw new Error(`${path}:${index + 1}: ${(error as Error).message}`)
    }
  }
  return records
}

export interface NormalizeOptions {
  /** The plugin directory, replaced with `<plugin>` wherever it appears. */
  root?: string
}

export interface TraceRow {
  index: number
  kind: TraceEvent['kind'] | 'missing'
  status: 'match' | 'differ' | 'only-left' | 'only-right'
  left?: TraceEvent
  right?: TraceEvent
}

export interface TraceDiff {
  rows: TraceRow[]
  summary: {
    compared: number
    matched: number
    differing: number
    onlyLeft: number
    onlyRight: number
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const TOOL_ID = /\b(?:call|toolu)_[A-Za-z0-9_]+/g
const TIMESTAMP = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g
const SANDBOX = /\/tmp\/claude-eval-[A-Za-z0-9]+/g

export function makeScrubber(options: NormalizeOptions = {}): (text: string) => string {
  const root = options.root?.replace(/\/+$/u, '')
  return (text: string): string => {
    let value = text
    if (root) value = value.split(root).join('<plugin>')
    return value
      .replace(SANDBOX, '<sandbox>')
      .replace(UUID, '<uuid>')
      .replace(TOOL_ID, '<tool-id>')
      .replace(TIMESTAMP, '<ts>')
  }
}

function scrubValue(value: unknown, scrub: (text: string) => string): unknown {
  if (typeof value === 'string') return scrub(value)
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, scrub))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubValue(item, scrub)
    }
    return out
  }
  return value
}

function blockText(block: Record<string, unknown>): string {
  const content = block.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((item) =>
        item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
          ? (item as { text: string }).text
          : '',
      )
      .join('')
  }
  return ''
}

/**
 * Keep only what a host controls, in order:
 *  - the tools the model was offered at session start,
 *  - each tool call and the host's reply to it,
 *  - each block of text the host injected into the model's context,
 *  - the assistant's own prose.
 *
 * Everything else is dropped on purpose: thinking is model-dependent, system
 * thinking-token counters are telemetry, and the result record is cost.
 */
export function normalizeTrace(records: TraceRecord[], options: NormalizeOptions = {}): TraceEvent[] {
  const scrub = makeScrubber(options)
  const events: TraceEvent[] = []

  for (const record of records) {
    if (record.type === 'system') {
      if (record.subtype === 'init') {
        const tools = Array.isArray(record.tools)
          ? record.tools.filter((tool): tool is string => typeof tool === 'string').sort()
          : []
        events.push({ kind: 'init', tools })
      }
      continue
    }

    if (record.type === 'result') continue

    const content = record.message?.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const item = block as Record<string, unknown>
      const type = item.type

      if (type === 'thinking' || type === 'redacted_thinking') continue

      if (type === 'tool_use' && typeof item.name === 'string') {
        events.push({
          kind: 'tool-call',
          name: item.name,
          input: scrubValue(item.input, scrub),
        })
        continue
      }

      if (type === 'tool_result') {
        events.push({ kind: 'tool-result', text: scrub(blockText(item)) })
        continue
      }

      if (type === 'text' && typeof item.text === 'string') {
        const text = scrub(item.text)
        if (record.type === 'assistant') events.push({ kind: 'assistant-text', text })
        else events.push({ kind: 'user-text', text })
      }
    }
  }

  return events
}

function sameEvent(left: TraceEvent, right: TraceEvent): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Positional alignment. Cheap, readable, and honest about its failure mode:
 * one insertion shifts every later row into `differ`. That is the right
 * default for harness parity, where sequence is part of the behavior and a
 * cascading red is a signal, not noise.
 */
export function diffTraces(left: TraceEvent[], right: TraceEvent[]): TraceDiff {
  const rows: TraceRow[] = []
  const total = Math.max(left.length, right.length)
  let matched = 0
  let differing = 0
  let onlyLeft = 0
  let onlyRight = 0

  for (let index = 0; index < total; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a && b) {
      const status = sameEvent(a, b) ? 'match' : 'differ'
      if (status === 'match') matched += 1
      else differing += 1
      rows.push({ index, kind: a.kind, status, left: a, right: b })
    } else if (a) {
      onlyLeft += 1
      rows.push({ index, kind: a.kind, status: 'only-left', left: a })
    } else if (b) {
      onlyRight += 1
      rows.push({ index, kind: b.kind, status: 'only-right', right: b })
    }
  }

  return {
    rows,
    summary: {
      compared: Math.min(left.length, right.length),
      matched,
      differing,
      onlyLeft,
      onlyRight,
    },
  }
}

function describe(event: TraceEvent | undefined): string {
  if (!event) return '(none)'
  switch (event.kind) {
    case 'init':
      return `init tools=[${event.tools.join(',')}]`
    case 'tool-call':
      return `tool-call ${event.name} ${JSON.stringify(event.input)}`
    case 'tool-result':
      return `tool-result ${JSON.stringify(event.text)}`
    case 'user-text':
      return `user-text ${JSON.stringify(event.text)}`
    case 'assistant-text':
      return `assistant-text ${JSON.stringify(event.text)}`
  }
}

export function formatTraceDiff(diff: TraceDiff, options: { verbose?: boolean } = {}): string {
  const lines: string[] = []
  for (const row of diff.rows) {
    if (row.status === 'match' && !options.verbose) continue
    if (row.status === 'match') {
      lines.push(`  ${row.index} match  ${describe(row.left)}`)
      continue
    }
    lines.push(`  ${row.index} ${row.status}`)
    lines.push(`      left  ${describe(row.left)}`)
    lines.push(`      right ${describe(row.right)}`)
  }
  const { compared, matched, differing, onlyLeft, onlyRight } = diff.summary
  lines.push(
    `${compared} compared, ${matched} matched, ${differing} differing, ` +
      `${onlyLeft} only-left, ${onlyRight} only-right`,
  )
  return lines.join('\n')
}
