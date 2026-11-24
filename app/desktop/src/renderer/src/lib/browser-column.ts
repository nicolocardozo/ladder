// Colonna browser del progetto: una sola, a destra delle colonne di chat. Lo stato sta in ProjectUiState.browserColumn
// (aperta o no, pagina attiva, larghezza scelta), dichiarato nel contratto.
import type { ProjectUiState } from '@shared/protocol'

export type BrowserColumnUi = NonNullable<ProjectUiState['browserColumn']>

export const BROWSER_COLUMN = { min: 320, share: 0.4 }
