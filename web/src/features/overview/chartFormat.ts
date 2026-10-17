export const moneyCompact = (n: number) => {
  const abs = Math.abs(n)
  const body = abs >= 1000 ? `${+(abs / 1000).toFixed(1)}k` : String(Math.round(abs))
  return `${n < 0 ? '-' : ''}$${body}`
}
export const moneyWhole = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
