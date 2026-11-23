import { existsSync } from 'node:fs'
import { log } from '../log.js'

export const runnerDataDir = '/var/lib/openagency-social-runner'
/** The default before the rename to OpenAgency Social; deprecated, dropped in wave 3c. */
export const legacyRunnerDataDir = '/var/lib/leonessa-browser-runner'

/**
 * The runner's data directory. An explicit RUNNER_DATA_DIR always wins. When it is unset, an
 * existing runner keeps using the old default directory as long as the new one does not exist
 * yet, so its browser profiles and queued actions survive the rename.
 */
export function resolveRunnerDataDir(
  configured: string | undefined,
  exists: (path: string) => boolean = existsSync,
  warn: (message: string, fields: Record<string, unknown>) => void = (message, fields) => log('warn', message, fields),
) {
  if (configured) return configured
  if (!exists(runnerDataDir) && exists(legacyRunnerDataDir)) {
    warn('runner keeps using its previous data directory; move it to the new default or set RUNNER_DATA_DIR', { dataDir: legacyRunnerDataDir, newDefault: runnerDataDir })
    return legacyRunnerDataDir
  }
  return runnerDataDir
}
