'use strict'
// Marks for the widgets extension: Claude, Codex and Ladder as "template" images in an asset catalog of the
// ExpoWidgetsTarget target (the layout calls them with `assetName`). The target does not read the app's resources: the catalog is compiled with a
// script phase, because xcodebuild ignores the Resources phases of expo-widgets targets. It must be listed BEFORE "expo-widgets" in
// `plugins`: the mods run in reverse order, and the target must exist (and have been emptied) before the files are added here.
// Idea and script phase adapted from T3 Code (MIT, apps/mobile/plugins/withWidgetLogoAsset.cjs).
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
