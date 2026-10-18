import { describe, expect, it } from 'vitest'
import { ACCEPTED_NOTES, VALIDATION_MEDIA, acceptEnvelope, validationFields } from './accepted.ts'
import { type Envelope, compareResponses } from './diff.ts'

const pythonValidation = (detail: unknown[]): Envelope => ({
  status: 422,
  contentType: 'application/json',
  body: { detail } as Envelope['body'],
})

const tsValidation = (detail: string, instance = '/api/goals'): Envelope => ({
  status: 422,
  contentType: 'application/problem+json',
  body: { type: 'about:blank', title: 'Validation error', status: 422, detail, instance },
})

describe('validationFields', () => {
  it('reads FastAPI locations, joined with dots, sorted and unique', () => {
    expect(
      validationFields(
        pythonValidation([
          { type: 'string_too_short', loc: ['body', 'name'], msg: 'String should have at least 1 character' },
          { type: 'greater_than', loc: ['body', 'target_amount'], msg: 'Input should be greater than 0' },
          { type: 'date_from_datetime_parsing', loc: ['body', 'target_date'], msg: 'x' },
          { type: 'extra_forbidden', loc: ['body', 'colour'], msg: 'Extra inputs are not permitted' },
          { type: 'missing', loc: ['body', 'name'], msg: 'again' },
        ]),
      ),
    ).toEqual(['body.colour', 'body.name', 'body.target_amount', 'body.target_date'])
    expect(validationFields(pythonValidation([{ loc: ['query', 'months'], msg: 'x' }]))).toEqual(['query.months'])
    expect(validationFields(pythonValidation([{ loc: ['body'], msg: 'Field required' }]))).toEqual(['body'])
    expect(validationFields(pythonValidation([{ loc: ['body', 'items', 0], msg: 'x' }]))).toEqual(['body.items.0'])
  })

  it('reads the port\'s problem detail, "<location>.<path>: <message>" joined by "; "', () => {
    expect(
      validationFields(
        tsValidation(
          'body.name: Too small: expected string to have >=1 characters; body.target_amount: Input should be greater than 0; ' +
            'body.target_date: Invalid date: expected YYYY-MM-DD',
        ),
      ),
    ).toEqual(['body.name', 'body.target_amount', 'body.target_date'])
    expect(validationFields(tsValidation('query.months: Too big: expected number to be <=12'))).toEqual(['query.months'])
  })

  it('reads the keys Zod names in an unrecognized-keys message as fields, as FastAPI reports them', () => {
    expect(validationFields(tsValidation('body: Unrecognized key: "colour"'))).toEqual(['body.colour'])
    expect(validationFields(tsValidation('body: Unrecognized keys: "colour", "size"'))).toEqual(['body.colour', 'body.size'])
    expect(validationFields(tsValidation('body.items.0: Unrecognized key: "x"; body.name: Too small'))).toEqual([
      'body.items.0.x',
      'body.name',
    ])
    expect(validationFields(tsValidation('body: Unsupported Media Type'))).toEqual(['body'])
  })

  it('returns null for anything that is not a validation body', () => {
    expect(validationFields({ status: 422, contentType: 'application/json', body: { detail: 'text' } })).toBeNull()
    expect(validationFields({ status: 400, contentType: 'application/problem+json', body: { title: 'Bad request' } })).toBeNull()
    expect(validationFields({ ...tsValidation('body.x: y'), status: 400 })).toBeNull()
    expect(
      validationFields({
        status: 422,
        contentType: 'application/problem+json',
        body: { type: 'about:blank', title: 'Bad request', status: 422, detail: 'body.x: y', instance: '/' },
      }),
    ).toBeNull()
    expect(validationFields(pythonValidation([{ msg: 'no loc' }]))).toBeNull()
  })
})

describe('acceptEnvelope', () => {
  it('reduces both validation shapes to the same envelope holding the field list', () => {
    const python = pythonValidation([
      { type: 'less_than_equal', loc: ['query', 'months'], msg: 'Input should be less than or equal to 12', input: '13' },
    ])
    const ts = tsValidation('query.months: Too big: expected number to be <=12', '/api/projection')
    const expected: Envelope = { status: 422, contentType: VALIDATION_MEDIA, body: { invalid: ['query.months'] } }
    expect(acceptEnvelope(python)).toEqual(expected)
    expect(acceptEnvelope(ts)).toEqual(expected)
  })

  it('drops the media type of an empty 204, and nothing else', () => {
    expect(acceptEnvelope({ status: 204, contentType: 'application/json', body: null })).toEqual({
      status: 204,
      contentType: null,
      body: null,
    })
    const withBody: Envelope = { status: 204, contentType: 'text/plain', body: 'x' }
    expect(acceptEnvelope(withBody)).toEqual(withBody)
    const created: Envelope = { status: 201, contentType: 'application/json', body: null }
    expect(acceptEnvelope(created)).toEqual(created)
  })

  it('leaves every other response alone', () => {
    const problem: Envelope = {
      status: 404,
      contentType: 'application/problem+json',
      body: { type: 'about:blank', title: 'Not found', status: 404, detail: 'Goal 9 not found', instance: '/api/goals/9' },
    }
    expect(acceptEnvelope(problem)).toEqual(problem)
    const odd: Envelope = { status: 422, contentType: 'application/json', body: { detail: 'text' } }
    expect(acceptEnvelope(odd)).toEqual(odd)
  })

  it('does not mutate its input', () => {
    const python = pythonValidation([{ loc: ['body', 'name'], msg: 'x' }])
    const copy = structuredClone(python)
    acceptEnvelope(python)
    expect(python).toEqual(copy)
  })
})

describe('compareResponses with the accepted classes', () => {
  it('finds no difference between the two validation shapes on the same fields', () => {
    const python = pythonValidation([{ type: 'missing', loc: ['query', 'month'], msg: 'Field required', input: null }])
    const ts = tsValidation('query.month: Invalid input: expected string, received undefined', '/api/reports/by-category')
    expect(compareResponses(python, ts)).toEqual([])
  })

  it('still reports validation failures on different fields', () => {
    const python = pythonValidation([{ loc: ['body', 'colour'], msg: 'Extra inputs are not permitted' }])
    const ts = tsValidation('body.size: Invalid input')
    expect(compareResponses(python, ts)).toEqual([
      { path: '/body/invalid/0', expected: 'body.colour', actual: 'body.size' },
    ])
    expect(compareResponses(python, tsValidation('body: Unrecognized key: "colour"'))).toEqual([])
  })

  it('still reports a validation failure answered as something else', () => {
    const python = pythonValidation([{ loc: ['query', 'limit'], msg: 'x' }])
    const ts: Envelope = { status: 200, contentType: 'application/json', body: { items: [] } }
    const diffs = compareResponses(python, ts)
    expect(diffs[0]).toEqual({ path: '/status', expected: 422, actual: 200 })
    expect(diffs.some((d) => d.path === '/content_type')).toBe(true)
  })

  it('finds no difference between an empty 204 with and without a media type', () => {
    expect(
      compareResponses(
        { status: 204, contentType: 'application/json', body: null },
        { status: 204, contentType: null, body: null },
      ),
    ).toEqual([])
  })
})

describe('ACCEPTED_NOTES', () => {
  it('names each accepted class with its reason', () => {
    expect(ACCEPTED_NOTES).toHaveLength(2)
    for (const note of ACCEPTED_NOTES) expect(note.length).toBeGreaterThan(60)
    expect(ACCEPTED_NOTES.join(' ')).toContain('5.5')
    expect(ACCEPTED_NOTES.join(' ')).toContain('204')
  })
})
