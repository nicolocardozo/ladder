// The polyfill must load before any other module: noble reads crypto.getRandomValues on first use.
import './src/polyfill'
import 'expo-router/entry'
