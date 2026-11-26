import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Schemas } from '@/api/client'
import { TransactionPanel } from '@/features/transactions/TransactionPanel'
import { TransactionPanelContext, type PanelOptions } from './transactionPanel'

interface Shown {
  txn: Schemas['TransactionRead']
  options: PanelOptions
  /** Each open starts the panel afresh. */
  serial: number
}

/** Holds which transaction the side panel shows, and renders the panel once for the whole app. */
export function TransactionPanelProvider({ children }: { children: ReactNode }) {
  // Kept after closing, so the panel still has content while it slides out.
  const [shown, setShown] = useState<Shown | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const onClose = useRef<(() => void) | undefined>(undefined)

  const notifyClosed = () => {
    const callback = onClose.current
    onClose.current = undefined
    callback?.()
  }

  const open = useCallback((txn: Schemas['TransactionRead'], options: PanelOptions = {}) => {
    notifyClosed()
    onClose.current = options.onClose
    setShown((prev) => ({ txn, options, serial: (prev?.serial ?? 0) + 1 }))
    setIsOpen(true)
  }, [])

  const openId = isOpen && shown ? shown.txn.id : null
  const api = useMemo(() => ({ open, openId }), [open, openId])

  return (
    <TransactionPanelContext.Provider value={api}>
      {children}
      {shown && (
        <TransactionPanel
          key={shown.serial}
          txn={shown.txn}
          options={shown.options}
          open={isOpen}
          onOpenChange={(next) => {
            setIsOpen(next)
            if (!next) notifyClosed()
          }}
        />
      )}
    </TransactionPanelContext.Provider>
  )
}
