import { view } from './view.jsx'

export function register(on: On): void {
  on('never', () => view)
}
