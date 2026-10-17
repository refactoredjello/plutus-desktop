import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { navItems } from '@/app/router'
import { renderAt } from '@/test/render'

describe('Layout', () => {
  it('shows every navigation item', () => {
    renderAt('/')
    for (const item of navItems) {
      expect(screen.getByRole('link', { name: new RegExp(`^${item.label}`) })).toBeInTheDocument()
    }
  })

  it('renders the overview page at the root route', () => {
    renderAt('/')
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
  })
})
