import { after } from 'node:test'

// Production retry and watchdog timers are intentionally unref'ed so they do
// not keep an otherwise idle host process alive. Tests that await such work
// need one bounded referenced handle; release it after the suite finishes.
export function keepTestProcessAlive(maxMs = 60_000) {
  const timer = setTimeout(() => {}, maxMs)
  after(() => clearTimeout(timer))
  return timer
}
