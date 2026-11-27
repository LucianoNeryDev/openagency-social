/** An error whose code and message are safe to return to the dashboard. */
export class EngineError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly detail?: Record<string, unknown>) {
    super(message)
    this.name = 'EngineError'
  }
}

export const notFound = (what: string) => new EngineError(404, 'not_found', `${what} not found`)
export const conflict = (code: string, message: string, detail?: Record<string, unknown>) => new EngineError(409, code, message, detail)
export const invalid = (code: string, message: string, detail?: Record<string, unknown>) => new EngineError(400, code, message, detail)
