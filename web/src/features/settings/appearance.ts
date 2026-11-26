import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap, type Schemas } from '@/api/client'
import { setThemePreference, themePreference } from '@/app/theme'

type Theme = Schemas['AppearanceRead']['theme']

const KEY = ['settings', 'appearance']

export const useAppearance = () =>
  useQuery({
    queryKey: KEY,
    queryFn: () => unwrap(api.GET('/api/settings/appearance')),
    // The page already shows the saved theme (the server wrote it on <html>).
    placeholderData: () => ({ theme: themePreference() }),
  })

/** Switches the theme at once, then saves it; a failed save switches back. */
export function useSetAppearance() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (theme: Theme) => unwrap(api.PUT('/api/settings/appearance', { body: { theme } })),
    onMutate: (theme) => {
      const before = themePreference()
      setThemePreference(theme)
      client.setQueryData(KEY, { theme })
      return { before }
    },
    onError: (_error, _theme, context) => {
      if (!context) return
      setThemePreference(context.before)
      client.setQueryData(KEY, { theme: context.before })
    },
  })
}

/**
 * Apply the saved theme when the page did not come from the server with it (the Vite dev
 * server, or a cached page). Quietly does nothing when the API is unreachable.
 */
export async function applySavedTheme(): Promise<void> {
  const { data } = await api.GET('/api/settings/appearance').catch(() => ({ data: undefined }))
  if (data) setThemePreference(data.theme)
}
