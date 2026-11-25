// The Expo preset already includes the Reanimated/Worklets and expo-router plugins.
module.exports = function (api) {
  api.cache(true)
  return { presets: ['babel-preset-expo'] }
}
