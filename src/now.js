// Amazon Now (amazon.in/tez) scraping + cart actions.
//
// How the site works (mapped Oct 2026):
// - It's a Next.js app under /tez/browse, separate from the classic amazon.in pages.
// - Search results are server-rendered at /tez/browse/search?searchKeyword=...
//   Each product's Add button carries data-csa-c-slot-id="AsinFaceout-AddToCart[WithVariation]"
//   and data-csa-c-content-id="AsinFaceout-AddToCart-<ASIN>". Once in the cart, the Add button is
//   replaced by a "Quantity stepper" that does NOT carry the ASIN on search cards.
// - Every page load POSTs /tez/order/getcart; every Add/+/- POSTs /tez/order/atc.
//   Both return { success, data: { cartResponse } } with the whole cart. Calling them
//   directly needs CSRF headers, so we drive the page and read its responses instead.
// - The cart is a bottom sheet (button aria-label "Click to open bottomsheet ...") whose
//   steppers carry data-csa-c-asin.
// - Scripted el.click() on Add/+ is rolled back by the site; use trusted (CDP) clicks only.

import { getPage } from './browser.js'

export const BASE = 'https://www.amazon.in'
export const STOREFRONT_URL = `${BASE}/tez/browse`
const ADD_SEL = '[data-csa-c-slot-id^="AsinFaceout-AddToCart"]'
const TARGET = '[data-now-mcp-target]'
const NAV_TIMEOUT = 45_000
const ACTION_TIMEOUT = 15_000

export class NotLoggedInError extends Error {
  constructor() {
    super('Not logged in to Amazon in the tool\'s Chrome profile. Run `npx amazon-now-mcp login`, sign in with "Keep me signed in" ticked, then close that window.')
  }
}

export function assertLoggedIn(page) {
  if (/\/ap\/(signin|mfa|cvf)/.test(page.url())) throw new NotLoggedInError()
}

const money = m => (m && typeof m.amount === 'number' ? m.amount : null)

function packSizeText(p) {
  if (p == null) return null
  if (typeof p === 'string') return p
  return p.displayString ?? p.value ?? JSON.stringify(p)
}

export function summarizeCart(cr) {
  if (!cr) return null
  const items = (cr.cartItems || []).map(it => ({
    asin: it.asin,
    title: it.title || it.shortTitle,
    packSize: packSizeText(it.packSize),
    quantity: it.quantity,
    unitPrice: money(it.offerPrice),
    unitMrp: money(it.listPrice),
    lineTotal: money(it.totalOfferPrice),
    available: it.available ?? it.availabilityStatus ?? null,
    maxAllowedQuantity: it.maxAllowedQuantity ?? null,
  }))
  const next = cr.milestoneTracker?.nextMilestone
  return {
    currency: 'INR',
    itemCount: items.reduce((n, i) => n + (i.quantity || 0), 0),
    items,
    total: money(cr.totalOfferPrice),
    mrpTotal: money(cr.totalListPrice),
    saved: money(cr.cartSavings?.totalAmountSaved),
    nextMilestone: next ? { benefit: next.benefitType ?? null, addMore: money(next.amountToBeSaved) } : null,
  }
}

const cartFromJson = j => j?.data?.cartResponse ?? j?.cartResponse ?? null
const qtyOf = (cart, asin) => cart?.cartItems?.find(i => i.asin === asin)?.quantity ?? 0

function waitForOrderResponse(page, pathPart) {
  return page
    .waitForResponse(r => r.url().includes(pathPart) && r.request().method() === 'POST', { timeout: ACTION_TIMEOUT })
    .then(async r => {
      const j = await r.json().catch(() => null)
      if (!j || j.success === false) throw new Error(`Amazon Now ${pathPart} failed (HTTP ${r.status()}${j?.message ? `: ${j.message}` : ''})`)
      return cartFromJson(j)
    })
}

/** Navigate and capture the getcart call the page makes on load (null if it never comes). */
async function gotoWithCart(page, url) {
  const cartP = waitForOrderResponse(page, '/tez/order/getcart').catch(() => null)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
  assertLoggedIn(page)
  return cartP
}

async function gotoSearch(page, query) {
  const cart = await gotoWithCart(page, `${STOREFRONT_URL}/search?searchKeyword=${encodeURIComponent(query)}`)
  await page.waitForFunction(
    sel => document.querySelector(sel) || /no results|couldn.t find|did not match|no products/i.test(document.body?.innerText || ''),
    { timeout: NAV_TIMEOUT },
    ADD_SEL
  )
  return cart
}

/** Trusted click on the element the in-page helper tagged with data-now-mcp-target. */
async function clickTarget(page) {
  const h = await page.$(TARGET)
  if (!h) throw new Error('Click target vanished before it could be clicked.')
  await h.evaluate(el => el.scrollIntoView({ block: 'center' }))
  await h.click()
  await h.evaluate(el => el.removeAttribute('data-now-mcp-target')).catch(() => {})
}

// ---------- in-page helpers (run inside the browser) ----------

function pageExtractCards(limit) {
  // Largest ancestor that still contains only this product's button/stepper = the card.
  const ANCH = '[data-csa-c-slot-id^="AsinFaceout-AddToCart"],[aria-label="Quantity stepper"]'
  const findCard = el => {
    let card = el
    for (let i = 0; i < 12 && card.parentElement && card.parentElement.querySelectorAll(ANCH).length <= 1; i++) card = card.parentElement
    return card
  }
  const anchors = [
    ...[...document.querySelectorAll('[data-csa-c-slot-id^="AsinFaceout-AddToCart"]')].map(b => ({
      el: b,
      asin: (b.getAttribute('data-csa-c-content-id') || '').split('-').pop(),
      title: b.getAttribute('data-csa-c-product-title'),
      sponsored: b.getAttribute('data-csa-c-product-type') === 'SPONSORED',
      hasVariants: b.getAttribute('data-csa-c-slot-id') === 'AsinFaceout-AddToCartWithVariation',
    })),
    // Items already in the cart: stepper, no ASIN on the card. Filled in later from the cart.
    ...[...document.querySelectorAll('[aria-label="Quantity stepper"]')]
      .filter(s => !s.closest('[role=dialog]'))
      .map(s => ({ el: s, asin: null, title: null, sponsored: false, hasVariants: false })),
  ]
  const seen = new Set()
  const out = []
  for (const a of anchors) {
    if (a.asin !== null && !/^[A-Z0-9]{10}$/.test(a.asin)) continue
    const card = findCard(a.el)
    if (seen.has(a.asin || card)) continue
    seen.add(a.asin || card)
    const lines = card.innerText.split('\n').map(s => s.trim()).filter(Boolean)
    const text = lines.join(' ')
    const prices = [...text.matchAll(/₹\s*([\d,]+(?:\.\d+)?)/g)].map(m => Number(m[1].replace(/,/g, '')))
    const stepper = card.querySelector('[aria-label="Quantity stepper"]')
    const title = a.title || lines.filter(l => !/₹|^\d+%|^add$|^\d+$|sponsored|previously bought|buy again/i.test(l)).sort((x, y) => y.length - x.length)[0] || null
    out.push({
      asin: a.asin,
      title,
      price: prices[0] ?? null,
      mrp: prices[1] != null && prices[1] > prices[0] ? prices[1] : null,
      packSize: lines.find(l => /^(pack of\s*\d+|\d+\s*x\s*\d+.*|\d+(\.\d+)?\s*(g|gm|kg|ml|l|ltr|litre|pc|pcs|pieces?|units?|n)\b.*)$/i.test(l)) || null,
      rating: Number((text.match(/(\d\.\d)\s*\(/) || [])[1]) || null,
      sponsored: a.sponsored || lines.some(l => /^sponsored$/i.test(l)),
      previouslyBought: /previously bought|buy again|bought before/i.test(text),
      hasVariants: a.hasVariants,
      inCartQuantity: stepper ? Number((stepper.innerText.match(/\d+/) || [0])[0]) : 0,
    })
    if (out.length >= limit) break
  }
  return out
}

/**
 * Tag the button to press for adding one more unit of `asin` (Add, or the card's + stepper).
 * `title` locates in-cart cards, whose steppers don't carry the ASIN.
 */
function pageTagAddOrIncrease(asin, title) {
  const ANCH = '[data-csa-c-slot-id^="AsinFaceout-AddToCart"],[aria-label="Quantity stepper"]'
  const findCard = el => {
    let c = el
    for (let i = 0; i < 12 && c.parentElement && c.parentElement.querySelectorAll(ANCH).length <= 1; i++) c = c.parentElement
    return c
  }
  const tag = el => { el.setAttribute('data-now-mcp-target', '1') }
  let card = document.querySelector(`[data-now-mcp-card="${asin}"]`)
  if (!card) {
    const add = document.querySelector(`[data-csa-c-slot-id^="AsinFaceout-AddToCart"][data-csa-c-content-id$="-${asin}"]`)
    if (add) {
      if (add.getAttribute('data-csa-c-slot-id') === 'AsinFaceout-AddToCartWithVariation') return 'variants'
      findCard(add).setAttribute('data-now-mcp-card', asin)
      tag(add)
      return 'add'
    }
    if (title) {
      const norm = s => s.toLowerCase().replace(/\s+/g, ' ')
      const stepper = [...document.querySelectorAll('[aria-label="Quantity stepper"]')]
        .filter(s => !s.closest('[role=dialog]'))
        .find(s => norm(findCard(s).innerText).includes(norm(title).slice(0, 40)))
      if (stepper) {
        card = findCard(stepper)
        card.setAttribute('data-now-mcp-card', asin)
      }
    }
  }
  const inc = card?.querySelector('[aria-label="Increase quantity"]')
  if (!inc) return 'missing'
  if (inc.disabled || inc.getAttribute('aria-disabled') === 'true') return 'max'
  tag(inc)
  return 'increase'
}

function pageTagCartStepper(asin, direction) {
  const label = direction > 0 ? 'Increase quantity' : 'Decrease quantity'
  const btn = document.querySelector(`[role=dialog] [aria-label="${label}"][data-csa-c-asin="${asin}"]`)
  if (!btn) return 'missing'
  if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return 'disabled'
  btn.setAttribute('data-now-mcp-target', '1')
  return 'tagged'
}

// ---------- tools ----------

export async function search(query, limit = 10) {
  const page = await getPage()
  const cart = await gotoSearch(page, query)
  const results = await page.evaluate(pageExtractCards, limit)
  // In-cart cards have no ASIN on the page; recover it from the cart by title.
  const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim()
  for (const r of results) {
    if (r.asin) continue
    const hit = cart?.cartItems?.find(i => norm(r.title).includes(norm(i.shortTitle || i.title).slice(0, 30)) || norm(i.title).includes(norm(r.title)))
    if (hit) r.asin = hit.asin
  }
  return results.filter(r => r.asin)
}

export async function viewCart() {
  const page = await getPage()
  const cart = await gotoWithCart(page, STOREFRONT_URL)
  if (!cart) throw new Error('Could not read the Amazon Now cart (no getcart response). Is Amazon Now available at your address?')
  return summarizeCart(cart)
}

/** Add `quantity` units of one product from the results page of `searchQuery`. */
async function addOne(page, { asin, quantity = 1, searchQuery }) {
  let cart = await gotoSearch(page, searchQuery)
  const title = cart?.cartItems?.find(i => i.asin === asin)?.title ?? null
  let added = 0
  let stopReason = null

  while (added < quantity) {
    const kind = await page.evaluate(pageTagAddOrIncrease, asin, title)
    if (kind !== 'add' && kind !== 'increase') {
      stopReason = {
        variants: 'Has size/flavour variants that must be picked on the site; choose a specific variant ASIN from search results.',
        missing: `Not found in results for "${searchQuery}". Search again and pass the exact query that showed it.`,
        max: 'Amazon Now will not allow more of this item (max quantity reached).',
      }[kind]
      break
    }
    const respP = waitForOrderResponse(page, '/tez/order/atc')
    respP.catch(() => {})
    await clickTarget(page)
    const before = qtyOf(cart, asin)
    cart = (await respP) ?? cart
    if (qtyOf(cart, asin) <= before) {
      stopReason = 'Amazon Now did not increase the quantity (likely the per-order limit or out of stock).'
      break
    }
    added++
    // Wait for the + stepper to render before the next click.
    await page
      .waitForFunction(a => document.querySelector(`[data-now-mcp-card="${a}"] [aria-label="Increase quantity"]`), { timeout: ACTION_TIMEOUT }, asin)
      .catch(() => {})
  }
  return { cart, result: { asin, requested: quantity, added, quantityInCart: qtyOf(cart, asin), note: stopReason } }
}

/** Add several products in one go. Keeps going past individual failures. */
export async function addItems(items) {
  const page = await getPage()
  const results = []
  let cart = null
  for (const item of items) {
    try {
      const r = await addOne(page, item)
      cart = r.cart ?? cart
      results.push(r.result)
    } catch (err) {
      if (err instanceof NotLoggedInError) throw err
      results.push({ asin: item.asin, requested: item.quantity ?? 1, added: 0, note: `Error: ${err.message}` })
    }
  }
  return { results, cart: summarizeCart(cart) }
}

export async function setCartQuantity({ asin, quantity }) {
  const page = await getPage()
  let cart = await gotoWithCart(page, STOREFRONT_URL)
  if (!cart) throw new Error('Could not read the Amazon Now cart.')
  let current = qtyOf(cart, asin)
  if (current === 0) {
    if (quantity === 0) return { asin, quantityInCart: 0, cart: summarizeCart(cart) }
    throw new Error(`${asin} is not in the cart. Use now_add_items to add it first.`)
  }

  await page.waitForSelector('button[aria-label^="Click to open bottomsheet"]', { timeout: ACTION_TIMEOUT })
  // Opening the sheet is UI-only, so a scripted click is fine (the cart bar can be zero-sized in headless).
  await page.$eval('button[aria-label^="Click to open bottomsheet"]', b => b.click())
  await page.waitForSelector('[role=dialog] [aria-label="Quantity stepper"]', { timeout: ACTION_TIMEOUT })
  await new Promise(r => setTimeout(r, 1200)) // let the sheet finish sliding in

  while (current !== quantity) {
    const dir = quantity > current ? 1 : -1
    const res = await page.evaluate(pageTagCartStepper, asin, dir)
    if (res !== 'tagged') {
      if (dir > 0) break // hit the max
      throw new Error(`Could not change the quantity of ${asin} in the cart sheet (${res}).`)
    }
    const respP = waitForOrderResponse(page, '/tez/order/atc')
    respP.catch(() => {}) // never leave a rejected promise dangling if the click throws
    await clickTarget(page)
    cart = (await respP) ?? cart
    const updated = qtyOf(cart, asin)
    if (updated === current) break
    current = updated
    if (current > 0) {
      await page
        .waitForFunction(
          (a, q) => {
            const g = document.querySelector(`[role=dialog] [data-csa-c-asin="${a}"]`)?.closest('[aria-label="Quantity stepper"]')
            return g && g.innerText.includes(String(q))
          },
          { timeout: ACTION_TIMEOUT },
          asin,
          current
        )
        .catch(() => {})
    }
  }

  return {
    asin,
    quantityInCart: current,
    note: current !== quantity ? `Stopped at ${current}; Amazon Now would not go to ${quantity}.` : null,
    cart: summarizeCart(cart),
  }
}
