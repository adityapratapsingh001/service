import express from 'express';
import { connect } from 'puppeteer-real-browser';
import { spawn } from 'child_process';
import { findChrome, getProfileDir } from './findChrome.js';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3102;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startXvfbIfNeeded() {
    if (process.platform !== 'linux') return;
    if (process.env.DISPLAY) return;
    spawn('Xvfb', [':99', '-screen', '0', '1280x900x24'], { stdio: 'ignore' });
    process.env.DISPLAY = ':99';
    await sleep(1000);
}

const xvfbReady = startXvfbIfNeeded();

// --- SHARED BROWSER (launched once, reused across requests) ---
let browserInstance = null;
let pageInstance = null;
let launching = null;

async function getPage() {
    if (pageInstance && !pageInstance.isClosed()) return pageInstance;

    if (!launching) {
        launching = (async () => {
            await xvfbReady;
            const chromePath = findChrome();
            const profileDir = getProfileDir();
            const { browser, page } = await connect({
                headless: false,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--window-size=1280,900',
                    '--display=:99'
                ],
                customConfig: {
                    userDataDir: profileDir,
                    executablePath: chromePath || undefined
                },
                // Needed on a headless server: the copied login session works,
                // but Cloudflare's cf_clearance cookie is IP-bound and won't
                // transfer, so the server hits a challenge. turnstile solves it.
                turnstile: true
            });
            await page.setViewport({ width: 1280, height: 900 });
            browserInstance = browser;
            pageInstance = page;
        })();
    }

    try {
        await launching;
    } finally {
        launching = null;
    }
    return pageInstance;
}

// --- REQUEST QUEUE (only one request may drive the shared page at a time) ---
let queue = Promise.resolve();
function withLock(fn) {
    const run = queue.then(fn, fn);
    queue = run.then(() => {}, () => {});
    return run;
}

export async function processPromptAndGetReply({ prompt, imageUrl, targetUrl }) {
    return withLock(() => runPrompt({ prompt, imageUrl, targetUrl }));
}

const editorSelector = '#prompt-textarea.ProseMirror, #prompt-textarea, #mobile-composer-prompt';
const fileInputSelector = 'input[type="file"]';
const stopBtnSelector = 'button[aria-label="Stop generating"], button[data-testid="stop-button"]';
const responseSelector = 'div[data-message-author-role="assistant"], div.agent-turn, div[data-assistant-markdown], .markdown, p[data-assistant-stream-block]';

async function runPrompt({ prompt, imageUrl, targetUrl }) {
    const siteurl = targetUrl || "https://chatgpt.com/?temporary-chat=true";

    // Per-step timing. lap() is called AFTER the step it measures, so each
    // number is attributed to the phase that just finished.
    const t0 = Date.now();
    let mark = t0;
    const lap = (label) => {
        const now = Date.now();
        console.log(`[t] ${label.padEnd(18)} ${String(now - mark).padStart(6)}ms   (total ${now - t0}ms)`);
        mark = now;
    };

    const page = await getPage();
    lap('browser ready');

    try {
        await page.goto(siteurl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        lap('page goto');

        // --- STEP 1: IMAGE UPLOAD (If Provided) ---
        if (imageUrl) {
            console.log("[2/4] Uploading image...");
            try {
                const fileInput = await page.waitForSelector(fileInputSelector, { timeout: 5000 });
                if (fileInput) {
                    await fileInput.uploadFile(imageUrl);
                    // Wait for the attachment thumbnail instead of a blind sleep
                    await page
                        .waitForFunction(
                            () => !!document.querySelector('[data-testid*="attachment"], .composer-parent img[src^="blob:"]'),
                            { timeout: 5000, polling: 100 }
                        )
                        .catch(() => {});
                }
            } catch (e) {
                console.log("[!] Image upload skipped:", e.message);
            }
        }

        // --- STEP 2: FILL PROMPT ---
        await page.waitForSelector(editorSelector, { visible: true, timeout: 15000 });
        lap('editor hydrated');

        await page.click(editorSelector);

        // The composer may be a <textarea> (value lives in .value) OR a
        // contenteditable rich-text editor (text lives in .innerText). Check
        // both — reading only innerText silently reports every textarea as
        // empty, which used to make every fill look like it failed.
        const checkFilled = (timeout = 2000) =>
            page
                .waitForFunction(
                    (sel) => {
                        const el = document.querySelector(sel);
                        if (!el) return false;
                        const val = 'value' in el && el.value != null ? el.value : el.innerText;
                        return val.trim().length > 0;
                    },
                    // 'raf' not 'mutation': a MutationObserver over this app's whole
                    // subtree is expensive and was adding hundreds of ms.
                    { timeout, polling: 'raf' },
                    editorSelector
                )
                .then(() => true, () => false);

        // Fill in one shot (no visible char-by-char typing), by element type:
        //  - <textarea>/<input>: set .value via the native setter so React's
        //    onChange still fires, then dispatch 'input'.
        //  - contenteditable: execCommand('insertText') fires a genuine
        //    beforeinput/input that ProseMirror/Lexical handle atomically.
        let isFilled = false;
        try {
            const ok = await page.evaluate(
                (sel, text) => {
                    const el = document.querySelector(sel);
                    if (!el) return false;
                    el.focus();
                    const tag = el.tagName;
                    if (tag === 'TEXTAREA' || tag === 'INPUT') {
                        const proto = tag === 'TEXTAREA'
                            ? window.HTMLTextAreaElement.prototype
                            : window.HTMLInputElement.prototype;
                        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                        setter.call(el, text);
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        return el.value === text;
                    }
                    return document.execCommand('insertText', false, text);
                },
                editorSelector,
                prompt
            );
            isFilled = ok && (await checkFilled());
        } catch (e) {
            console.log("[!] fast fill failed:", e.message);
        }

        if (!isFilled) {
            console.log("[!] fast fill missed, falling back to page.keyboard.type...");
            // Clear first: the fast fill may have partially landed despite the
            // check timing out, and typing on top would duplicate the prompt.
            await page.keyboard.down('Control');
            await page.keyboard.press('KeyA');
            await page.keyboard.up('Control');
            await page.keyboard.press('Backspace');
            await page.keyboard.type(prompt, { delay: 0 });
        }
        lap('text inserted');

        // --- STEP 3: SUBMIT ---
        // A real paste keeps the editor's own state in sync, so Enter submits
        // straight away. No button-state gate: it only ever burned its timeout.
        await page.keyboard.press('Enter');
        lap('enter pressed');

        // --- STEP 4: WAIT FOR RESPONSE GENERATION ---
        // Wait max 45s for "Stop generating" button to appear then disappear
        const startTime = Date.now();
        const isGenerating = (stopSel) => {
            const stopBtn = document.querySelector(stopSel);
            return stopBtn !== null && stopBtn.offsetParent !== null;
        };

        // Generation started? (short wait — it may already have finished for tiny replies)
        await page
            .waitForFunction(isGenerating, { timeout: 5000, polling: 100 }, stopBtnSelector)
            .catch(() => {});

        while (Date.now() - startTime < 45000) {
            if (!(await page.evaluate(isGenerating, stopBtnSelector))) break;
            await sleep(250);
        }
        lap('generation (stop button)');

        // The stop-button selector is chatgpt.com-specific and may not exist
        // on other targetUrls, in which case the loop above exits instantly
        // and extraction would race ahead of the streaming text. So on top of
        // it, confirm the extracted text itself has stopped changing across
        // two consecutive polls before treating the reply as final.
        const extractReply = (selector) => {
            const elements = Array.from(document.querySelectorAll(selector));
            if (elements.length === 0) return null;

            // Several of these selectors match nested fragments (e.g. a
            // paragraph inside the markdown container inside the assistant
            // message). Keep only the outermost matches so we grab the whole
            // message, not just its last inner fragment.
            const topLevel = elements.filter(
                (el, i) => !elements.some((other, j) => j !== i && other.contains(el))
            );
            if (topLevel.length === 0) return null;

            const lastEl = topLevel[topLevel.length - 1];
            return lastEl.innerText || lastEl.textContent;
        };

        let replyText = null;
        while (Date.now() - startTime < 45000) {
            await sleep(400);
            const currentText = await page.evaluate(extractReply, responseSelector);
            if (currentText && currentText === replyText) break;
            replyText = currentText;
        }
        lap('generation (stable text)');

        if (!replyText) {
            throw new Error("Response generate hua par text extract nahi ho paya.");
        }

        lap('extract reply');
        return replyText.trim();

    } catch (err) {
        // Page/browser may be in a bad state — drop it so the next request relaunches.
        try { await browserInstance?.close(); } catch {}
        browserInstance = null;
        pageInstance = null;
        throw err;
    }
}

// --- EXPRESS ROUTE ---
app.post('/v1/generate', async (req, res) => {
    const { prompt, imageUrl, targetUrl } = req.body;

    if (!prompt) {
        return res.status(400).json({ success: false, error: "'prompt' field required hai." });
    }

    try {
        const reply = await processPromptAndGetReply({ prompt, imageUrl, targetUrl });
        return res.json({ success: true, prompt: prompt, response: reply });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
        try { await browserInstance?.close(); } catch {}
        process.exit(0);
    });
}