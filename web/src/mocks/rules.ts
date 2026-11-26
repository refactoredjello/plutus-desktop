import { http, HttpResponse } from 'msw'
import type { Schemas } from '@/api/client'
import { transactions } from './transactions'

type Rule = Schemas['RuleRead']

const initial = (): Rule[] => [
  { id: 1, match_type: 'exact', pattern: 'NETFLIX.COM CA', category_id: 10, essentiality: 'discretionary', created_at: '2026-09-20T10:00:00Z' },
  { id: 2, match_type: 'prefix', pattern: 'SHELL OIL', category_id: 12, essentiality: null, created_at: '2026-09-21T10:00:00Z' },
  { id: 3, match_type: 'contains', pattern: 'PAYPAL INST XFER JANEDOE', category_id: 11, essentiality: null, created_at: '2026-09-22T10:00:00Z' },
]

export let rules: Rule[] = initial()

export function resetRules() {
  rules = initial()
}

/** As the server stores it: stripped; exact and prefix collapsed and upper-cased. */
const normalize = (matchType: Rule['match_type'], pattern: string) =>
  matchType === 'contains' ? pattern.trim() : pattern.trim().replace(/\s+/g, ' ').toUpperCase()

type Txn = Schemas['TransactionRead']

/**
 * Roughly the server's matching: exact and prefix on the merchant key, contains on the
 * description. Ignores case throughout, since mock merchant keys are lower-case slugs.
 */
function matches(r: Pick<Rule, 'match_type' | 'pattern'>, t: Txn): boolean {
  const pattern = r.pattern.toLowerCase()
  const key = t.merchant_key?.toLowerCase() ?? ''
  if (r.match_type === 'exact') return key === pattern
  if (r.match_type === 'prefix') return key !== '' && key.startsWith(pattern)
  return t.raw_description.toLowerCase().includes(pattern)
}

/** Exact beats contains beats prefix; the longest contains or prefix pattern wins. */
function matchingRule(t: Txn): Rule | null {
  if (t.is_transfer) return null
  const rank = { exact: 0, contains: 1, prefix: 2 }
  const hits = rules
    .filter((r) => matches(r, t))
    .sort((a, b) => rank[a.match_type] - rank[b.match_type] || b.pattern.length - a.pattern.length)
  return hits[0] ?? null
}

export const ruleHandlers = [
  http.get('/api/transactions/:id/rule', ({ params }) => {
    const t = transactions.find((x) => x.id === Number(params.id))
    if (!t) return HttpResponse.json({ title: 'Not Found', status: 404, detail: 'Transaction not found' }, { status: 404 })
    const payee = t.payee?.trim()
    return HttpResponse.json<Schemas['TransactionRuleRead']>({
      rule: matchingRule(t),
      suggestion: {
        match_type: 'exact',
        pattern: t.merchant_key ?? t.raw_description.toUpperCase(),
        contains_pattern: payee && t.raw_description.toLowerCase().includes(payee.toLowerCase()) ? payee : t.raw_description,
        category_id: t.categorization?.category_id ?? null,
        essentiality: t.categorization?.essentiality ?? null,
      },
    })
  }),
  http.post('/api/rules/preview', async ({ request }) => {
    const body = (await request.json()) as Schemas['RulePreview']
    const rule = { match_type: body.match_type, pattern: normalize(body.match_type, body.pattern) }
    const hit = transactions.filter((t) => !t.is_transfer && matches(rule, t))
    return HttpResponse.json<Schemas['RulePreviewRead']>({
      matches: hit.length,
      manual: hit.filter((t) => t.categorization?.source === 'manual').length,
    })
  }),
  http.get('/api/rules', () => HttpResponse.json<Rule[]>(rules)),
  http.post('/api/rules', async ({ request }) => {
    const body = (await request.json()) as Schemas['RuleCreate']
    const pattern = normalize(body.match_type, body.pattern)
    const fields = { category_id: body.category_id, essentiality: body.essentiality ?? null }
    const existing = rules.find((r) => r.match_type === body.match_type && r.pattern === pattern)
    const rule: Rule = existing
      ? { ...existing, ...fields }
      : { id: Math.max(0, ...rules.map((r) => r.id)) + 1, match_type: body.match_type, pattern, ...fields, created_at: new Date().toISOString() }
    rules = existing ? rules.map((r) => (r.id === rule.id ? rule : r)) : [...rules, rule]
    return HttpResponse.json<Rule>(rule)
  }),
  http.patch('/api/rules/:id', async ({ params, request }) => {
    const body = (await request.json()) as Partial<Schemas['RuleCreate']>
    const current = rules.find((r) => r.id === Number(params.id))
    if (!current) return HttpResponse.json({ title: 'Not Found', status: 404, detail: 'Rule not found' }, { status: 404 })
    const match_type = body.match_type ?? current.match_type
    const pattern = normalize(match_type, body.pattern ?? current.pattern)
    if (rules.some((r) => r.id !== current.id && r.match_type === match_type && r.pattern === pattern)) {
      return HttpResponse.json({ title: 'Conflict', status: 409, detail: 'A rule with this match already exists' }, { status: 409 })
    }
    const rule: Rule = {
      ...current,
      match_type,
      pattern,
      category_id: body.category_id ?? current.category_id,
      essentiality: body.essentiality === undefined ? current.essentiality : body.essentiality,
    }
    rules = rules.map((r) => (r.id === rule.id ? rule : r))
    return HttpResponse.json<Rule>(rule)
  }),
  http.delete('/api/rules/:id', ({ params }) => {
    rules = rules.filter((r) => r.id !== Number(params.id))
    return new HttpResponse(null, { status: 204 })
  }),
]
