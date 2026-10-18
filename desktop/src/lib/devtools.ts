/** PLUTUS_DEVTOOLS=1 opens the DevTools panel with the window, in dev builds only. */

export function shouldOpenDevTools(inputs: {
  isPackaged: boolean
  env: Record<string, string | undefined>
}): boolean {
  return !inputs.isPackaged && inputs.env.PLUTUS_DEVTOOLS === '1'
}
