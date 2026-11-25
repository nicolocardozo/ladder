'use strict'
// Marchi per l'estensione dei widget (LAD-93): Claude, Codex e Ladder come immagini "template" in un catalogo di asset del target
// ExpoWidgetsTarget (il layout li chiama con `assetName`). Il target non legge le risorse dell'app: il catalogo si compila con una
// fase di script, perché xcodebuild ignora le fasi Resources dei target di expo-widgets. Va elencato PRIMA di "expo-widgets" in
// `plugins`: le modifiche girano in ordine inverso, e il target deve esistere (ed essere stato svuotato) prima che qui si aggiungano i file.
// Idea e fase di script adattate da T3 Code (MIT, apps/mobile/plugins/withWidgetLogoAsset.cjs).
const fs = require('node:fs')
const path = require('node:path')
const { withDangerousMod, withXcodeProject } = require('expo/config-plugins')

const TARGET = 'ExpoWidgetsTarget'
const CATALOG = 'Assets.xcassets'
const MARKS = ['ClaudeMark', 'CodexMark', 'LadderMark']
const PHASE = 'Compile Widget Assets'
const json = (value) => JSON.stringify(value, null, 2) + '\n'

const ACTOOL = [
  'set -e',
  'CATALOG="${SRCROOT}/ExpoWidgetsTarget/Assets.xcassets"',
  'if [ ! -d "$CATALOG" ]; then',
  '  echo "error: widget asset catalog not found at $CATALOG (expo-widgets wiped it? check plugin order in app.json)"',
  '  exit 1',
  'fi',
  'DEST="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}"',
  'mkdir -p "$DEST"',
  'xcrun actool "$CATALOG" --compile "$DEST" --platform "${PLATFORM_NAME}" --minimum-deployment-target "${IPHONEOS_DEPLOYMENT_TARGET:-16.0}" --output-format human-readable-text'
].join('\n')

function withFiles(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const catalog = path.join(cfg.modRequest.platformProjectRoot, TARGET, CATALOG)
      fs.mkdirSync(catalog, { recursive: true })
      fs.writeFileSync(path.join(catalog, 'Contents.json'), json({ info: { author: 'expo', version: 1 } }))
      for (const name of MARKS) {
        const set = path.join(catalog, `${name}.imageset`)
        fs.mkdirSync(set, { recursive: true })
        fs.writeFileSync(
          path.join(set, 'Contents.json'),
          json({ images: [{ idiom: 'universal', filename: `${name}.svg` }], info: { author: 'expo', version: 1 }, properties: { 'preserves-vector-representation': true, 'template-rendering-intent': 'template' } })
        )
        fs.copyFileSync(path.join(cfg.modRequest.projectRoot, 'assets', 'widget', `${name}.svg`), path.join(set, `${name}.svg`))
      }
      return cfg
    }
  ])
}

const entries = (map) => Object.entries(map || {}).filter(([key]) => !key.endsWith('_comment'))

function withPhase(config) {
  return withXcodeProject(config, (cfg) => {
    const proj = cfg.modResults
    const objects = proj.hash.project.objects
    const target = entries(objects.PBXNativeTarget).find(([, v]) => v && v.name === TARGET)
    if (!target) throw new Error(`withWidgetAssets: target "${TARGET}" not found. List this plugin before "expo-widgets".`)
    const [uuid, value] = target
    const have = entries(objects.PBXShellScriptBuildPhase).some(([id, v]) => v && v.name === `"${PHASE}"` && (value.buildPhases || []).some((p) => p.value === id))
    if (have) return cfg
    const added = proj.addBuildPhase([], 'PBXShellScriptBuildPhase', PHASE, uuid, { shellPath: '/bin/sh', shellScript: ACTOOL })
    objects.PBXShellScriptBuildPhase[added.uuid].alwaysOutOfDate = 1
    return cfg
  })
}

module.exports = function withWidgetAssets(config) {
  return withPhase(withFiles(config))
}
