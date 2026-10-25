// Amazon Now order history -> local "pantry" of proven items.
//
// Amazon Now orders appear in the normal amazon.in order list (/gp/css/order-history), marked
// "Amazon Now delivery". Each order card links every item image to /dp/<ASIN> with the full
// product title as alt text, so one list page gives ~10 orders with all their items.
// Pages: ?timeFilter=last30|months-3|year-YYYY&page=N

import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, getPage } from './browser.js'
import { BASE, assertLoggedIn } from './now.js'

const ORDERS_FILE = path.join(DATA_DIR, 'orders.json')
const PANTRY_FILE = path.join(DATA_DIR, 'pantry.json')

const readJson = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return fallback
  }
}
const writeJson = (f, v) => {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  fs.writeFileSync(f, JSON.stringify(v, null, 2), { mode: 0o600 })
}

function pageExtractNowOrders() {
  const cards = [...document.querySelectorAll('.order-card, .js-order-card')]
  const orders = cards
    .filter(c => /amazon\s*now delivery/i.test(c.innerText))
    .map(c => {
      const text = c.innerText
      const items = []
      const seen = new Set()
      for (const img of c.querySelectorAll('a img')) {
        const href = img.closest('a').getAttribute('href') || ''
        const asin = (href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/) || [])[1]
        if (!asin || seen.has(asin)) continue
        seen.add(asin)
        items.push({ asin, title: (img.alt || '').trim() })
      }
      return {
        orderId: (text.match(/\b(\d{3}-\d{7}-\d{7})\b/) || [])[1] || null,
        date: ((text.match(/ORDER PLACED\s*\n?\s*([^\n]+)/i) || [])[1] || '').trim() || null,
        total: Number(((text.match(/TOTAL\s*\n?\s*₹\s*([\d,]+(?:\.\d+)?)/i) || [])[1] || '').replace(/,/g, '')) || null,
        items,
      }
    })
    .filter(o => o.orderId)
  const next = document.querySelector('.a-pagination li.a-last')
  return { orders, cardCount: cards.length, hasNext: !!next && !next.classList.contains('a-disabled') }
}

export async function scanOrders({ period = 'months-3', maxPages = 20 } = {}) {
  const page = await getPage()
  const found = []
  let pages = 0
  for (let p = 1; p <= maxPages; p++) {
    await page.goto(`${BASE}/gp/css/order-history?timeFilter=${period}&page=${p}`, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    if (/\/ap\/(signin|mfa|cvf)/.test(page.url())) {
      // Amazon re-asks for the password on order history even when the session is valid.
      if (process.env.AMAZON_NOW_HEADLESS !== 'false') {
        throw new Error('Amazon wants a password re-check for order history. Run `npx amazon-now-mcp scan` (opens a window where you enter your password once).')
      }
      console.error('[history] Enter your Amazon password in the open Chrome window to continue...')
      await page.waitForFunction(() => !/\/ap\/(signin|mfa|cvf)/.test(location.pathname), { timeout: 300_000, polling: 1000 })
      await page.goto(`${BASE}/gp/css/order-history?timeFilter=${period}&page=${p}`, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    }
    assertLoggedIn(page)
    await page
      .waitForFunction(() => document.querySelector('.order-card, .js-order-card') || /0 orders placed|no orders|looking for an order/i.test(document.body?.innerText || ''), { timeout: 15_000 })
      .catch(() => {})
    const { orders, cardCount, hasNext } = await page.evaluate(pageExtractNowOrders)
    pages++
    found.push(...orders)
    if (!cardCount || !hasNext) break
  }

  const stored = readJson(ORDERS_FILE, {})
  let added = 0
  for (const o of found) {
    if (!stored[o.orderId]) added++
    stored[o.orderId] = o
  }
  writeJson(ORDERS_FILE, stored)
  const pantry = buildPantry(stored)
  writeJson(PANTRY_FILE, pantry)
  return {
    period,
    pagesScanned: pages,
    nowOrdersFound: found.length,
    newOrdersSaved: added,
    totalOrdersStored: Object.keys(stored).length,
    pantryItems: pantry.items.length,
    top: pantry.items.slice(0, 15).map(i => `${i.timesOrdered}x ${i.title}`),
  }
}

function buildPantry(ordersById) {
  const byAsin = new Map()
  for (const o of Object.values(ordersById)) {
    const t = Date.parse(o.date) || 0
    for (const it of o.items) {
      const e = byAsin.get(it.asin) || { asin: it.asin, title: it.title, timesOrdered: 0, lastOrdered: 0, firstOrdered: Infinity }
      e.timesOrdered++
      if (t >= e.lastOrdered) {
        e.lastOrdered = t
        if (it.title) e.title = it.title
      }
      e.firstOrdered = Math.min(e.firstOrdered, t)
      byAsin.set(it.asin, e)
    }
  }
  const iso = t => (t && Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null)
  const items = [...byAsin.values()]
    .sort((a, b) => b.timesOrdered - a.timesOrdered || b.lastOrdered - a.lastOrdered)
    .map(e => ({ ...e, lastOrdered: iso(e.lastOrdered), firstOrdered: iso(e.firstOrdered) }))
  return { builtAt: new Date().toISOString(), orderCount: Object.keys(ordersById).length, items }
}

/** Pantry items, optionally filtered: an item matches if its title contains any query word. */
export function getPantry({ query, limit = 200 } = {}) {
  const pantry = readJson(PANTRY_FILE, null)
  if (!pantry) return { empty: true, note: 'No pantry yet. Run now_refresh_history first.' }
  let items = pantry.items
  if (query) {
    const words = query.toLowerCase().split(/[\s,]+/).filter(w => w.length > 2)
    items = items.filter(i => words.some(w => i.title.toLowerCase().includes(w)))
  }
  return { builtAt: pantry.builtAt, orderCount: pantry.orderCount, items: items.slice(0, limit) }
}

/** ASIN -> times ordered, for tagging search results. */
export function pantryIndex() {
  const pantry = readJson(PANTRY_FILE, null)
  return new Map((pantry?.items || []).map(i => [i.asin, i]))
}
