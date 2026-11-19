/**
 * `authorize(plugin, grants)` — decide which exec artifacts may run (D25).
 *
 * A grant matches only when **capability + target + artifactHash** all match,
 * for the same plugin identity. Resolution is by scope, not by first row:
 *
 *   local (rank 0) > project (rank 1) > user (rank 2)
 *
 * The narrowest scope that mentions a `(plugin, capability, target)` decides.
 * At that scope a revoke beats a grant. A grant at a broader scope is *not* a
 * fallback when a narrower scope refuses: otherwise a stale user grant would
 * silently re-authorize an artifact after a local revoke.
 *
 * A hash mismatch refuses and reports both hashes. It never re-grants: the
 * caller (installer UI) shows the new hash and asks again.
 */
import type { ClaudePluginIr } from '../../dsh-anyplugin-ir/src/index.ts'
import { classify, pluginIdentity, type ArtifactRow } from './classify.ts'
import { SCOPES, type GrantRecord, type Grants, type RevokeRecord, type Scope } from './grants.ts'

export type RefusalCode = 'no-grant' | 'revoked' | 'hash-mismatch' | 'unsupported'

export interface Refusal {
  capability: string
  target: string
  artifactHash: string
  code: RefusalCode
  /** Human-readable, names the missing/revoked grant and, on mismatch, both hashes. */
  reason: string
  /** The exact invocation, so a prompt can show what would run. */
  command?: string
  args?: readonly string[]
  /** Present on `hash-mismatch`: the hash the winning grant pinned. */
  grantedHash?: string
  grantedAt?: string
  scope?: Scope
}

export interface TrustDecision {
  plugin: string
  /** Rows that need a decision (exec artifacts that would otherwise be emitted). */
  rows: ArtifactRow[]
  /** Targets whose current bytes are granted. */
  allowed: string[]
  refused: Refusal[]
}

function carried(fidelity: string): boolean {
  return fidelity === 'exact' || fidelity === 'equivalent'
}

function scopeRank(scope: Scope): number {
  return SCOPES.indexOf(scope)
}

function matches(record: GrantRecord | RevokeRecord, plugin: string, row: ArtifactRow): boolean {
  return record.plugin === plugin && record.capability === row.capability && record.target === row.target
}

function refusal(row: ArtifactRow, code: RefusalCode, reason: string, extra: Partial<Refusal> = {}): Refusal {
  return { capability: row.capability, target: row.target, artifactHash: row.artifactHash, code, reason, ...extra }
}

/** Render the exact command line for the prompt; argv is quoted, not re-parsed. */
function invocation(command: string, args?: readonly string[]): string {
  if (args === undefined) return command
  const quote = (value: string) => (/^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : JSON.stringify(value))
  return [command, ...args].map(quote).join(' ')
}

/**
 * Rows that are actually candidates for emission. Hooks already annotated
 * `planned` (unsupported event, non-command handler) are not gated — they are
 * not going to run either way, and reporting them as refused would confuse a
 * refusal with an unsupported capability.
 */
function candidates(plugin: ClaudePluginIr): ArtifactRow[] {
  const emittableHooks = new Set(
    plugin.hooks
      .filter((hook) => hook.command !== undefined && carried(hook.annotation.fidelity))
      .map((hook) => `hook:${hook.event}#${hook.index}`),
  )
  return classify(plugin).filter((row) => emittableHooks.has(row.target))
}

export function authorize(plugin: ClaudePluginIr, grants: Grants): TrustDecision {
  const id = pluginIdentity(plugin)
  const rows = candidates(plugin)
  const hooks = new Map(
    plugin.hooks
      .filter((hook) => hook.command !== undefined)
      .map((hook) => [`hook:${hook.event}#${hook.index}`, hook] as const),
  )
  const allowed: string[] = []
  const refused: Refusal[] = []

  for (const row of rows) {
    const hook = hooks.get(row.target)
    const shown = hook === undefined || hook.command === undefined ? undefined : invocation(hook.command, hook.args)
    const commandFields: Partial<Refusal> =
      hook === undefined || hook.command === undefined
        ? {}
        : { command: hook.command, ...(hook.args === undefined ? {} : { args: hook.args }) }
    const suffix = shown === undefined ? '' : `; command: ${shown}`
    if (row.unsupported !== undefined) {
      refused.push(
        refusal(
          row,
          'unsupported',
          `cannot pin ${row.target} of ${id}: ${row.unsupported}${suffix}`,
          commandFields,
        ),
      )
      continue
    }
    const rowGrants = grants.grants.filter((record) => matches(record, id, row))
    const rowRevokes = grants.revokes.filter((record) => matches(record, id, row))
    const ranks = [...rowGrants, ...rowRevokes].map((record) => scopeRank(record.scope))
    if (ranks.length === 0) {
      refused.push(
        refusal(
          row,
          'no-grant',
          `no ${row.capability} grant for ${row.target} of ${id}; grant it before it can run${suffix}`,
          commandFields,
        ),
      )
      continue
    }

    const rank = Math.min(...ranks)
    const scope = SCOPES[rank]
    const revokeAtScope = rowRevokes.find((record) => scopeRank(record.scope) === rank)
    if (revokeAtScope !== undefined) {
      refused.push(
        refusal(
          row,
          'revoked',
          `${row.capability} grant for ${row.target} of ${id} is revoked at ${scope} scope${suffix}`,
          { scope, ...commandFields },
        ),
      )
      continue
    }

    const grantAtScope = rowGrants.find((record) => scopeRank(record.scope) === rank)
    if (grantAtScope === undefined) {
      // Unreachable while `ranks` only holds grants/revokes, kept for the type.
      refused.push(refusal(row, 'no-grant', `no ${row.capability} grant for ${row.target} of ${id}`))
      continue
    }
    if (grantAtScope.artifactHash !== row.artifactHash) {
      refused.push(
        refusal(
          row,
          'hash-mismatch',
          `${row.capability} grant for ${row.target} of ${id} pins ${grantAtScope.artifactHash} but the artifact is now ${row.artifactHash}; review it and re-grant${suffix}`,
          { ...commandFields, grantedHash: grantAtScope.artifactHash, grantedAt: grantAtScope.grantedAt, scope },
        ),
      )
      continue
    }
    allowed.push(row.target)
  }

  return { plugin: id, rows, allowed: allowed.sort(), refused }
}
