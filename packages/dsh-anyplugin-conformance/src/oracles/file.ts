/** Load an inventory that was captured earlier (a golden, or another host's). */
import { readFile } from 'node:fs/promises'
import { INVENTORY_SCHEMA, type Inventory } from '../inventory.ts'

export async function readInventoryFile(path: string): Promise<Inventory> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Inventory
  if (parsed?.$schema !== INVENTORY_SCHEMA) {
    throw new Error(`${path} is not an inventory (expected $schema ${INVENTORY_SCHEMA}, got ${String(parsed?.$schema)})`)
  }
  return parsed
}
