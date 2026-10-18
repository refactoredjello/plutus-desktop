import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ConflictError,
  DomainError,
  NotFoundError,
  NotImplementedYetError,
  ProviderError,
  ValidationError,
  problemBody,
  validationError,
} from '../src/lib/errors.js'

describe('DomainError family', () => {
  it.each([
    [new DomainError('x'), 400, 'Bad request'],
    [new NotFoundError('x'), 404, 'Not found'],
    [new ConflictError('x'), 409, 'Conflict'],
    [new ProviderError('x'), 502, 'Upstream provider error'],
    [new NotImplementedYetError(), 501, 'Not implemented'],
  ])('%s has status %d and title %j', (error, status, title) => {
    expect(error.status).toBe(status)
    expect(error.title).toBe(title)
    expect(error).toBeInstanceOf(DomainError)
    expect(error).toBeInstanceOf(Error)
  })

  it('carries the detail as message and detail', () => {
    const error = new NotFoundError('Goal 7 not found')
    expect(error.detail).toBe('Goal 7 not found')
    expect(error.message).toBe('Goal 7 not found')
    expect(error.name).toBe('NotFoundError')
  })

  it('defaults the not-implemented detail', () => {
    expect(new NotImplementedYetError().detail).toBe('Not implemented yet')
    expect(new NotImplementedYetError('later').detail).toBe('later')
  })
})

describe('problemBody', () => {
  it('renders RFC 9457 problem details like register_error_handlers', () => {
    expect(problemBody(new ConflictError('Rule exists'), '/api/rules')).toEqual({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'Rule exists',
      instance: '/api/rules',
    })
  })
})

describe('validationError', () => {
  it('is a 422 listing every issue with its location', () => {
    const schema = z.object({ amount: z.string(), limit: z.number().int().max(500) }).strict()
    const result = schema.safeParse({ amount: 5, limit: 900 })
    expect(result.success).toBe(false)
    if (result.success) return
    const error = validationError(result.error.issues, 'body')
    expect(error).toBeInstanceOf(ValidationError)
    expect(error.status).toBe(422)
    expect(error.title).toBe('Validation error')
    expect(error.detail).toContain('body.amount: ')
    expect(error.detail).toContain('body.limit: ')
    expect(error.detail.split('; ')).toHaveLength(2)
  })

  it('names the location alone for a top-level issue', () => {
    const result = z.object({ a: z.string() }).safeParse(null)
    if (result.success) throw new Error('expected failure')
    expect(validationError(result.error.issues, 'query').detail).toMatch(/^query: /)
  })
})
