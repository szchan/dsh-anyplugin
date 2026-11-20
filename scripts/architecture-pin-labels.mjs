// R12: a claude-code.d.ts line citation is only verifiable against a pin.
//
// Line numbers move whenever the pin moves (the 2.1.322 -> 2.1.329 bump moved
// Next from 5271-5352 to 8289-8367). A bare citation silently rots, so every
// line that cites the file must also name 2.1.322, 2.1.329, or the word "pin".
// Citations of other packages' .d.ts files are out of scope: they do not move
// with this pin.
import { readFileSync } from 'node:fs'

const REF = /(?:claude-code\.)?d\.ts:\d+/
const HAS_PIN = /2\.1\.322|2\.1\.329|\bpin\b/
const OTHER_PACKAGE = /dsh-|@deepseek-ai/

/**
 * Return one entry per line that cites a claude-code `.d.ts` line without
 * naming the pin on that same line.
 *
 * @param {readonly string[]} files absolute paths
 * @returns {{file: string, line: number, message: string}[]}
 */
export function pinLabelViolations(files) {
  const violations = []
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n')
    for (const [index, line] of lines.entries()) {
      if (!REF.test(line) || OTHER_PACKAGE.test(line) || HAS_PIN.test(line)) continue
      violations.push({
        file,
        line: index + 1,
        message: `claude-code.d.ts line citation needs the pin on the same line (2.1.322, 2.1.329, or "pin"): ${line.trim()}`,
      })
    }
  }
  return violations
}
