import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { toast } from 'sonner'
import { resetMockState } from '@/mocks/handlers'
import { server } from '@/mocks/server'
import { installMatchMedia, setReducedMotion } from './motion'

installMatchMedia()
// Sonner captures the pointer to let a toast be swiped away; jsdom has no pointer capture.
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.hasPointerCapture ??= () => false

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  resetMockState()
  setReducedMotion(false)
  toast.dismiss()
  cleanup()
})
afterAll(() => server.close())
