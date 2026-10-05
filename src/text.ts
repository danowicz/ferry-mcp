import { Marked } from 'marked'

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    // Agents write Markdown, not HTML: show raw HTML as text.
    html({ text }) {
      return escapeHtml(text)
    },
    link({ href, text }) {
      return `<a href="${escapeAttr(href)}" target="_blank" rel="noreferrer">${escapeHtml(text)}</a>`
    },
  },
})

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;')
}

export function markdown(text: string | undefined): string | undefined {
  if (!text?.trim()) return undefined
  return (marked.parse(text.trim()) as string).trim()
}

/** Single-line formatting for titles and labels: `code`, **bold**, *accent*. */
export function inline(text: string | undefined): string | undefined {
  if (!text) return undefined
  const parts = text.split(/(`[^`]+`)/g)
  return parts
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return `<code>${escapeHtml(part.slice(1, -1))}</code>`
      return escapeHtml(part)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?=[^*\w]|$)/g, '$1<em>$2</em>')
    })
    .join('')
}

/** Plain text for speech: strips Markdown punctuation. */
export function plain(text: string | undefined): string | undefined {
  if (!text?.trim()) return undefined
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*?([^*]+)\*\*?/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[#>\-*\s]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return clip(slug, max).replace(/-+$/, '') || 'slide'
}

/** Shortens a slug at a word boundary. */
export function clip(slug: string, max: number): string {
  if (slug.length <= max) return slug
  const cut = slug.slice(0, max + 1)
  const at = cut.lastIndexOf('-')
  return at > max / 2 ? cut.slice(0, at) : slug.slice(0, max)
}
