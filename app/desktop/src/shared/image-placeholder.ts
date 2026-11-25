// Testo inviato quando il messaggio ha solo immagini: l'agente (API di Claude) rifiuta un blocco di testo vuoto, quindi l'host vuole sempre un testo.
// Modulo puro: lo usano la finestra (composer e chat), il gateway remoto (messaggi dal telefono) e l'app del telefono (per nasconderlo nel messaggio).
import { t } from './i18n.ts'

export const imagePlaceholder = (count: number): string => (count === 1 ? t('(image attached)') : t('(images attached)'))

// Si riconosce in tutte le lingue: i messaggi già inviati restano nella lingua in cui sono stati scritti.
const IMAGE_PLACEHOLDERS = new Set(['(image attached)', '(images attached)', '(immagine allegata)', '(immagini allegate)'])
export const isImagePlaceholder = (text: string): boolean => IMAGE_PLACEHOLDERS.has(text)
