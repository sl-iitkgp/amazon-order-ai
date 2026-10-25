// Starts the server over stdio like Claude does and prints its tools. Usage: node scripts/list-tools.js
// Needs no Amazon login: it only lists the tools.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const client = new Client({ name: 'list-tools', version: '0' })
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/server.js'] }))
const { tools } = await client.listTools()
console.log('instructions:', (client.getInstructions() || '').slice(0, 80) + '...')
for (const t of tools) console.log(`- ${t.name}: ${Object.keys(t.inputSchema.properties || {}).join(', ') || '(no args)'}`)
await client.close()
