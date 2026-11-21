/**
 * A minimal, dependency-free tarball reader for marketplace artifacts.
 *
 * `npm pack` produces a gzipped ustar archive, and so does `git archive`; a
 * catalog may also serve one over `https`. All this module needs to do is turn
 * those bytes into a directory, so it implements the narrow union of those
 * writers — regular files, directories, pax path overrides and GNU long
 * names — and refuses everything else (links, devices, base-256 sizes). A
 * tarball is untrusted input: every member path is checked to stay inside the
 * destination, and both the compressed and the decompressed size are capped.
 *
 * The refusal is a `TarError`; the caller (`marketplace-fetch.ts`) maps it to a
 * typed lifecycle refusal so the user sees a code, not a stack trace.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'

export class TarError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TarError'
  }
}

export interface ExtractOptions {
  /** Leading path components to drop, e.g. npm's `package/`. Default 0. */
  stripComponents?: number
  /** Cap on the decompressed bytes written to disk. Default 256 MiB. */
  maxBytes?: number
  /** Cap on the number of members. Default 20 000. */
  maxFiles?: number
}

const BLOCK = 512
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_FILES = 20_000

/** A gzip stream starts `1f 8b`; a tarball that does not is not an artifact. */
export function isGzip(buffer: Buffer): boolean {
  return buffer.length > 1 && buffer[0] === 0x1f && buffer[1] === 0x8b
}

function field(header: Buffer, offset: number, length: number): string {
  const slice = header.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
}

function octal(header: Buffer, offset: number, length: number, what: string): number {
  const text = field(header, offset, length).trim()
  if (text === '') return 0
  if (!/^[0-7]+$/u.test(text)) throw new TarError(`tar header has a non-octal ${what} field`)
  return Number.parseInt(text, 8)
}

function checksum(header: Buffer): { stored: number; computed: number } {
  const stored = octal(header, 148, 8, 'checksum')
  let computed = 0
  for (let index = 0; index < BLOCK; index += 1) {
    computed += index >= 148 && index < 156 ? 0x20 : header[index]
  }
  return { stored, computed }
}

function padded(size: number): number {
  return Math.ceil(size / BLOCK) * BLOCK
}

/** Parse one pax record block into key/value pairs. */
function paxRecords(payload: Buffer): Map<string, string> {
  const records = new Map<string, string>()
  let cursor = 0
  while (cursor < payload.length) {
    const space = payload.indexOf(0x20, cursor)
    if (space === -1) break
    const length = Number.parseInt(payload.subarray(cursor, space).toString('utf8'), 10)
    if (!Number.isInteger(length) || length <= 0 || cursor + length > payload.length) {
      throw new TarError('tar pax header is malformed')
    }
    const record = payload.subarray(space + 1, cursor + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1))
    cursor += length
  }
  return records
}

/**
 * Turn a member name into safe path segments. Absolute paths, `..` and NUL are
 * refused; the result is always relative to the destination.
 */
function safeSegments(raw: string): string[] {
  if (raw.includes('\0')) throw new TarError('tar member name contains a NUL byte')
  if (raw.startsWith('/')) throw new TarError(`tar member "${raw}" is an absolute path`)
  if (/^[A-Za-z]:/u.test(raw)) throw new TarError(`tar member "${raw}" has a drive prefix`)
  const segments: string[] = []
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') throw new TarError(`tar member "${raw}" escapes the destination`)
    segments.push(segment)
  }
  return segments
}

/**
 * Extract a gzipped tarball into `destination` (created if needed).
 *
 * Returns the number of regular files written. The destination must be a
 * directory this process owns; callers extract into a fresh temporary
 * directory and move it into the cache only after every check passed.
 */
export function extractTarball(buffer: Buffer, destination: string, options: ExtractOptions = {}): number {
  if (!isGzip(buffer)) throw new TarError('artifact is not a gzip tarball')
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const strip = options.stripComponents ?? 0

  let data: Buffer
  try {
    // `maxOutputLength` makes the zip-bomb cap a property of the gzip reader,
    // not of a byte counter that only sees the stream after it was expanded.
    data = gunzipSync(buffer, { maxOutputLength: maxBytes + BLOCK })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new TarError(`tarball expands beyond the ${maxBytes} byte cap`)
    }
    throw new TarError(`cannot gunzip the tarball: ${(error as Error).message}`)
  }

  let offset = 0
  let files = 0
  let written = 0
  let pendingPath: string | undefined
  let done = false
  while (offset + BLOCK <= data.length && !done) {
    const header = data.subarray(offset, offset + BLOCK)
    offset += BLOCK
    if (header.every((byte) => byte === 0)) break
    const { stored, computed } = checksum(header)
    if (stored !== computed) throw new TarError('tar header checksum does not match')

    const type = field(header, 156, 1) || '0'
    const size = octal(header, 124, 12, 'size')
    if (offset + size > data.length) throw new TarError('tar member runs past the end of the archive')

    if (type === 'x' || type === 'g') {
      const records = paxRecords(data.subarray(offset, offset + size))
      if (type === 'x' && records.has('path')) pendingPath = records.get('path')
      offset += padded(size)
      continue
    }
    if (type === 'L') {
      pendingPath = data.subarray(offset, offset + size).toString('utf8').replace(/\0+$/u, '')
      offset += padded(size)
      continue
    }
    if (type === '1' || type === '2' || type === '3' || type === '4' || type === '6') {
      throw new TarError(`tar member type "${type}" (link/device) is not accepted in a plugin artifact`)
    }
    if (type !== '0' && type !== '5') throw new TarError(`tar member type "${type}" is not supported`)

    const prefix = field(header, 345, 155)
    const name = pendingPath ?? (prefix === '' ? field(header, 0, 100) : `${prefix}/${field(header, 0, 100)}`)
    pendingPath = undefined
    const segments = safeSegments(name).slice(strip)
    const isDirectory = type === '5' || name.endsWith('/')
    if (segments.length === 0) {
      if (!isDirectory && size > 0) throw new TarError(`tar member "${name}" is empty after stripping`)
      offset += padded(size)
      continue
    }
    const target = join(destination, ...segments)
    if (written + size > maxBytes) throw new TarError(`tarball exceeds the ${maxBytes} byte extraction cap`)
    if (isDirectory) {
      mkdirSync(target, { recursive: true })
    } else {
      if (files >= maxFiles) throw new TarError(`tarball has more than ${maxFiles} files`)
      mkdirSync(dirname(target), { recursive: true })
      const content = data.subarray(offset, offset + size)
      writeFileSync(target, content)
      const mode = octal(header, 100, 8, 'mode') & 0o777
      chmodSync(target, (mode & 0o111) === 0 ? 0o644 : mode & 0o755)
      files += 1
      written += size
    }
    offset += padded(size)
    if (offset >= data.length) done = true
  }
  if (files === 0) throw new TarError('tarball contains no regular files')
  return files
}
