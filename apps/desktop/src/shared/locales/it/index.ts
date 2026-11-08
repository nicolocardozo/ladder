// Catalogo italiano: un file per area del codice, uniti qui. Importarlo registra le traduzioni.
import { registerCatalog } from '../../i18n'
import agents from './agents'
import chat from './chat'
import editor from './editor'
import host from './host'
import inspector from './inspector'
import nav from './nav'
import shell from './shell'
import views from './views'

registerCatalog('it', { ...agents, ...nav, ...editor, ...chat, ...shell, ...views, ...inspector, ...host })
