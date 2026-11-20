// Loaded *in place of* `dsh-anyplugin-mod-host/src/index.ts` for the
// materializer only (see run.mjs's resolve hook). Every other importer keeps
// the real module.
//
// Two wrappers, both measurement-only:
//   - `createModBridge` calls the real factory and wraps the table its
//     `dollar()` returns in the recorder's Proxy. The namespaces, methods and
//     refusals are the real ones; no namespace is reimplemented.
//   - `loadMod` calls the real loader and wraps each returned handler so the
//     recorder sees the invocation, its authored registration index and its
//     `$` (the host calls `host.dollar()` inside this wrapper's async scope).
import { basename, dirname } from 'node:path'

import * as real from '../../packages/dsh-anyplugin-mod-host/src/index.ts'
import { createModBridge as realCreateModBridge } from '../../packages/dsh-anyplugin-mod-host/src/bridge.ts'

import { beginDollar, beginInvocation, finishInvocation, invocationStore, recordingTable } from './recorder.mjs'

export * from '../../packages/dsh-anyplugin-mod-host/src/index.ts'

function modName(root) {
  const name = basename(root)
  return name === 'hooks' ? basename(dirname(root)) : name
}

export function createModBridge(options) {
  const bridge = realCreateModBridge(options)
  return {
    ...bridge,
    dollar(agent) {
      const group = beginDollar(options.plugin, agent)
      return recordingTable(bridge.dollar(agent), group)
    },
  }
}

export async function loadMod(options) {
  const handle = await real.loadMod(options)
  const mod = modName(options.root)
  const registrations = handle.registrations.map((registration, index) => {
    const original = registration.handler
    return {
      ...registration,
      handler(event, next) {
        const pending = invocationStore.getStore() ?? {}
        const record = beginInvocation({
          mod,
          entry: options.entry,
          index,
          authoredEvent: registration.event,
          kernelEvent: pending.kernelEvent ?? null,
          modEvent: pending.modEvent ?? null,
          hostSeam: pending.hostSeam ?? null,
          eventKeys:
            event !== null && typeof event === 'object' && !Array.isArray(event)
              ? Object.keys(event).sort()
              : typeof event,
        })
        // The host's per-invocation `$` is created inside this async scope, so
        // every `dollar()` and every `$` call lands on `record`.
        return invocationStore.run({ ...pending, invocation: record }, async () => {
          try {
            const result = await original(event, next)
            finishInvocation(record, 'ran')
            return result
          } catch (error) {
            finishInvocation(record, 'error', error)
            throw error
          }
        })
      },
    }
  })
  return { ...handle, registrations }
}
