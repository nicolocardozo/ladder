// The project's browser column: only one, to the right of the chat columns. The state lives in ProjectUiState.browserColumn
// (open or not, active page, chosen width), declared in the contract.
import type { ProjectUiState } from '@shared/protocol'

export type BrowserColumnUi = NonNullable<ProjectUiState['browserColumn']>

export const BROWSER_COLUMN = { min: 320, share: 0.4 }
