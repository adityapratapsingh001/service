import { connect } from 'puppeteer-real-browser';
import { findChrome, getProfileDir } from './findChrome.js';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ChatGPT login into the SAME profile dir app.js uses, so the server reuses
// the session. It tries email+password+OTP automatically, but if anything
// fails you just finish logging in by hand IN THE WINDOW — either way it
// auto-detects success and closes the browser GRACEFULLY so the cookies are
// flushed to disk (a hard Ctrl+C kill would lose them). No Ctrl+C needed.
//
//   node login.js
//   CHATGPT_EMAIL=you@x.com CHATGPT_PASSWORD=secret node login.js
// (Stop the server first — Chrome can't open the same profile twice.)

process.on('unhandledRejection', (e) => console.log('[!] unhandledRejection:', e?.message || e));

const rl = readline.createInterface({ input, output });
const ask = (q) => rl.question(q);

const composerSelector = '#mobile-composer-prompt, #prompt-textarea, [data-testid="composer-text-input"]';
const profileDir = getProfileDir();
console.log(`\nProfile dir (shared with app.js): ${profileDir}\n`);

const { browser, page } = await connect({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,900'],
    customConfig: { userDataDir: profileDir, executablePath: findChrome() || undefined },
    turnstile: true
});
await page.setViewport({ width: 1280, height: 900 });

const loggedIn = () =>
    page.waitForSelector(composerSelector, { visible: true, timeout: 2500 }).then(() => true, () => false);

async function fillField(selectorList, value, label) {
    const el = await page.waitForSelector(selectorList, { visible: true, timeout: 15000 });
    await el.click({ clickCount: 3 }).catch(() => {});
    await page.evaluate(
        (node, val) => {
            const proto = node.tagName === 'TEXTAREA'
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, val);
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
        },
        el, value
    );
    console.log(`[ok] filled ${label}`);
}

// Submit the current step WITHOUT ever hitting a social-login button.
// Pressing Enter in the just-filled field triggers the form's own primary
// action (email/password Continue) — it can never be "Continue with Google".
// A social-safe button click is only a fallback.
async function submitStep() {
    await page.keyboard.press('Enter');
    await sleep(800);
}

async function clickContinue() {
    const clicked = await page.evaluate(() => {
        // Never click OAuth/social buttons — those redirect to Google/etc.
        const bad = ['google', 'microsoft', 'apple', 'phone', 'passkey', 'sso', 'saml', 'facebook', 'github', 'create'];
        const good = ['continue', 'log in', 'sign in', 'next', 'verify', 'submit'];
        const label = (b) => (b.innerText || b.value || b.getAttribute('aria-label') || '').trim().toLowerCase();
        const btns = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]'))
            .filter((b) => b.offsetParent !== null && !bad.some((w) => label(b).includes(w)));
        const btn =
            btns.find((b) => good.includes(label(b))) ||
            btns.find((b) => b.type === 'submit');
        if (btn) { btn.click(); return true; }
        return false;
    });
    if (!clicked) await page.keyboard.press('Enter');
}

// Detect login, flush cookies, close gracefully. Returns true if it persisted.
async function finishIfLoggedIn() {
    if (!(await loggedIn())) return false;
    console.log('\n✅ Logged in! Saving session (flushing cookies)...');
    // Land on the app so the session cookies are definitely set, give Chrome a
    // moment to write them, then close GRACEFULLY (not a hard kill).
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(4000);
    await browser.close().catch(() => {});
    return true;
}

try {
    console.log('Opening ChatGPT login... (Cloudflare may take a few seconds)');
    await page.goto('https://auth.openai.com/log-in-or-create-account', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(3000);

    if (!(await loggedIn())) {
        // Best-effort automated login. Any failure just drops to manual.
        try {
            const email = process.env.CHATGPT_EMAIL || (await ask('ChatGPT email: '));
            const password = process.env.CHATGPT_PASSWORD || (await ask('ChatGPT password: '));

            await fillField('input[type="email"], input[name="email"], input[name="username"], input[autocomplete="username"]', email, 'email');
            await submitStep(); // Enter in the email field -> email Continue (never Google)
            await sleep(3000);

            await fillField('input[type="password"], input[name="password"], input[autocomplete="current-password"]', password, 'password');
            await submitStep();
            await sleep(4000);

            if (!(await loggedIn())) {
                const otpSel = 'input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"], input[type="tel"]';
                if (await page.$(otpSel)) {
                    const code = (await ask('\n>> Enter the OTP code from your email: ')).trim();
                    const boxes = await page.$$(otpSel);
                    if (boxes.length > 1) {
                        for (let i = 0; i < boxes.length && i < code.length; i++) {
                            await boxes[i].click();
                            await page.keyboard.type(code[i], { delay: 30 });
                        }
                    } else {
                        await fillField(otpSel, code, 'OTP');
                    }
                    await submitStep();
                    await sleep(4000);
                }
            }
        } catch (e) {
            console.log('[!] Automated step failed:', e.message);
        }
    }

    console.log('\nIf you still see a login/verify page, just finish it BY HAND in the window.');
    console.log('This will auto-detect when you are in and close by itself — no Ctrl+C needed.\n');

    // Poll up to ~10 min; the instant the composer appears, persist + close.
    let done = false;
    for (let i = 0; i < 300; i++) {
        if (await finishIfLoggedIn()) { done = true; break; }
        await sleep(2000);
    }
    if (!done) {
        console.log('[!] Timed out waiting for login. Closing.');
        await browser.close().catch(() => {});
    }
} catch (err) {
    console.log('[!] Login flow error:', err.message);
    await browser.close().catch(() => {});
} finally {
    rl.close();
    console.log('Done. Now run: node app.js');
}
