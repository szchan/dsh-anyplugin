import { view } from './view.jsx'

export function register(on: On): void {
  on('ui.render', () => view(7))
}
