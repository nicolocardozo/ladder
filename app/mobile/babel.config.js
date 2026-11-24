// Il preset di Expo include già i plugin di Reanimated/Worklets e di expo-router.
module.exports = function (api) {
  api.cache(true)
  return { presets: ['babel-preset-expo'] }
}
