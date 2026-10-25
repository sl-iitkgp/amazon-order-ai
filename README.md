# amazon-now-mcp

An MCP server that turns a spoken or typed grocery list into a **ready Amazon Now cart** (amazon.in
10-minute delivery). It learns what you usually buy from your order history, picks proven items first,
compares prices, and fills the cart. **It never checks out. You pay yourself.**

> Unofficial. Not affiliated with or endorsed by Amazon. It automates the Amazon Now website in your own
> Chrome, signed in as you. Read [Limits and risks](#limits-and-risks) first.

## Tools

| Tool | What it does |
|---|---|
| `now_refresh_history` | Scan your Amazon Now orders and rebuild the local pantry (what you buy, how often, when) |
| `now_get_pantry` | Your proven items, most-bought first |
| `now_search` | Search several items in one call; results tagged with `timesOrdered` (pantry) and `previouslyBought` |
| `now_add_items` | Add several products to the cart in one call |
| `now_view_cart` | Items, totals, savings, "add ₹X more for free delivery" |
| `now_set_cart_quantity` | Set an item's quantity, 0 removes it |

The server ships its own instructions describing the voice-to-cart workflow, so any MCP client follows it.

## Requirements

- Node.js 18+
- Google Chrome installed (the server drives it with `puppeteer-core`; nothing is downloaded)
- An amazon.in account with Amazon Now available at your delivery address

## Install

### 1. Sign in once (a Chrome window opens)

```bash
npx -y amazon-now-mcp login
```

Sign in to amazon.in, tick **Keep me signed in**, wait for "Login saved", close the window.

### 2. Build your pantry (optional but recommended)

```bash
npx -y amazon-now-mcp scan months-3
```

Amazon asks for your password again on the order-history page; enter it in the window that opens.
Longer ranges: `year-2025`, etc. Results merge. Refresh every few weeks.

### 3. Connect it to your MCP client

**Claude Code**

```bash
claude mcp add amazon-now -- npx -y amazon-now-mcp
```

**Claude Desktop** (`claude_desktop_config.json`) and other clients that use the same format:

```json
{
  "mcpServers": {
    "amazon-now": { "command": "npx", "args": ["-y", "amazon-now-mcp"] }
  }
}
```

**From a git checkout instead of npm**

```bash
git clone https://github.com/sl-iitkgp/amazon-order-ai && cd amazon-order-ai && npm install
claude mcp add amazon-now -- node /absolute/path/to/amazon-order-ai/src/server.js
```

Then say: "order 2 milk, curd, paneer, tomatoes, and the usual atta".

## Where your data lives

Nothing personal is stored in the package or the repo. By default:

| What | Where |
|---|---|
| Chrome profile with your Amazon login | `~/.amazon-now-mcp/chrome-profile` |
| Order history and pantry | `~/.amazon-now-mcp/data` |

Override with `AMAZON_NOW_HOME`, `AMAZON_NOW_PROFILE_DIR`, `AMAZON_NOW_DATA_DIR`. Set `CHROME_PATH` if
Chrome is not auto-detected. `AMAZON_NOW_HEADLESS=false` shows the browser while the server runs.
To remove everything, delete `~/.amazon-now-mcp`.

There are no API keys, tokens or passwords in this code, and none are needed. You sign in yourself in Chrome.

## How it works

- Drives your installed Chrome on a **dedicated profile** (separate from your everyday Chrome).
- Search: reads the server-rendered results and the stable `data-csa-c-*` attributes on Add buttons.
- Cart: uses real (trusted) clicks on the site's own Add / +/- buttons and reads the JSON the page itself
  fetches. Amazon Now rolls back scripted clicks, so the code never uses them.
- History: Amazon Now orders show up in normal amazon.in order history as "Amazon Now delivery".
- One warm browser, images/fonts blocked: ~3-4 s per search or cart action.

## Limits and risks

- Scrapes a private web app; selectors can change without notice. Issues and PRs welcome.
- Products with a variant picker can't be added yet (reported back, not guessed).
- The Chrome profile holds a live Amazon session and `data/` holds your purchase history. Never share or
  commit either.
- Automated use may breach Amazon's Conditions of Use; keep it personal and light, at your own risk.
- Cart contents, prices and your purchase history are sent to whichever AI model you use.
- Only one process can use the Chrome profile at a time. Close the login window before running the server.

## Contributing

Run `node scripts/list-tools.js` to check the server starts (no login needed). Before opening a PR, make sure
you have not included screenshots, logs or fixtures containing order IDs, addresses or ASIN lists from your
own account.

## License

MIT
