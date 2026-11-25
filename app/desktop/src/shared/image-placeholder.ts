// Text sent when the message has only images: the agent (Claude API) rejects an empty text block, so the host always wants a text.
// Pure module: used by the window (composer and chat), the remote gateway (messages from the phone) and the phone app (to hide it in the message).
import { t } from './i18n.ts'

export const imagePlaceholder = (count: number): string => (count === 1 ? t('(image attached)') : t('(images attached)'))

// It is recognized in every language: messages already sent stay in the language they were written in.
const IMAGE_PLACEHOLDERS = new Set(['(image attached)', '(images attached)', '(immagine allegata)', '(immagini allegate)'])
export const isImagePlaceholder = (text: string): boolean => IMAGE_PLACEHOLDERS.has(text)
