// Il polyfill va caricato prima di qualunque altro modulo: noble legge crypto.getRandomValues al primo uso.
import './src/polyfill'
import 'expo-router/entry'
