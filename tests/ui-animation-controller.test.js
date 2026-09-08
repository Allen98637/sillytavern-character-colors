import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function createEventTarget() {
    const listeners = new Map();
    return {
        addEventListener(type, listener) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(listener);
        },
        removeEventListener(type, listener) {
            listeners.get(type)?.delete(listener);
        },
        dispatch(type) {
            for (const listener of [...(listeners.get(type) || [])]) listener({ type });
        },
        listenerCount(type) {
            return listeners.get(type)?.size || 0;
        },
    };
}

function createClassList(initial = []) {
    const values = new Set(initial);
    const calls = { add: new Map(), remove: new Map() };
    return {
        add(value) { calls.add.set(value, (calls.add.get(value) || 0) + 1); values.add(value); },
        remove(value) { calls.remove.set(value, (calls.remove.get(value) || 0) + 1); values.delete(value); },
        contains(value) { return values.has(value); },
        callCount(action, value) { return calls[action].get(value) || 0; },
    };
}

test('scroll refreshes auto-animation visibility without IntersectionObserver and destroy removes listeners', async () => {
    const originalDescriptors = new Map(['document', 'window', 'innerWidth', 'innerHeight', 'IntersectionObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia']
        .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const documentTarget = createEventTarget();
    const viewportTarget = createEventTarget();
    const visualViewportTarget = createEventTarget();
    const fakeDocument = Object.assign(documentTarget, {
        hidden: false,
        documentElement: { clientWidth: 800, clientHeight: 600 },
    });
    const fakeWindow = Object.assign(viewportTarget, { visualViewport: visualViewportTarget });
    let rect = { top: 10, bottom: 50, left: 10, right: 50 };
    const animatedElement = {
        classList: createClassList(['dc-gradient-animated', 'dc-gradient-text']),
        isConnected: true,
    };
    const root = {
        classList: createClassList(['mes']),
        isConnected: true,
        contains: element => element === animatedElement,
        getBoundingClientRect: () => rect,
        matches: selector => selector === '.mes',
        querySelectorAll: () => [animatedElement],
    };
    let controller;

    try {
        Object.defineProperties(globalThis, {
            document: { configurable: true, writable: true, value: fakeDocument },
            window: { configurable: true, writable: true, value: fakeWindow },
            innerWidth: { configurable: true, writable: true, value: 800 },
            innerHeight: { configurable: true, writable: true, value: 600 },
            IntersectionObserver: { configurable: true, writable: true, value: undefined },
            requestAnimationFrame: { configurable: true, writable: true, value: undefined },
            cancelAnimationFrame: { configurable: true, writable: true, value: undefined },
            matchMedia: { configurable: true, writable: true, value: undefined },
        });
        controller = await import(new URL('../src/animation-controller.js?ui-fallback-test', import.meta.url));
        const { settings } = await import('../src/state.js');
        settings.gradientAnimationMode = 'auto';

        controller.registerGradientAnimationRoot(root);
        assert.equal(controller.getGradientAnimationState().observerEnabled, false);
        assert.equal(controller.getGradientAnimationState().fallbackVisibilityEnabled, true);
        assert.equal(animatedElement.classList.contains('dc-gradient-running'), true);
        assert.equal(documentTarget.listenerCount('scroll'), 1);
        assert.equal(viewportTarget.listenerCount('resize'), 1);

        rect = { top: 2000, bottom: 2040, left: 10, right: 50 };
        documentTarget.dispatch('scroll');
        assert.equal(animatedElement.classList.contains('dc-gradient-running'), false);

        rect = { top: 10, bottom: 50, left: 10, right: 50 };
        documentTarget.dispatch('scroll');
        const runningAdds = animatedElement.classList.callCount('add', 'dc-gradient-running');
        const runningRemoves = animatedElement.classList.callCount('remove', 'dc-gradient-running');
        controller.refreshGradientAnimationState();
        assert.equal(animatedElement.classList.callCount('add', 'dc-gradient-running'), runningAdds);
        assert.equal(animatedElement.classList.callCount('remove', 'dc-gradient-running'), runningRemoves);

        controller.unregisterGradientAnimationRoot(root);
        assert.equal(controller.getGradientAnimationState().rootCount, 0);
        assert.equal(controller.getGradientAnimationState().fallbackVisibilityEnabled, false);
        assert.equal(documentTarget.listenerCount('scroll'), 0);
        assert.equal(viewportTarget.listenerCount('resize'), 0);

        const descendants = Array.from({ length: 2049 }, () => ({ matches: () => false }));
        fakeDocument.createTreeWalker = () => {
            let index = 0;
            return { nextNode: () => descendants[index++] || null };
        };
        const oversizedEmptyRoot = {
            classList: createClassList(['mes']),
            isConnected: true,
            matches: selector => selector === '.mes',
            querySelector: () => null,
            getBoundingClientRect: () => ({ top: 10, bottom: 50, left: 10, right: 50 }),
        };
        controller.registerGradientAnimationRoot(oversizedEmptyRoot);
        assert.equal(controller.getGradientAnimationState().rootCount, 0);
        assert.equal(controller.getGradientAnimationState().fallbackVisibilityEnabled, false);

        controller.destroyGradientAnimationController();
        assert.equal(documentTarget.listenerCount('scroll'), 0);
        assert.equal(documentTarget.listenerCount('visibilitychange'), 0);
        assert.equal(viewportTarget.listenerCount('scroll'), 0);
        assert.equal(viewportTarget.listenerCount('resize'), 0);
        assert.equal(visualViewportTarget.listenerCount('scroll'), 0);
        assert.equal(visualViewportTarget.listenerCount('resize'), 0);
    } finally {
        controller?.destroyGradientAnimationController();
        for (const [name, descriptor] of originalDescriptors) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    }
});

test('removing every animated root during a fallback sweep does not throw', async () => {
    const originalDescriptors = new Map(['document', 'window', 'innerWidth', 'innerHeight', 'IntersectionObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia']
        .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const documentTarget = createEventTarget();
    const viewportTarget = createEventTarget();
    const visualViewportTarget = createEventTarget();
    const fakeDocument = Object.assign(documentTarget, {
        hidden: false,
        documentElement: { clientWidth: 800, clientHeight: 600 },
    });
    const fakeWindow = Object.assign(viewportTarget, { visualViewport: visualViewportTarget });
    let controller;
    const roots = [];

    try {
        Object.defineProperties(globalThis, {
            document: { configurable: true, writable: true, value: fakeDocument },
            window: { configurable: true, writable: true, value: fakeWindow },
            innerWidth: { configurable: true, writable: true, value: 800 },
            innerHeight: { configurable: true, writable: true, value: 600 },
            IntersectionObserver: { configurable: true, writable: true, value: undefined },
            requestAnimationFrame: { configurable: true, writable: true, value: undefined },
            cancelAnimationFrame: { configurable: true, writable: true, value: undefined },
            matchMedia: { configurable: true, writable: true, value: undefined },
        });
        controller = await import(new URL(`../src/animation-controller.js?ui-fallback-cleanup-${Date.now()}`, import.meta.url));
        const { settings } = await import('../src/state.js');
        settings.gradientAnimationMode = 'auto';

        const animated = () => ({
            classList: createClassList(['dc-gradient-animated', 'dc-gradient-text']),
            isConnected: true,
        });
        for (let i = 0; i < 25; i++) {
            const element = animated();
            const root = {
                classList: createClassList(['mes']),
                isConnected: true,
                contains: candidate => candidate === element,
                getBoundingClientRect: () => ({ top: 2000, bottom: 2040, left: 10, right: 50 }),
                matches: selector => selector === '.mes',
                querySelectorAll: () => [element],
            };
            roots.push(root);
            controller.registerGradientAnimationRoot(root);
        }
        assert.equal(controller.getGradientAnimationState().rootCount, 25);
        // More than the 24-root maintenance batch: the sweep must handle all.
        controller.refreshGradientAnimationState();

        for (const root of roots) root.isConnected = false;
        assert.doesNotThrow(() => controller.refreshGradientAnimationState(),
            'disconnecting every root mid-sweep must not throw');
        assert.equal(controller.getGradientAnimationState().rootCount, 0);
        assert.equal(controller.getGradientAnimationState().fallbackVisibilityEnabled, false);
    } finally {
        controller?.destroyGradientAnimationController();
        for (const [name, descriptor] of originalDescriptors) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    }
});

// Optional local-browser check; never installs a browser or contacts a host.
test('checkbox and danger text contrast survive custom themes', { skip: !process.env.DC_PLAYWRIGHT_MODULE }, async t => {
    const playwright = await import(process.env.DC_PLAYWRIGHT_MODULE);
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    const browser = await playwright[process.env.DC_BROWSER_TYPE || 'chromium'].launch({ headless: true, executablePath: process.env.DC_BROWSER_EXECUTABLE });
    try {
        const page = await browser.newPage();
        await page.route('**/*', route => route.abort());
        t.diagnostic(await page.evaluate(() => `${navigator.userAgent}; contrast-color=${CSS.supports('color', 'contrast-color(red)')}; relative-rgb=${CSS.supports('color', 'rgb(from red r g b / 1)')}`));
        await page.setContent('<main id="dc-ext"><section class="dc-section"><p class="dc-field-error">Invalid value</p><button class="dc-page-tab" data-dc-tab="danger" aria-selected="true">Danger</button><label class="checkbox_label"><input type="checkbox" checked><span>Enabled</span></label></section></main>');
        await page.addStyleTag({ content: css });
        const themes = [
            ['#202328', '#f7f7f8', '#55aa99'],
            ['#f5f5f5', '#222222', '#55aa99'],
            ['rgba(119, 119, 119, 0.15)', '#888888', '#111111'],
            ['#102040', '#00ff00', '#ffffee'],
        ];
        for (const width of [360, 1280]) {
            await page.setViewportSize({ width, height: 720 });
            for (const [surface, body, accent] of themes) {
                const result = await page.evaluate(async ({ surface, body, accent }) => {
                    const root = document.querySelector('#dc-ext');
                    root.style.setProperty('--SmartThemeBlurTintColor', surface);
                    root.style.setProperty('--SmartThemeBodyColor', body);
                    root.style.setProperty('--SmartThemeQuoteColor', accent);
                    await new Promise(resolve => setTimeout(resolve, 200));
                    const canvas = document.createElement('canvas');
                    canvas.width = canvas.height = 1;
                    const context = canvas.getContext('2d', { willReadFrequently: true });
                    const rgb = color => {
                        context.clearRect(0, 0, 1, 1);
                        context.fillStyle = color;
                        context.fillRect(0, 0, 1, 1);
                        return [...context.getImageData(0, 0, 1, 1).data];
                    };
                    const luminance = rgb => rgb.slice(0, 3).map(channel => {
                        const c = channel / 255;
                        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
                    }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
                    const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
                    const contrasts = [...document.querySelectorAll('.dc-field-error, .dc-page-tab')].map(element => {
                        const style = getComputedStyle(element);
                        const background = rgb(style.backgroundColor);
                        return { ratio: ratio(luminance(rgb(style.color)), luminance(background)), alpha: background[3] };
                    });
                    const checkbox = document.querySelector('input');
                    const mark = getComputedStyle(checkbox, '::after');
                    return {
                        contrasts,
                        nativeContrast: CSS.supports('color', 'contrast-color(red)') && CSS.supports('color', 'rgb(from red r g b)'),
                        appearance: getComputedStyle(checkbox).appearance,
                        pseudo: getComputedStyle(checkbox, '::after').content,
                        markContrast: ratio(luminance(rgb(mark.borderLeftColor)), luminance(rgb(getComputedStyle(checkbox).backgroundColor))),
                        overflows: document.documentElement.scrollWidth > innerWidth,
                    };
                }, { surface, body, accent });
                assert.ok(result.contrasts.every(({ ratio, alpha }) => ratio >= 4.5 && alpha === 255), JSON.stringify({ width, surface, result }));
                assert.equal(result.appearance, result.nativeContrast ? 'none' : 'auto');
                assert.equal(result.pseudo, result.nativeContrast ? '""' : 'none');
                if (result.nativeContrast) assert.ok(result.markContrast >= 4.5);
                assert.equal(result.overflows, false);
                const checkbox = page.locator('input');
                await checkbox.focus();
                await checkbox.press('Space');
                assert.equal(await checkbox.isChecked(), false);
                await checkbox.press('Space');
                assert.equal(await checkbox.isChecked(), true);
                const png = await checkbox.screenshot();
                const markRatio = await page.evaluate(async base64 => {
                    const bytes = Uint8Array.from(atob(base64), ch => ch.charCodeAt(0));
                    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
                    const canvas = document.createElement('canvas');
                    canvas.width = bitmap.width;
                    canvas.height = bitmap.height;
                    const context = canvas.getContext('2d');
                    context.drawImage(bitmap, 0, 0);
                    const data = context.getImageData(2, 2, bitmap.width - 4, bitmap.height - 4).data;
                    const counts = new Map();
                    for (let i = 0; i < data.length; i += 4) {
                        const color = [...data.slice(i, i + 3)].join(',');
                        counts.set(color, (counts.get(color) || 0) + 1);
                    }
                    const luminances = [...counts].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1]).map(([color]) => color.split(',').reduce((sum, channel, i) => {
                        const c = Number(channel) / 255;
                        return sum + (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i];
                    }, 0));
                    const [background, ...marks] = luminances;
                    return Math.max(...marks.map(mark => (Math.max(background, mark) + 0.05) / (Math.min(background, mark) + 0.05)));
                }, png.toString('base64'));
                assert.ok(markRatio >= 3, `checkmark ${accent}: ${markRatio}`);
                t.diagnostic(`${width}px ${surface} / ${accent}: text ${result.contrasts[0].ratio.toFixed(2)}:1, checkmark ${markRatio.toFixed(2)}:1`);
            }
        }
        await page.evaluate(() => {
            for (const sheet of document.styleSheets) {
                for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
                    const rule = sheet.cssRules[i];
                    if (rule instanceof CSSSupportsRule && rule.conditionText.includes('contrast-color')) sheet.deleteRule(i);
                }
            }
        });
        for (const scheme of ['light', 'dark']) {
            const fallback = await page.evaluate(scheme => {
                document.querySelector('#dc-ext').style.colorScheme = scheme;
                const checkbox = document.querySelector('input');
                if (getComputedStyle(checkbox).appearance !== 'auto' || getComputedStyle(checkbox).accentColor !== 'auto'
                    || getComputedStyle(checkbox, '::after').content !== 'none') throw new Error('native checkbox fallback was overridden');
                const style = getComputedStyle(document.querySelector('.dc-field-error'));
                return [style.color, style.backgroundColor];
            }, scheme);
            const luminances = fallback.map(color => color.match(/[\d.]+/g).slice(0, 3).reduce((sum, channel, i) => {
                const c = Number(channel) / 255;
                return sum + (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i];
            }, 0));
            assert.ok((Math.max(...luminances) + 0.05) / (Math.min(...luminances) + 0.05) >= 4.5, 'unsupported browsers retain a readable system-colour pair');
        }
    } finally {
        await browser.close();
    }
});
