/**
 * Domain errors raised by services, mapped to RFC 9457 problem details. Ports app/errors.py.
 * Framework-free: app.ts's error handler turns these into responses.
 */

export class DomainError extends Error {
  readonly status: number = 400
  readonly title: string = 'Bad request'
  readonly detail: string

  constructor(detail: string) {
    super(detail)
    this.detail = detail
    this.name = new.target.name
  }
}

export class NotFoundError extends DomainError {
  override readonly status = 404
  override readonly title = 'Not found'
}

export class ConflictError extends DomainError {
  override readonly status = 409
  override readonly title = 'Conflict'
}

export class ProviderError extends DomainError {
  override readonly status = 502
  override readonly title = 'Upstream provider error'
}

/** Raised by Wave 0 route stubs until the owning agent implements them. */
export class NotImplementedYetError extends DomainError {
  override readonly status = 501
  override readonly title = 'Not implemented'

  constructor(detail = 'Not implemented yet') {
    super(detail)
  }
}

/** Request validation failure. FastAPI answered 422; the port keeps the status (plan 5.5). */
export class ValidationError extends DomainError {
  override readonly status = 422
  override readonly title = 'Validation error'
}

export interface Problem {
  type: string
  title: string
  status: number
  detail: string
  instance: string
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json'

/** The body register_error_handlers sends for a DomainError. */
export function problemBody(error: DomainError, instance: string): Problem {
  return {
    type: 'about:blank',
    title: error.title,
    status: error.status,
    detail: error.detail,
    instance,
  }
}

export interface Issue {
  readonly path: readonly PropertyKey[]
  readonly message: string
}

/** A ValidationError whose detail lists each issue as "<location>.<path>: <message>". */
export function validationError(issues: readonly Issue[], location: string): ValidationError {
  const detail = issues
    .map((issue) => {
      const path = [location, ...issue.path.map(String)].join('.')
      return `${path}: ${issue.message}`
    })
    .join('; ')
  return new ValidationError(detail)
}
