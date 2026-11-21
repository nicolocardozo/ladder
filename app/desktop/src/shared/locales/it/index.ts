// Catalogo italiano: un file per area del codice, uniti qui. Importarlo registra le traduzioni.
import { registerCatalog } from '../../i18n'
import agentCatalog from './agent-catalog'
import agents from './agents'
import browser from './browser'
import chat from './chat'
import connections from './connections'
import editor from './editor'
import host from './host'
import inspector from './inspector'
import nav from './nav'
import presets from './presets'
import settings from './settings'
import shell from './shell'
import shortcuts from './shortcuts'
import views from './views'

registerCatalog('it', { ...agents, ...agentCatalog, ...browser, ...connections, ...nav, ...editor, ...chat, ...shell, ...views, ...inspector, ...host, ...shortcuts, ...presets, ...settings })
