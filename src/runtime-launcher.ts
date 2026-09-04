import { pathToFileURL } from 'node:url'

const workspace = process.env.DSH_RUNTIME_WORKSPACE
const entry = process.env.DSH_LAUNCHER_ENTRY
if (workspace === undefined || entry === undefined) throw new Error('DSH_RUNTIME_WORKSPACE and DSH_LAUNCHER_ENTRY are required')
process.chdir(workspace)
await import(pathToFileURL(entry).href)
