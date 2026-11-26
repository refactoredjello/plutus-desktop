import { createContext, useContext } from 'react'
import type { Schemas } from '@/api/client'

export interface PanelOptions {
  /** Scroll to and focus the rule section. */
  section?: 'rule'
  /** Start the rule form with this category (after a category change on the row). */
  categoryId?: number
  /** Called once when the panel closes or opens another transaction. */
  onClose?: () => void
}

export interface TransactionPanelApi {
  open: (txn: Schemas['TransactionRead'], options?: PanelOptions) => void
  /** The transaction the panel shows while open (rows mark it), else null. */
  openId: number | null
}

export const TransactionPanelContext = createContext<TransactionPanelApi | null>(null)

/** Open the one transaction side panel from any page. */
export function useTransactionPanel(): TransactionPanelApi {
  const api = useContext(TransactionPanelContext)
  if (api === null) throw new Error('useTransactionPanel needs a TransactionPanelProvider')
  return api
}
