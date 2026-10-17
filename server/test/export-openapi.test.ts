/** scripts/export-openapi.ts writes the spec the way app/export_openapi.py did. */

import { describe, expect, it } from 'vitest'
import { renderOpenApi, stableJson } from '../scripts/export-openapi.js'

describe('stableJson (json.dumps(indent=2, sort_keys=True) + "\\n")', () => {
  it('sorts keys at every level and indents by two', () => {
    expect(stableJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{\n  "a": {\n    "c": null,\n    "d": [\n      3,\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n',
    )
  })

  it('writes empty containers like Python', () => {
    expect(stableJson({ a: {}, b: [] })).toBe('{\n  "a": {},\n  "b": []\n}\n')
  })

  it('escapes non-ASCII like ensure_ascii', () => {
    expect(stableJson({ s: 'child’s café 😀' })).toBe('{\n  "s": "child\\u2019s caf\\u00e9 \\ud83d\\ude00"\n}\n')
  })

  it('sorts keys by code point like Python', () => {
    expect(stableJson({ b: 1, B: 2, _: 3, a: 4 })).toBe('{\n  "B": 2,\n  "_": 3,\n  "a": 4,\n  "b": 1\n}\n')
  })
})

describe('renderOpenApi', () => {
  it('renders the app document with the health route', () => {
    const doc = JSON.parse(renderOpenApi()) as { openapi: string; info: unknown; paths: Record<string, unknown> }
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.info).toEqual({ title: 'Plutus API', version: '0.1.0' })
    expect(Object.keys(doc.paths)).toContain('/api/health')
  })
})
