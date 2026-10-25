// Read-only live check. Usage: node scripts/smoke.js [history|search|cart] [arg]
import { closeBrowser } from '../src/browser.js'
import { getPantry, scanOrders } from '../src/history.js'
import { search, viewCart } from '../src/now.js'

const [what = 'search', arg] = process.argv.slice(2)
const t0 = Date.now()
try {
  if (what === 'history') {
    console.log(JSON.stringify(await scanOrders({ period: arg || 'months-3' }), null, 2))
    console.log('pantry sample:', JSON.stringify(getPantry({ limit: 5 }).items, null, 1))
  } else if (what === 'cart') {
    console.log(JSON.stringify(await viewCart(), null, 2))
  } else {
    console.log(JSON.stringify(await search(arg || 'milk', 6), null, 2))
  }
} finally {
  await closeBrowser()
  console.error(`(${((Date.now() - t0) / 1000).toFixed(1)} s)`)
}
