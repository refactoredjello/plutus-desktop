/**
 * The server's contains-rule matching (server/src/services/categorize.ts: casefold and
 * containsPattern), so the UI picks a default pattern the server will match the same way.
 * Keep the two in step.
 */

/** Printable ASCII, where full case folding is plain toLowerCase. */
const ASCII = /^[ -~]*$/

/** Full Unicode case folding, one code point at a time. */
export function casefold(text: string): string {
  if (ASCII.test(text)) return text.toLowerCase()
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number
    if (cp === 0x131) out += ch // dotless i has no folding
    else if (cp === 0x1e9e) out += 'ss' // capital sharp s
    else if ((cp >= 0x13a0 && cp <= 0x13fd) || (cp >= 0xab70 && cp <= 0xabbf)) out += ch.toUpperCase() // Cherokee folds to uppercase
    else out += ch.toUpperCase().toLowerCase()
  }
  return out
}

/** Does a contains rule's pattern match this raw description? */
export function containsPattern(rawDescription: string, pattern: string): boolean {
  return casefold(rawDescription).includes(casefold(pattern))
}
