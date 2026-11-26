import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { server } from '@/mocks/server'
import { renderAt } from '@/test/render'

const root = document.documentElement

describe('Appearance setting', () => {
  afterEach(() => {
    root.classList.remove('dark')
    delete root.dataset.theme
  })

  it('offers System, Light, and Dark, with System chosen at first', async () => {
    renderAt('/settings')
    const group = await screen.findByRole('radiogroup', { name: 'Appearance' })
    expect(group).toBeInTheDocument()
    expect(await screen.findByRole('radio', { name: 'System' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Light' })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: 'Dark' })).not.toBeChecked()
  })

  it('switches the theme at once and saves the choice', async () => {
    const saved: unknown[] = []
    server.use(
      http.put('/api/settings/appearance', async ({ request }) => {
        saved.push(await request.clone().json())
        return undefined
      }),
    )
    const user = userEvent.setup()
    renderAt('/settings')
    await user.click(await screen.findByRole('radio', { name: 'Dark' }))
    expect(root).toHaveClass('dark')
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked()
    await waitFor(() => expect(saved).toEqual([{ theme: 'dark' }]))
    await user.click(screen.getByRole('radio', { name: 'Light' }))
    expect(root).not.toHaveClass('dark')
    await waitFor(() => expect(saved).toEqual([{ theme: 'dark' }, { theme: 'light' }]))
  })
})
