# Prompt for Claude Code: Ladder identity and themes

Work in the Ladder repository, the macOS desktop workspace where I switch quickly between active projects and manage graphical sessions with Claude Code and Codex, including sessions coordinated within the same task. Integrate the identity and the theme system into the existing code. Read the project structure first and reuse its conventions. If the project is still in the planning stage, return a concrete plan that respects this brief.

## Fixed product identity

**Ladder** is the product name. **Circuit** is the brand direction and the initial theme. Use iris **#5525CF** for the main mark on a light background, deep purple **#22123C** for the icon tile and brand surfaces, citron **#ECFC7F** for a targeted operational accent, lavender ivory **#F7F4FF** for light brand text, and white **#FFFFFF** for the mark in the provided icon. Use citron sparingly, for example for an in-progress state or a brand detail. Keep Circuit as the identity of the app, the macOS icon and the brand surfaces even when the workspace theme changes.

The final logo is the last approved variant, with three angular, separate bars, slightly staggered joins on the left, a top row that ends just before the middle one, and a short third bar with a 45° cut. Use the attached SVGs and icon files directly. The wordmark in the SVGs is outlined to paths. For the mark in the UI use the versions with appropriate contrast and the symbol at small sizes. The ten boards are references for color and tone.

For the interface use a sober, readable sans, preferring the system font on macOS, and a monospace for code and diffs. Keep a graphical chat, a project sidebar, recognizable states across projects, and a composer that adapts to Claude Code, Codex or the orchestrated session. Take agmux as the functional reference and the Codex chat as the readability reference. For approvals use neutral surfaces and, if needed, a straight vertical inner bar. Distinguish reading, request for intervention and work in progress with text or icons as well. [agmux](https://www.agmux.dev/)

## Available themes

Use all twelve themes. The first three color columns report the colors from the boards, with values sampled and normalized for use in the product. The UI columns are the operational bases. The UI accent may differ from the sampled color to ensure readability.

| Theme | Appearance | Palette (primary / secondary / accent) | Background | Surface | Sidebar | Text | UI accent |
|---|---|---|---|---|---|---|---|
| Night Shift | Dark | `#0D1623` / `#2C9EFE` / `#BCC2CC` | `#101822` | `#172230` | `#0D1623` | `#EDF4FD` | `#2C9EFE` |
| Signal Red | Light | `#491011` / `#E53F2A` / `#F7ECDA` | `#FCF7EF` | `#FFFFFF` | `#F7ECDA` | `#321514` | `#A62920` |
| Fieldnotes | Light | `#39411B` / `#D8E01A` / `#F4E8D0` | `#FCF8ED` | `#FFFDF8` | `#F4E8D0` | `#292E1A` | `#556314` |
| Azure Ink | Light | `#000D8A` / `#9ACBFA` / `#D5E7FB` | `#F2F7FE` | `#FFFFFF` | `#D5E7FB` | `#161C3D` | `#143BB0` |
| Kiln | Light | `#4F2921` / `#E1966A` / `#F4E7D5` | `#FCF6ED` | `#FFFDF8` | `#F4E7D5` | `#382019` | `#A34528` |
| Deep Current | Dark | `#0C2F32` / `#C2FDE7` / `#DFE9EA` | `#102729` | `#173437` | `#0C2F32` | `#E6F6F2` | `#89E9C8` |
| Circuit | Dark | `#5525CF` / `#22123C` / `#ECFC7F` | `#181424` | `#211A30` | `#1A1427` | `#F7F4FF` | `#AC97FF` |
| Copperwire | Light | `#442314` / `#C1FDFE` / `#F8884C` | `#FAF3EB` | `#FFFCF8` | `#F2E6DA` | `#352318` | `#216771` |
| Blue Hour | Dark | `#443F7C` / `#CEC7F8` / `#FD8783` | `#22223A` | `#2A2A49` | `#242441` | `#F3F0FF` | `#CEC7F8` |
| Candor | Light | `#165125` / `#D3E9F3` / `#FEC055` | `#F5F8F5` | `#FFFFFF` | `#E7F0E7` | `#1B3021` | `#196035` |
| Mono Light | Light | `#000000` / `#FFFFFF` / `#D4D4D4` | `#FFFFFF` | `#FAFAFA` | `#F1F1F1` | `#121212` | `#161616` |
| Mono Dark | Dark | `#FFFFFF` / `#000000` / `#808080` | `#0B0B0B` | `#151515` | `#080808` | `#F5F5F5` | `#F5F5F5` |

## Implementation and acceptance criteria

- Use `brand/themes.json` as the source of the tokens and `brand/themes.css` as the reference for the variables. Adapt the import to the existing architecture. Views consume semantic tokens for surfaces, text, borders, focus, selection, code and states.
- Add a selector in **Settings → Appearance**, with name, preview and a light/dark indication. Circuit is the default on first launch. Persist the choice at app level and apply it before the first paint, so that switching projects and restarting keep the theme. Changing the theme updates chat, navigation, panels, dialogs, editor and diffs.
- **Mono Light** is white with dark text and UI marks. **Mono Dark** is black with light text and UI marks. Keep both entirely in grayscale, including code blocks, diffs and indicators. Use labels, icons, `+` and `−` symbols and differences in weight to make states readable.
- For states, show the reply to be read in the sidebar, the run in progress with a discreet state, and the approval with an explicit indication that opens the correct session. Color is always accompanied by at least one other signal. Check the contrast of text, focus, selection, controls and active state on all themes. As a target use 4.5:1 for normal text and 3:1 for control borders and focus where applicable.
- Use the horizontal lockup in wide spaces and the symbol alone in compact spots. For macOS packaging use `app-icon/macos/ladder-circuit.icns`. If the pipeline requires PNG, use the 1024 px master. The monochrome variants are available for surfaces with specific needs.
- Check at least Circuit, Blue Hour, a light theme, Mono Light and Mono Dark on a normal session, a diff and an approval request. Test persistence, the immediate theme change and the fallback to Circuit if the saved value is unknown.
- When done, list the modified files, the selection mechanism, the assets used and the checks performed.
