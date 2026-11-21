// The real-turn vcs fixture (#119): a mod's load-time `session.start` asks the
// host `$vcs` for the working copy and the diff, and stores its own observation
// so a booted harness turn can assert what the mod saw, not what the host
// logged. The session cwd is seeded with a git repository by the test.
export function register(on: On): void {
  on('session.start', async ($: Dollar, event: unknown, next: Next) => {
    const start = event as { cwd: string }
    const copy = await $.vcs.detect({ path: start.cwd })
    const answer = copy === null
      ? null
      : await $.vcs.diff({ path: copy.root, vcs: copy.vcs, base: 'head' })
    const files = Array.isArray(answer?.files)
      ? answer.files.map((file) => ({
          path: file.path,
          added: file.added,
          removed: file.removed,
          isUntracked: file.isUntracked,
          isBinary: file.isBinary,
          patchHasHunk: typeof file.patch === 'string' && file.patch.includes('@@'),
          patchSnippet: typeof file.patch === 'string' ? file.patch.slice(0, 40) : null,
        }))
      : null
    await $.store.set('vcs-observation', {
      vcs: copy?.vcs ?? null,
      root: copy?.root ?? null,
      branch: copy?.branch ?? null,
      revisionLength: typeof copy?.revision === 'string' ? copy.revision.length : null,
      base: answer?.base ?? null,
      unknown: answer?.unknown ?? null,
      files,
    })
    return next(event)
  })
}
