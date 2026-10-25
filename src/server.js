#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { closeBrowser, serialized } from './browser.js'
import { getPantry, pantryIndex, scanOrders } from './history.js'
import { STOREFRONT_URL, addItems, search, setCartQuantity, viewCart } from './now.js'

const INSTRUCTIONS = `
Amazon Now (amazon.in 10-minute delivery) shopping assistant. Goal: turn the user's spoken/typed list into a
ready cart. The user always pays themselves; never try to check out.

Voice-to-cart workflow:
1. Parse the list into items with quantities ("2 milk, curd, atta" -> milk x2, curd x1, atta x1). Keep the
   user's words for brand/size hints ("big atta", "the usual paneer").
2. now_get_pantry (once) to see the user's proven items: products they bought before, with how often and when.
   If it is empty, suggest now_refresh_history first.
3. now_search with ALL items in one call (queries array). Use specific queries for pantry matches
   (brand + product, e.g. "<brand> toned milk"), generic ones otherwise.
4. Choose one product per item:
   - Proven first: a result whose asin is in the pantry (timesOrdered) or flagged previouslyBought. If several,
     take the most ordered / most recent, matching any size the user said.
   - If the proven item is missing or unavailable, pick the closest substitute (same brand other size, or same
     type), and mark it as a substitution.
   - New items: best value per unit among non-sponsored results with decent rating; avoid sponsored unless clearly
     better value.
   - Price check: if a comparable non-proven option is >=20% cheaper per unit, still pick the proven one but
     mention the cheaper option in the summary.
   - Quantity: what the user said, else 1.
5. now_add_items with all chosen products in one call (each with the searchQuery that returned it).
   The user has pre-approved adding for voice-to-cart runs; don't ask per item.
6. Reply with a compact summary: table of item -> product, size, qty, price, tag (proven/new/substituted),
   anything not added and why, cheaper alternatives noticed, cart total, and how much more is needed for free
   delivery. Then: "Cart is ready - open Amazon Now in your app or ${STOREFRONT_URL} and tap Proceed to pay."
7. Fix-ups ("remove the yogurt", "make it 3 milk") via now_set_cart_quantity or now_add_items.

Never claim an order was placed. Never ask for payment details.
`.trim()

const server = new McpServer({ name: 'amazon-now', version: '0.2.0' }, { instructions: INSTRUCTIONS })

const asin = z.string().regex(/^[A-Z0-9]{10}$/, 'ASIN must be 10 uppercase letters/digits.').describe('Amazon product ASIN, from now_search results.')

const CHECKOUT_NOTE = `This tool never checks out. To pay, open Amazon Now in your app or ${STOREFRONT_URL}, open the cart and tap Proceed.`

function tool(name, description, schema, fn) {
  server.tool(name, description, schema, args =>
    serialized(async () => {
      try {
        const result = await fn(args)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        console.error(`[amazon-now][${name}]`, err)
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] }
      }
    })
  )
}

tool(
  'now_refresh_history',
  'Scan the user\'s Amazon Now orders from their amazon.in order history and rebuild the local pantry of proven items (what they buy, how often, when). Read-only on Amazon. Takes ~3 s per 10 orders.',
  {
    period: z
      .string()
      .regex(/^(last30|months-3|year-\d{4})$/)
      .default('months-3')
      .describe('Order history range: "last30", "months-3", or a year like "year-2026". Run more than once to cover several years; results merge.'),
  },
  async ({ period }) => scanOrders({ period })
)

tool(
  'now_get_pantry',
  'Get the user\'s proven items from past Amazon Now orders: asin, title, timesOrdered, lastOrdered. Sorted by how often they were bought.',
  {
    query: z.string().optional().describe('Optional words to filter titles, e.g. "milk curd paneer". Omit to get everything.'),
  },
  async ({ query }) => getPantry({ query })
)

tool(
  'now_search',
  'Search Amazon Now for one or more items (one call for the whole list). Products are deliverable to the account\'s current address. ' +
    'Each result: asin, title, price, mrp (INR), packSize, rating, sponsored, previouslyBought (site badge), timesOrdered (from pantry), inCartQuantity.',
  {
    queries: z.array(z.string().min(1)).min(1).max(20).describe('Search terms, e.g. ["toned milk", "curd", "multigrain atta 5kg"].'),
    limit: z.number().int().min(1).max(30).default(8).describe('Max products per query.'),
  },
  async ({ queries, limit }) => {
    const idx = pantryIndex()
    const out = []
    for (const q of queries) {
      try {
        const results = (await search(q, limit)).map(r => ({ ...r, timesOrdered: idx.get(r.asin)?.timesOrdered ?? 0 }))
        out.push({ query: q, results })
      } catch (err) {
        if (err.name === 'NotLoggedInError' || /Not logged in/.test(err.message)) throw err
        out.push({ query: q, error: err.message })
      }
    }
    return out
  }
)

tool(
  'now_add_items',
  'Add products to the Amazon Now cart (several in one call). Each needs the asin and the exact now_search query that returned it. ' +
    'quantity = units to add on top of what is already in the cart. Only changes the cart; never places an order.',
  {
    items: z
      .array(
        z.object({
          asin,
          searchQuery: z.string().min(1).describe('The now_search query whose results included this ASIN.'),
          quantity: z.number().int().min(1).max(10).default(1),
        })
      )
      .min(1)
      .max(25),
  },
  async ({ items }) => ({ ...(await addItems(items)), checkout: CHECKOUT_NOTE })
)

tool(
  'now_view_cart',
  'Show the current Amazon Now cart: items, quantities, line totals, total, savings, and how much more to add for the next benefit (e.g. free delivery). Read-only.',
  {},
  async () => ({ cart: await viewCart(), checkout: CHECKOUT_NOTE })
)

tool(
  'now_set_cart_quantity',
  'Set the exact quantity of an item already in the Amazon Now cart; 0 removes it.',
  {
    asin,
    quantity: z.number().int().min(0).max(20).describe('Target quantity; 0 removes the item.'),
  },
  async args => ({ ...(await setCartQuantity(args)), checkout: CHECKOUT_NOTE })
)

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await closeBrowser()
    process.exit(0)
  })
}
process.stdin.on('close', () => closeBrowser().finally(() => process.exit(0)))

await server.connect(new StdioServerTransport())
console.error('[amazon-now] MCP server running on stdio')
