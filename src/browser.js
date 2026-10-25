import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

/**
 * Everything personal (your Amazon login and your order history) lives in your home folder, never in the
 * package or a git checkout, so it cannot be committed or published by accident.
 */
export const HOME_DIR = process.env.AMAZON_NOW_HOME || path.join(os.homedir(), '.amazon-now-mcp')

/** Dedicated Chrome profile for this tool. Your login lives here instead of a cookie file. */
export const PROFILE_DIR = process.env.AMAZON_NOW_PROFILE_DIR || path.join(HOME_DIR, 'chrome-profile')

/** Order history and pantry. */
export const DATA_DIR = process.env.AMAZON_NOW_DATA_DIR || path.join(HOME_DIR, 'data')

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
  ].filter(Boolean)
  const found = candidates.find(p => fs.existsSync(p))
  if (!found) throw new Error('Chrome not found. Set CHROME_PATH to your Chrome executable.')
  return found
}

export async function launch({ headless }) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 })
  return puppeteer.launch({
    executablePath: findChrome(),
    userDataDir: PROFILE_DIR,
    headless,
    defaultViewport: { width: 1280, height: 900 },
    args: ['--no-first-run', '--no-default-browser-check'],
  })
}

const HEADLESS = process.env.AMAZON_NOW_HEADLESS !== 'false'

let browserPromise = null
let pagePromise = null

/** One warm browser + tab, reused across tool calls (Amazon Now is a slow-to-boot SPA). */
export async function getPage() {
  if (!browserPromise) {
    browserPromise = launch({ headless: HEADLESS }).then(b => {
      b.on('disconnected', () => {
        browserPromise = null
        pagePromise = null
      })
      return b
    })
    pagePromise = null
  }
  if (!pagePromise) {
    pagePromise = browserPromise.then(async b => {
      const [first] = await b.pages()
      const page = first || (await b.newPage())
      // Speed: skip images/fonts/media. Scraping only needs the DOM (alt text and links survive).
      await page.setRequestInterception(true)
      page.on('request', req => {
        if (req.isInterceptResolutionHandled()) return
        if (['image', 'font', 'media'].includes(req.resourceType())) req.abort().catch(() => {})
        else req.continue().catch(() => {})
      })
      return page
    })
  }
  return pagePromise
}

export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null)
    browserPromise = null
    pagePromise = null
    await b?.close().catch(() => {})
  }
}

// Tool calls share one tab, so run them one at a time.
let queue = Promise.resolve()
export function serialized(fn) {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}
