/**
 * `dsh-anyplugin-trust` — hash-pinned grants for exec-class artifacts.
 *
 * Entry points:
 *   classify(plugin)            one row per exec artifact, hash over the bytes that run
 *   authorize(plugin, grants)   allowed targets + refusals (hash mismatch reports the new hash)
 *   gate(plugin, grants)        IR with refused hooks moved to `pending` as `planned`
 *   readGrants / writeGrants    the canonical `grants.yml` store (D25)
 *   grant / revoke              record edits at a scope
 */
export {
  EXEC_CAPABILITY,
  GRANTS_SCHEMA,
  GrantsFileError,
  SCOPES,
  emptyGrants,
  grant,
  grantsPath,
  parseGrants,
  readGrants,
  revoke,
  serializeGrants,
  sortGrants,
  sortRevokes,
  validateGrants,
  writeGrants,
  type GrantRecord,
  type Grants,
  type RevokeRecord,
  type Scope,
} from './grants.ts'
export { hashBytes, hashFile, hashHook, hookArtifactText, shellWords, type HookArtifact } from './hash.ts'
export { classify, pluginIdentity, type ArtifactRow } from './classify.ts'
export { authorize, type Refusal, type RefusalCode, type TrustDecision } from './authorize.ts'
export { gate, hookEntryName, type Gated } from './gate.ts'
