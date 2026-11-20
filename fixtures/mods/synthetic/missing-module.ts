import { nothing } from './nowhere.js'

export function register(on: On): void {
  on('never', () => nothing)
}
