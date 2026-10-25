// Rebuild the pantry from your Amazon Now orders. Opens a visible Chrome window because Amazon asks for
// your password again on the order history page. Usage: scan-history.js [last30|months-3|year-2026 ...]
process.env.AMAZON_NOW_HEADLESS = 'false'
const { closeBrowser } = await import('../src/browser.js')
const { scanOrders } = await import('../src/history.js')

const periods = process.argv.slice(2)
try {
  for (const period of periods.length ? periods : ['months-3']) {
    console.log(JSON.stringify(await scanOrders({ period }), null, 2))
  }
} finally {
  await closeBrowser()
}
