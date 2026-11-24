// Metro nel monorepo pnpm: expo/metro-config (SDK 54+) aggiunge da solo la radice del workspace a watchFolders e
// i node_modules di progetto e radice a nodeModulesPaths, e supporta i link simbolici di pnpm. Qui servono solo:
// - @shared/* → ../desktop/src/shared: lo risolve già `paths` di tsconfig.json (tsconfigPaths di Expo è attivo);
//   lo ripetiamo come extraNodeModules per i require senza passare dal tsconfig;
// - la cartella condivisa è fuori dal progetto: la aggiungiamo a watchFolders in modo esplicito, così funziona anche con altre radici.
const { getDefaultConfig } = require('expo/metro-config')
const path = require('node:path')

const projectRoot = __dirname
const sharedRoot = path.resolve(projectRoot, '../desktop/src/shared')

const config = getDefaultConfig(projectRoot)
config.watchFolders = [...new Set([...(config.watchFolders ?? []), sharedRoot])]
config.resolver.extraNodeModules = { ...config.resolver.extraNodeModules, '@shared': sharedRoot }
// Un file di test accanto al codice condiviso non è codice dell'app.
config.resolver.blockList = [].concat(config.resolver.blockList ?? [], [/\.test\.tsx?$/])

module.exports = config
