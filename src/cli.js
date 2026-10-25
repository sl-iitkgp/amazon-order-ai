#!/usr/bin/env node
// amazon-now-mcp            -> start the MCP server on stdio (what Claude runs)
// amazon-now-mcp login      -> sign in to amazon.in once in a dedicated Chrome window
// amazon-now-mcp scan [...] -> build your pantry from Amazon Now order history (last30 | months-3 | year-2026)
const [cmd, ...rest] = process.argv.slice(2)

if (cmd === 'login') {
  await import('../scripts/login.js')
} else if (cmd === 'scan') {
  process.argv = [process.argv[0], process.argv[1], ...rest]
  await import('../scripts/scan-history.js')
} else if (!cmd || cmd === 'serve') {
  await import('./server.js')
} else {
  console.error(`Unknown command "${cmd}". Use: amazon-now-mcp [login | scan [period] | serve]`)
  process.exit(1)
}
