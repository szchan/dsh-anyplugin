// A mod row must carry the D25 tree pin the emitter took, or the materializer
// refuses it before `loadMod` (a mod is exec-class and default-off). These
// tests build their rows by hand, so they compute the same digest here.
import { treeArtifact } from '../../dsh-anyplugin-trust/src/index.ts'

export function pinnedMod(pluginRoot, entry, extra = {}) {
  const tree = treeArtifact(pluginRoot, entry)
  if (!tree.ok) throw new Error(`cannot pin ${entry}: ${tree.refusal.path}: ${tree.refusal.reason}`)
  return {
    entry,
    artifactHash: tree.artifact.artifactHash,
    artifactMode: tree.artifact.mode,
    artifact: tree.artifact.manifest,
    ...extra,
  }
}
