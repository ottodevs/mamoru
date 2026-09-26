import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/** Static markup and its visible text, for assertions on the painted payload. */
export function render(el: ReactElement): { html: string; text: string } {
  const html = renderToStaticMarkup(el)
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
  return { html, text }
}

export function count(html: string, needle: string): number {
  return html.split(needle).length - 1
}
