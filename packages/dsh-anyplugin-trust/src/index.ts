/**
 * `dsh-anyplugin-trust` — hash-pinned grants for exec-class artifacts.
 *
 * Entry points:
 *   classify(plugin)            one row per exec artifact, hash over the bytes that run
 *   authorize(plugin, grants)   allowed targets + refusals (hash mismatch reports the new hash)
 *   gate(plugin, grants)        IR with refused hooks moved to `pending` as `planned`
 *   readGrants / writeGrants    the canonical `grants.yml` store (D25)
 *   grant / revoke              record edits at a scope
 *   grantFor / revokeFor        the same, with the target checked against classify()
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
  updateGrants,
  writeGrants,
  type GrantRecord,
  type Grants,
  type RevokeRecord,
  type Scope,
} from './grants.ts'
export {
  fileArtifact,
  hashBytes,
  hashFile,
  hashHook,
  hashManifest,
  hashManifestAtSpawn,
  hookArtifactText,
  shellWords,
  type ArtifactFile,
  type ArtifactManifest,
  type ArtifactMode,
  type HookArtifact,
} from './hash.ts'
export { classify, pluginIdentity, type ArtifactRow } from './classify.ts'
export { authorize, type Refusal, type RefusalCode, type TrustDecision } from './authorize.ts'
export { gate, hookEntryName, type Gated } from './gate.ts'
export { GrantTargetError, grantFor, revokeFor } from './grant-target.ts'
