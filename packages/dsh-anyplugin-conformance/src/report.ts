/** Rendering a DiffReport for a terminal and for CI logs. */
import type { DiffReport, DiffRow } from './inventory.ts'

const STATUS_MARK: Record<DiffRow['status'], string> = {
  match: 'ok  ',
  missing: 'MISS',
  extra: 'EXTRA',
  changed: 'DIFF',
}

export function formatDiff(report: DiffReport, options: { verbose?: boolean } = {}): string {
  const lines: string[] = []
  const { summary } = report
  lines.push(
    `inventory: ${summary.actual} observed vs ${summary.expected} expected — ` +
      `${summary.match} match, ${summary.missing} missing, ${summary.extra} extra, ${summary.changed} changed`,
  )
  if (report.pin.expected || report.pin.actual) {
    const expected = report.pin.expected ? `${report.pin.expected.tool}@${report.pin.expected.version}` : '(unpinned)'
    const actual = report.pin.actual ? `${report.pin.actual.tool}@${report.pin.actual.version}` : '(unpinned)'
    lines.push(`pin: expected ${expected}, observed ${actual}${report.pin.mismatch ? '  ← MISMATCH' : ''}`)
  }
  for (const row of report.rows) {
    if (row.status === 'match' && !options.verbose) continue
    const detail = row.detail ? `  (${row.detail})` : ''
    lines.push(`  ${STATUS_MARK[row.status]}  ${row.surface}/${row.name}${detail}`)
  }
  lines.push(report.ok ? 'result: PASS' : 'result: FAIL')
  return lines.join('\n')
}
