// Metro in the pnpm monorepo: expo/metro-config (SDK 54+) adds the workspace root to watchFolders on its own, and
// the project and root node_modules to nodeModulesPaths, and supports pnpm's symlinks. Only these are needed here:
// - @shared/* → ../desktop/src/shared: already resolved by `paths` in tsconfig.json (Expo's tsconfigPaths is active);
//   we repeat it as extraNodeModules for requires that don't go through tsconfig;
// - the shared folder is outside the project: we add it to watchFolders explicitly, so it also works with other roots.
const { getDefaultConfig } = require('expo/metro-config')
const path = require('node:path')

const projectRoot = __dirname
const sharedRoot = path.resolve(projectRoot, '../desktop/src/shared')

const config = getDefaultConfig(projectRoot)
config.watchFolders = [...new Set([...(config.watchFolders ?? []), sharedRoot])]
config.resolver.extraNodeModules = { ...config.resolver.extraNodeModules, '@shared': sharedRoot }
// A test file next to the shared code is not app code.
config.resolver.blockList = [].concat(config.resolver.blockList ?? [], [/\.test\.tsx?$/])

module.exports = config
