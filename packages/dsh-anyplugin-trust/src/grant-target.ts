/**
 * Target-validating convenience wrappers around the low-level grant store.
 *
 * `grant()`/`revoke()` operate on strings because the store is a file format;
 * they cannot know whether `hook:BogusEvent#9` names anything. An installer UI
 * does: it has the plugin IR and `classify(plugin)`. These wrappers resolve the
 * target against that classification first, so a typo or a stale row is a
 * refusal, never a grant that can never match.
 */
import type { ClaudePluginIr } from '../../dsh-anyplugin-ir/src/index.ts'
import { classify, pluginIdentity } from './classify.ts'
import { grant, revoke, type Grants, type Scope } from './grants.ts'
import type { TreeOptions } from './hash.ts'

export class GrantTargetError extends Error {
  readonly target: string

  constructor(target: string, reason: string) {
    super(reason)
    this.name = 'GrantTargetError'
    this.target = target
  }
}

function rowFor(plugin: ClaudePluginIr, target: string, options: TreeOptions = {}) {
  const id = pluginIdentity(plugin)
  const rows = classify(plugin, options)
  const row = rows.find((candidate) => candidate.target === target)
  if (row === undefined) {
    const known = rows.slice(0, 8).map((candidate) => candidate.target).join(', ')
    throw new GrantTargetError(
      target,
      `no exec artifact "${target}" in ${id}${known.length === 0 ? '' : `; known targets: ${known}`}`,
    )
  }
  if (row.unsupported !== undefined) {
    throw new GrantTargetError(target, `exec artifact "${target}" of ${id} cannot be pinned: ${row.unsupported}`)
  }
  return { id, row }
}

/**
 * Grant one concrete artifact of `plugin` at `scope`; rejects unknown targets.
 *
 * `expectedHash` is the TOCTOU guard for a caller that already showed the
 * human a command line: if the bytes changed since that preview, the write is
 * aborted rather than pinning bytes nobody consented to.
 */
export function grantFor(
  plugin: ClaudePluginIr,
  store: Grants,
  target: string,
  options: { scope: Scope; grantedAt?: string; expectedHash?: string; tree?: TreeOptions },
): Grants {
  const { id, row } = rowFor(plugin, target, options.tree)
  if (options.expectedHash !== undefined && row.artifactHash !== options.expectedHash) {
    throw new GrantTargetError(
      target,
      `the plugin bytes changed while planning: ${target} was ${options.expectedHash} and is now ${row.artifactHash}; re-run the command`,
    )
  }
  return grant(
    store,
    { plugin: id, capability: row.capability, target: row.target, artifactHash: row.artifactHash },
    options,
  )
}

/** Revoke one concrete artifact of `plugin` at `scope`; rejects unknown targets. */
export function revokeFor(
  plugin: ClaudePluginIr,
  store: Grants,
  target: string,
  options: { scope: Scope; tree?: TreeOptions },
): Grants {
  const { id, row } = rowFor(plugin, target, options.tree)
  return revoke(store, { plugin: id, capability: row.capability, target: row.target }, options)
}
