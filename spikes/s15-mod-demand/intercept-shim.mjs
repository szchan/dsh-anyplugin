// Loaded *in place of* `dsh-anyplugin-intercept/src/index.ts` for the
// materializer only. `modRegistrationsToKernel` is the real adapter; the
// wrapper records the kernel event and host seam around each adapted `run`,
// which is where the load-side shim finds them when the host builds `$`.
import * as real from '../../packages/dsh-anyplugin-intercept/src/index.ts'

import { invocationStore } from './recorder.mjs'

export * from '../../packages/dsh-anyplugin-intercept/src/index.ts'

export function modRegistrationsToKernel(registrations, options) {
  const result = real.modRegistrationsToKernel(registrations, options)
  for (const { registration, route } of result.routes) {
    const original = registration.run
    registration.run = (context, kernelEvent, next) =>
      invocationStore.run(
        {
          ...(invocationStore.getStore() ?? {}),
          kernelEvent: kernelEvent?.name ?? null,
          modEvent: route.modEvent,
          hostSeam: route.hostSeam,
        },
        () => original(context, kernelEvent, next),
      )
  }
  return result
}
