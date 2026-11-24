/**
 * The AnyPlugin panel's browser half.
 *
 * A prebuilt `dsh.client` bundle inside the same install as the loader row
 * (D77): `scripts/build.mjs` turns this module into
 * `window.__ModuleLoader__.load({ id: 'dsh-anyplugin', factory })` with
 * `react` left to the host's module table. The id is the package name, which
 * is the row id the client-module registry keys on. Nothing else is imported —
 * the panel is a reader of `/anyplugin/installs` and a form around
 * `/anyplugin/install`, not a second lifecycle implementation.
 *
 * The panel renders into the `settings.section` slot. It uses only
 * `--dsw-alias-*` theme tokens and its own class-free inline styles; the Harness
 * Client packages are not imported (dsh-doc's ui-plugin rules), so a host that
 * changes its primitives cannot break the panel.
 *
 * The same bundle also mounts the derived renderer bridge of #281 slice 1
 * (`./renderer.js`): a keyed `main` pane and an additive `shell.overlay` line,
 * plus one declarable keyboard command through `ctx.shortcuts`. Every face it
 * serves is class `derived` with a reason, and its vocabulary is deliberately
 * Box/Text/Button/Input. The bridge is additive: its registrations are wrapped
 * per seat so a host that drops one seat still gets the settings panel.
 */
import { createElement, useEffect, useState } from 'react'

import { createRendererBridge, registerRendererKeyboard } from './renderer.js'

const PREFIX = '/anyplugin'

// One bridge instance per loaded client module: one store, one round-trip
// counter, one focus target shared by the main pane and the overlay line.
const renderer = createRendererBridge({ createElement, useEffect, useState })

const styles = {
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    padding: '4px 0 16px',
    color: 'var(--dsw-alias-text-primary, inherit)',
  },
  title: { margin: 0, fontSize: '16px', fontWeight: 600 },
  muted: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-text-secondary, #6b7280)' },
  error: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-text-danger, #b91c1c)' },
  ok: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-text-success, #15803d)' },
  warn: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-text-warning, #b45309)' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
  head: {
    textAlign: 'left',
    padding: '6px 8px',
    borderBottom: '1px solid var(--dsw-alias-border-secondary, #e5e7eb)',
    color: 'var(--dsw-alias-text-secondary, #6b7280)',
    fontWeight: 500,
  },
  cell: {
    textAlign: 'left',
    padding: '8px',
    borderBottom: '1px solid var(--dsw-alias-border-secondary, #e5e7eb)',
    verticalAlign: 'top',
  },
  name: { fontFamily: 'var(--dsw-alias-font-mono, ui-monospace, monospace)', fontSize: '12px' },
  form: { display: 'flex', flexDirection: 'column', gap: '6px', paddingTop: '4px' },
  label: { fontSize: '12px', color: 'var(--dsw-alias-text-secondary, #6b7280)' },
  row: { display: 'flex', gap: '8px' },
  input: {
    flex: 1,
    minWidth: 0,
    padding: '6px 8px',
    fontSize: '13px',
    color: 'var(--dsw-alias-text-primary, inherit)',
    background: 'var(--dsw-alias-bg-secondary, transparent)',
    border: '1px solid var(--dsw-alias-border-secondary, #d1d5db)',
    borderRadius: '6px',
  },
  button: {
    padding: '6px 12px',
    fontSize: '13px',
    color: 'var(--dsw-alias-text-on-accent, #fff)',
    background: 'var(--dsw-alias-bg-accent, #2563eb)',
    border: '1px solid var(--dsw-alias-border-accent, #2563eb)',
    borderRadius: '6px',
    cursor: 'pointer',
  },
}

function enabledLabel(plugin) {
  if (plugin.scope === null) return 'inert (no layer mentions it)'
  return `${plugin.enabled ? 'enabled' : 'disabled'} at ${plugin.scope}`
}

function row(plugin) {
  return createElement(
    'tr',
    { key: plugin.id },
    createElement('td', { style: styles.cell }, createElement('span', { style: styles.name }, plugin.name ?? plugin.id)),
    createElement('td', { style: styles.cell }, plugin.dialect ?? ''),
    createElement('td', { style: styles.cell }, plugin.version ?? ''),
    createElement('td', { style: styles.cell }, enabledLabel(plugin)),
  )
}

function Panel() {
  const [plugins, setPlugins] = useState([])
  const [status, setStatus] = useState({ loading: true, error: null })
  const [revision, setRevision] = useState(0)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)

  useEffect(() => {
    let live = true
    setStatus({ loading: true, error: null })
    fetch(`${PREFIX}/installs`)
      .then((response) => response.json())
      .then((body) => {
        if (!live) return
        setPlugins(Array.isArray(body.plugins) ? body.plugins : [])
        setStatus({ loading: false, error: body.ok === false ? body.reason ?? 'refused' : null })
      })
      .catch((error) => {
        if (live) setStatus({ loading: false, error: String(error) })
      })
    return () => {
      live = false
    }
  }, [revision])

  async function submit(event) {
    event.preventDefault()
    if (busy || path.trim() === '') return
    setBusy(true)
    setMessage(null)
    try {
      const response = await fetch(`${PREFIX}/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      })
      const body = await response.json()
      if (body.ok) {
        const refused = body.report?.totals?.refused ?? 0
        const first = refused > 0 ? body.report?.components?.find((component) => component.refused) : undefined
        const detail = first?.reason ? ` — ${first.reason}` : ''
        setMessage({
          tone: refused > 0 ? 'warn' : 'ok',
          text: refused > 0
            ? `installed ${body.plugin}; ${refused} component${refused === 1 ? '' : 's'} refused${detail}`
            : `installed ${body.plugin}`,
        })
        setPath('')
        setRevision((value) => value + 1)
      } else {
        setMessage({ tone: 'error', text: `${body.code ?? 'refused'}: ${body.reason ?? ''}` })
      }
    } catch (error) {
      setMessage({ tone: 'error', text: String(error) })
    } finally {
      setBusy(false)
    }
  }

  const rows =
    plugins.length === 0
      ? [createElement('tr', { key: 'empty' }, createElement('td', { style: styles.cell, colSpan: 4 }, 'No foreign plugins installed.'))]
      : plugins.map(row)

  return createElement(
    'section',
    { style: styles.panel, 'data-anyplugin-panel': '' },
    createElement('h2', { style: styles.title }, 'AnyPlugin'),
    createElement('p', { style: styles.muted }, 'Foreign plugins in this profile, as installs.yml records them.'),
    status.error === null ? null : createElement('p', { style: styles.error }, status.error),
    createElement(
      'table',
      { style: styles.table },
      createElement(
        'thead',
        null,
        createElement(
          'tr',
          null,
          createElement('th', { style: styles.head }, 'Plugin'),
          createElement('th', { style: styles.head }, 'Dialect'),
          createElement('th', { style: styles.head }, 'Version'),
          createElement('th', { style: styles.head }, 'Enabled'),
        ),
      ),
      createElement('tbody', null, rows),
    ),
    createElement(
      'form',
      { style: styles.form, onSubmit: submit },
      createElement('label', { style: styles.label, htmlFor: 'anyplugin-path' }, 'Install from a local path'),
      createElement(
        'div',
        { style: styles.row },
        createElement('input', {
          id: 'anyplugin-path',
          style: styles.input,
          value: path,
          placeholder: '/path/to/claude-plugin',
          disabled: busy,
          onChange: (event) => setPath(event.target.value),
        }),
        createElement(
          'button',
          { type: 'submit', style: styles.button, disabled: busy || path.trim() === '' },
          busy ? 'Installing…' : 'Install',
        ),
      ),
      message === null
        ? null
        : createElement('p', { style: message.tone === 'ok' ? styles.ok : message.tone === 'warn' ? styles.warn : styles.error }, message.text),
    ),
  )
}

// `slots` is the only hard requirement. The `main` and `shell.overlay` seats
// and the keyboard service are optional: each is read/registered through a
// guarded path, so a host that lacks one keeps the settings panel instead of
// failing the whole module on an unmet injection.
export const inject = ['slots']

export function apply(ctx) {
  const disposables = []

  // The handshake every shipped settings section uses: `inject` makes the
  // parent slot visible for this plugin fiber and hands the factory's cleanup
  // (the unregister) to that fiber. A bare `register` throws
  // `slot "settings.section" is not declared` on a fresh SlotCore.
  const mount = (label, open) => {
    try {
      const dispose = open()
      if (typeof dispose === 'function') disposables.push(dispose)
    } catch (error) {
      // S25 measured both seats at both pins, but this bundle stays additive:
      // a host without `main` or `shell.overlay` keeps the settings panel and
      // gets a spoken reason instead of a failed module.
      console.warn(`dsh-anyplugin: could not mount the ${label} seat: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  mount('settings.section', () =>
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        { name: 'settings.section', id: 'anyplugin-ui', order: 45, label: () => 'AnyPlugin' },
        Panel,
      ),
    ),
  )
  // The keyed `main` seat (S25 primitive 1): the host layout places this pane,
  // we do not. One key, one pane.
  mount('main', () =>
    ctx.slots.inject('main', () =>
      ctx.slots.register({ name: 'main', key: 'anyplugin.renderer' }, renderer.Pane),
    ),
  )
  // The additive `shell.overlay` seat (S25 primitive 1): an extra line of ours,
  // not a mod surface the host places or focuses.
  mount('shell.overlay', () =>
    ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register({ name: 'shell.overlay', id: 'anyplugin.renderer' }, renderer.Overlay),
    ),
  )
  // Keyboard through the declarable-command service (S25 primitive 3), never a
  // document listener of our own. The service is optional — `inject` lists only
  // `slots` — and the registration is guarded like a seat: a host whose
  // shortcuts service throws keeps the panel and gets a spoken reason.
  mount('keyboard shortcut', () =>
    registerRendererKeyboard(ctx, { store: renderer.store, focus: renderer.focus }),
  )

  return () => {
    for (const dispose of disposables.reverse()) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        // A disposed seat must not stop the other seats' cleanup.
      }
    }
  }
}
