import { connect } from 'puppeteer-real-browser';
import { findChrome, getProfileDir } from './findChrome.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Usage: node inspect.js "https://claude.ai/new"
const url = process.argv[2] || 'https://chatgpt.com/?temporary-chat=true';
// How long to wait after load before scanning (composers hydrate late).
const settle = Number(process.argv[3] || 4000);

const { browser, page } = await connect({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,900'],
    customConfig: {
        userDataDir: getProfileDir(),
        executablePath: findChrome() || undefined
    },
    turnstile: false
});

await page.setViewport({ width: 1280, height: 900 });
console.log(`\nNavigating to ${url} ...`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await sleep(settle);

const report = await page.evaluate(() => {
    const uniqueSelector = (el) => {
        if (el.id) return `#${CSS.escape(el.id)}`;
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && parts.length < 4) {
            let part = node.tagName.toLowerCase();
            if (node.getAttribute('contenteditable') !== null) part += '[contenteditable]';
            const role = node.getAttribute('role');
            if (role) part += `[role="${role}"]`;
            const tid = node.getAttribute('data-testid');
            if (tid) part += `[data-testid="${tid}"]`;
            parts.unshift(part);
            if (node.id) {
                parts[0] = `#${CSS.escape(node.id)} ` + parts[0];
                break;
            }
            node = node.parentElement;
        }
        return parts.join(' > ');
    };

    const candidates = Array.from(
        document.querySelectorAll(
            'textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"], .ProseMirror'
        )
    );

    return candidates.map((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            classes: el.className && typeof el.className === 'string' ? el.className.slice(0, 120) : null,
            contenteditable: el.getAttribute('contenteditable'),
            role: el.getAttribute('role'),
            dataTestid: el.getAttribute('data-testid'),
            placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || null,
            ariaLabel: el.getAttribute('aria-label'),
            visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            selector: uniqueSelector(el)
        };
    });
});

console.log(`\nFound ${report.length} candidate input element(s):\n`);
for (const c of report) {
    console.log(JSON.stringify(c, null, 2));
    console.log('---');
}

console.log('\nInspect the browser window, then press Ctrl+C to close.');
// Keep open so you can eyeball the page / DevTools.
await sleep(600000);
await browser.close();
