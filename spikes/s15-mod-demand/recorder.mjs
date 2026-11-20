// The S15 recorder. It observes the *real* mod host: the two shims in this
// directory wrap `createModBridge` (so every `$` the host hands a handler is a
// Proxy over the real table) and `modRegistrationsToKernel` (so the kernel
// event name and the host seam are known when a handler runs). Neither shim
// replaces a namespace or a dispatcher; the table they wrap is the one
// `bridge.dollar()` built, and the handlers they wrap are the ones `loadMod`
// returned.
//
// The ledger keeps argument *key names* and never argument values. A call site
// is `{namespace, method, args: ['{cwd}', 'string']}`; the values are not
// copied, so a token, a prompt or a path cannot leak into the report.
import { AsyncLocalStorage } from 'node:async_hooks'

/** The invocation (`loadMod` handler) currently running on this async stack. */
export const invocationStore = new AsyncLocalStorage()

export const ledger = {
  /** One entry per adapted registration the kernel actually invoked. */
  invocations: [],
  /** One entry per `host.dollar()` call (D36: one per handler, one for catch). */
  dollars: [],
  /** Flattened calls, in wall-clock order, each carrying its dollar group. */
  calls: [],
  warnings: [],
}

let invocationSeq = 0
let dollarSeq = 0

export function beginInvocation(info) {
  const record = {
    id: ++invocationSeq,
    mod: info.mod,
    entry: info.entry,
    index: info.index,
    authoredEvent: info.authoredEvent,
    kernelEvent: info.kernelEvent,
    modEvent: info.modEvent,
    hostSeam: info.hostSeam,
    eventKeys: info.eventKeys,
    startedAt: new Date().toISOString(),
    startedPerf: performance.now(),
    status: 'running',
    dollars: [],
    calls: [],
  }
  ledger.invocations.push(record)
  return record
}

export function finishInvocation(record, status, error) {
  record.status = status
  record.durationMs = Math.round(performance.now() - (record.startedPerf ?? performance.now()))
  if (error !== undefined) record.error = describeError(error)
}

export function currentInvocation() {
  return invocationStore.getStore()?.invocation
}

export function beginDollar(plugin, agent) {
  const invocation = currentInvocation()
  const group = {
    id: ++dollarSeq,
    plugin,
    invocationId: invocation?.id ?? null,
    sessionId: sessionIdOf(agent),
    calls: [],
  }
  ledger.dollars.push(group)
  if (invocation !== undefined) {
    invocation.dollars.push(group.id)
    recordGroup(invocation, group)
  }
  return group
}

function recordGroup(invocation, group) {
  // The group is created before its calls exist; store a reference so the
  // invocation can render the calls when the dollar is used.
  invocation.dollarGroups ??= []
  invocation.dollarGroups.push(group)
}

function sessionIdOf(agent) {
  const id = agent?.session?.id ?? agent?.id
  return typeof id === 'string' ? id : null
}

/**
 * A Proxy over the real namespace table. Methods are called on the original
 * namespace (this is the real implementation, not a copy), and reads are
 * recorded by type only.
 */
export function recordingTable(table, group) {
  const namespaceProxies = new Map()
  for (const namespace of Object.keys(table)) {
    const value = table[namespace]
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      // The host table is namespaces only; a scalar would be a host change.
      ledger.warnings.push(`$ namespace '${namespace}' is ${typeof value}, not an object`)
      continue
    }
    namespaceProxies.set(namespace, proxyNamespace(namespace, value, group))
  }
  return new Proxy(table, {
    get(target, property, receiver) {
      if (typeof property !== 'string') return Reflect.get(target, property, receiver)
      const direct = namespaceProxies.get(property)
      if (direct !== undefined) return direct
      // A namespace added by a future host is still observable as a read.
      return Reflect.get(target, property, receiver)
    },
  })
}

function proxyNamespace(namespace, target, group) {
  const methodCache = new Map()
  const readOnly = new Set()
  return new Proxy(target, {
    get(ns, property, receiver) {
      if (typeof property !== 'string') return Reflect.get(ns, property, receiver)
      if (!(property in ns)) {
        // Do not fake a method: the mod's own call throws, and the report says
        // the namespace does not carry it.
        record(group, {
          kind: 'missing',
          namespace,
          method: property,
          args: [],
          outcome: 'missing',
        })
        return undefined
      }
      const value = Reflect.get(ns, property, receiver)
      if (typeof value === 'function') {
        const cached = methodCache.get(property)
        if (cached !== undefined) return cached
        const wrapped = (...args) => {
          const call = {
            kind: 'call',
            namespace,
            method: property,
            args: args.map(argShape),
            outcome: 'returned',
          }
          record(group, call)
          let result
          try {
            result = Reflect.apply(value, ns, args)
          } catch (error) {
            call.outcome = outcomeOf(error)
            call.error = describeError(error)
            throw error
          }
          if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
            call.outcome = 'pending'
            return result.then(
              (valueResolved) => {
                call.outcome = 'resolved'
                return valueResolved
              },
              (error) => {
                call.outcome = outcomeOf(error)
                call.error = describeError(error)
                throw error
              },
            )
          }
          return result
        }
        methodCache.set(property, wrapped)
        return wrapped
      }
      if (!readOnly.has(property)) {
        readOnly.add(property)
        record(group, {
          kind: 'read',
          namespace,
          method: property,
          args: [],
          outcome: 'read',
          valueType: typeof value,
        })
      }
      return value
    },
  })
}

function record(group, call) {
  call.at = new Date().toISOString()
  group.calls.push(call)
  ledger.calls.push(call)
  const invocation = currentInvocation()
  if (invocation !== undefined && !invocation.calls.includes(call)) invocation.calls.push(call)
}

function outcomeOf(error) {
  const code = typeof error?.code === 'string' ? error.code : undefined
  if (code !== undefined) return `refused:${code}`
  return `threw:${error?.name ?? 'Error'}`
}

export function describeError(error) {
  if (error === null || error === undefined) return { name: 'Error', message: String(error) }
  const code = typeof error.code === 'string' ? error.code : undefined
  const message = typeof error.message === 'string' ? error.message : String(error)
  return {
    ...(code === undefined ? {} : { code }),
    name: typeof error.name === 'string' ? error.name : 'Error',
    message: message.length > 300 ? `${message.slice(0, 297)}...` : message,
  }
}

/**
 * Argument shape without the argument: top-level key names for a record, item
 * key names for an array of records, and `typeof` for everything else.
 */
export function argShape(arg) {
  if (arg === null) return 'null'
  if (Array.isArray(arg)) {
    const keys = new Set()
    for (const item of arg) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        for (const key of Object.keys(item)) keys.add(key)
      }
    }
    return keys.size === 0 ? 'array' : `array<{${[...keys].sort().join(',')}}>`
  }
  if (typeof arg === 'object') {
    const keys = Object.keys(arg)
    return keys.length === 0 ? 'object' : `{${keys.sort().join(',')}}`
  }
  return typeof arg
}

/** A stable, value-free view of everything recorded so far. */
export function snapshot() {
  return {
    invocations: ledger.invocations.map((invocation) => ({
      id: invocation.id,
      mod: invocation.mod,
      entry: invocation.entry,
      index: invocation.index,
      authoredEvent: invocation.authoredEvent,
      kernelEvent: invocation.kernelEvent,
      modEvent: invocation.modEvent,
      hostSeam: invocation.hostSeam,
      eventKeys: invocation.eventKeys,
      status: invocation.status,
      error: invocation.error,
      dollars: invocation.dollarGroups?.map((group) => ({
        id: group.id,
        sessionId: group.sessionId,
        calls: group.calls.map((call) => ({
          kind: call.kind,
          namespace: call.namespace,
          method: call.method,
          args: call.args,
          outcome: call.outcome,
          ...(call.error === undefined ? {} : { error: call.error }),
        })),
      })) ?? [],
    })),
    dollars: ledger.dollars.map((group) => ({
      id: group.id,
      plugin: group.plugin,
      invocationId: group.invocationId,
      sessionId: group.sessionId,
      calls: group.calls.map((call) => ({
        kind: call.kind,
        namespace: call.namespace,
        method: call.method,
        args: call.args,
        outcome: call.outcome,
        ...(call.error === undefined ? {} : { error: call.error }),
      })),
    })),
    warnings: ledger.warnings,
  }
}
