/** Money arrives from the API as a decimal string. Format it; never do float arithmetic for display totals. */
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

export function formatMoney(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return usd.format(Number(value))
}
