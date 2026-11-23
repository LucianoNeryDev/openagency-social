import { describe, expect, it, vi } from 'vitest'
import { legacyRunnerDataDir, resolveRunnerDataDir, runnerDataDir } from '../src/runner/data-dir.js'

const only = (...present: string[]) => (path: string) => present.includes(path)

describe('runner data directory', () => {
  it('defaults to the OpenAgency Social directory', () => {
    const warn = vi.fn()
    expect(resolveRunnerDataDir(undefined, only(), warn)).toBe(runnerDataDir)
    expect(resolveRunnerDataDir(undefined, only(runnerDataDir), warn)).toBe(runnerDataDir)
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps an existing runner on the old directory and says so', () => {
    const warn = vi.fn()
    expect(resolveRunnerDataDir(undefined, only(legacyRunnerDataDir), warn)).toBe(legacyRunnerDataDir)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('prefers the new directory when both exist', () => {
    const warn = vi.fn()
    expect(resolveRunnerDataDir(undefined, only(legacyRunnerDataDir, runnerDataDir), warn)).toBe(runnerDataDir)
    expect(warn).not.toHaveBeenCalled()
  })

  it('always honours an explicit RUNNER_DATA_DIR', () => {
    const warn = vi.fn()
    expect(resolveRunnerDataDir('/data/runner', only(legacyRunnerDataDir), warn)).toBe('/data/runner')
    expect(warn).not.toHaveBeenCalled()
  })
})
