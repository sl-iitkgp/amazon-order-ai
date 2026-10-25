// Opens a visible Chrome window on the tool's own profile so you can sign in to amazon.in yourself.
// Your password never touches this code; Chrome keeps the session in the profile folder.
import { PROFILE_DIR, launch } from '../src/browser.js'
import { STOREFRONT_URL } from '../src/now.js'

const browser = await launch({ headless: false })
const [page] = await browser.pages()
await page.goto(STOREFRONT_URL, { waitUntil: 'domcontentloaded' }).catch(() => {})

console.log(`
Chrome is open with the Amazon Now profile (${PROFILE_DIR}).
  1. Sign in to amazon.in and TICK "Keep me signed in". Without it the login is lost when the window closes.
  2. Finish any OTP and make sure Amazon Now shows your delivery address.
  3. Wait for "Login saved" below, then close the Chrome window.
`)

let closed = false
browser.on('disconnected', () => (closed = true))

// Amazon's auth cookie is at-<marketplace>; it only survives restarts if it isn't a session cookie.
let reported = ''
while (!closed) {
  const cookies = await browser.cookies().catch(() => null)
  if (cookies) {
    const auth = cookies.find(c => /^at-(acbin|main)$/.test(c.name) && c.domain.includes('amazon.in'))
    const state = !auth ? 'none' : auth.session ? 'session' : 'saved'
    if (state !== reported) {
      reported = state
      if (state === 'saved') console.log('Login saved. You can close the Chrome window now.')
      if (state === 'session') console.log('Signed in, but "Keep me signed in" was not ticked, so this login will be lost on close. Sign out and sign in again with it ticked.')
    }
  }
  await new Promise(r => setTimeout(r, 2000))
}
console.log(reported === 'saved' ? 'Done. You can now use the MCP server.' : 'Window closed without a saved login. Run this again.')
