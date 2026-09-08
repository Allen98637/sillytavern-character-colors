import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const stApiStub = `
export const converter = { makeHtml: value => String(value) };
export const power_user = { quote_text_color: '#888888', encode_tags: false };
export const escapeHtml = value => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
export const escapeRegex = value => String(value).replace(/[/\\-\\\\^$*+?.()|[\\]{}]/g, '\\\\$&');
export const extension_settings = {};
let context = { chat: [], chatMetadata: {} };
export const getContext = () => context;
export const setTestContext = value => { context = value; };
export const eventSource = { on() {}, emit() {} };
export const event_types = {};
export const setExtensionPrompt = () => {};
export const saveSettings = () => {};
export const saveSettingsDebounced = () => {};
export const saveCharacterDebounced = () => {};
export const getCharacters = () => [];
export const extension_prompt_types = {};
export const extension_prompt_roles = {};
export const generateQuietPrompt = async () => '';
export const registerMacro = () => {};
export const getRequestHeaders = () => ({});
export const saveMetadata = () => {};
export const saveMetadataDebounced = () => {};
export const promptManager = null;
`;

globalThis.document ??= { body: {}, querySelector: () => null, querySelectorAll: () => [], head: null, createElement: () => ({}) };
globalThis.getComputedStyle ??= () => ({ backgroundColor: 'rgb(0, 0, 0)' });

const stApiUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(stApiStub)}`;
const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === './st-api.js') return { url: stApiUrl, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});

const { loadGoogleFont, syncRemoteFontLoadingPolicy, applyCustomFontsToFontTags, applyCustomFontsToMessageElement } = await import('../src/fonts.js');
const { buildColorRenderingLookup } = await import('../src/color-blocks.js');
const { characterColors, settings } = await import('../src/state.js');
const { getNarratorVisual } = await import('../src/narrator-style.js');
const { applyThemeReadabilityAndBrightness, getTextHighlightState } = await import('../src/palettes.js');
const { applyGradientText } = await import('../src/gradient-rendering.js');
hooks.deregister();

function makeStyle() {
    const properties = new Map();
    return {
        getPropertyValue: name => properties.get(name) ?? '',
        getPropertyPriority: () => '',
        setProperty(name, value) { properties.set(name, String(value)); },
        removeProperty(name) { properties.delete(name); },
    };
}

function makeElement(tagName = 'span') {
    const attributes = new Map();
    const classes = new Set();
    return {
        tagName,
        attributes,
        dataset: {},
        style: makeStyle(),
        textContent: '',
        disabled: false,
        rel: '',
        href: '',
        classList: {
            add: value => classes.add(value),
            remove: value => classes.delete(value),
            toggle: (value, on) => on ? classes.add(value) : classes.delete(value),
            contains: value => classes.has(value),
        },
        getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
        setAttribute(name, value) { attributes.set(String(name), String(value)); },
        hasAttribute(name) { return attributes.has(name); },
        removeAttribute(name) { attributes.delete(name); },
        remove() {},
        querySelectorAll() { return []; },
    };
}

function withFontsDocument(run) {
    const links = [];
    const previousHead = document.head;
    const previousCreateElement = document.createElement;
    const previousQuerySelectorAll = document.querySelectorAll;
    const previousRemote = settings.allowRemoteFonts;
    document.head = {
        appendChild(link) { links.push(link); },
        querySelectorAll(selector) {
            if (!String(selector).includes('data-dc-google-font')) return [];
            return links.filter(link => link.dataset.dcGoogleFont || link.dataset.dcGoogleFontFallback);
        },
    };
    document.createElement = tag => makeElement(tag);
    document.querySelectorAll = selector => document.head.querySelectorAll(selector);
    try {
        return run(links);
    } finally {
        document.head = previousHead;
        document.createElement = previousCreateElement;
        document.querySelectorAll = previousQuerySelectorAll;
        settings.allowRemoteFonts = previousRemote;
    }
}

test('failed remote font requests keep their budget slot', () => {
    withFontsDocument(links => {
        settings.allowRemoteFonts = true;
        loadGoogleFont('Family F0');
        loadGoogleFont('Family F0');
        assert.equal(links.length, 1, 'in-flight requests are deduplicated');
        for (let i = 0; i < 16; i++) loadGoogleFont(`Family F${i}`);
        assert.equal(links.length, 16, 'the disclosed cap allows exactly the budget of requests');
        for (const link of [...links]) if (link.onerror) link.onerror();
        for (let i = 16; i < 24; i++) loadGoogleFont(`Family F${i}`);
        assert.equal(links.length, 16, 'failed families must not free request slots for unlimited retries');
        loadGoogleFont('Family F0');
        assert.equal(links.length, 16, 're-requesting the same family stays deduplicated');
        settings.allowRemoteFonts = false;
        syncRemoteFontLoadingPolicy();
        settings.allowRemoteFonts = true;
        syncRemoteFontLoadingPolicy();
        assert.ok(links.every(link => link.disabled), 'failed links are not re-enabled by policy changes');
    });
});

test('the narrator font decorates its saved font tag', () => {
    const previousNarrator = settings.narratorStyle;
    const previousRemote = settings.allowRemoteFonts;
    settings.allowRemoteFonts = false;
    settings.narratorStyle = { enabled: true, baseColor: '#888888', font: 'Noto Serif', style: 'italic', gradient: null, gradientGenerator: null };
    try {
        const rawText = '<font color="#888888">"Narrated."</font>\n[COLORS:Narrator=#888888]';
        const narratorKey = [...buildColorRenderingLookup(rawText).entries()]
            .find(([, rendering]) => rendering?.entry?.kind === 'narrator')?.[0];
        assert.ok(narratorKey, 'the narrator must have a resolved rendering for its colour');
        const fontEl = makeElement('font');
        fontEl.setAttribute('color', narratorKey);
        const mesText = { querySelectorAll: selector => (String(selector).includes('font') ? [fontEl] : []) };
        applyCustomFontsToFontTags(mesText, rawText);
        assert.ok(fontEl.style.getPropertyValue('font-family').includes('Noto Serif'),
            'the narrator family must decorate the saved tag like its other styling');
    } finally {
        settings.narratorStyle = previousNarrator;
        settings.allowRemoteFonts = previousRemote;
    }
});

test('hidden ordinary messages keep their styling while host messages are cleared', () => {
    const previousSettings = { ...settings };
    settings.enabled = true;
    settings.allowRemoteFonts = false;
    const previousColors = { ...characterColors };
    characterColors.alice = { name: 'Alice', color: '#112233', aliases: [], font: 'Marker Felt', style: 'bold', gradient: null, gradientGenerator: null };
    try {
        const fontEl = makeElement('font');
        fontEl.setAttribute('color', '#112233');
        const mesText = { querySelectorAll: selector => (String(selector).includes('font') ? [fontEl] : []) };
        const mesElement = {
            querySelector: selector => (selector === '.mes_text' ? mesText : null),
            getAttribute: name => (name === 'mesid' ? '1' : null),
        };

        const ordinaryHidden = { name: 'Alice', is_system: true, extra: {}, mes: '<font color="#112233">"Hi."</font>' };
        applyCustomFontsToMessageElement(mesElement, [null, ordinaryHidden]);
        assert.ok(fontEl.style.getPropertyValue('font-family').includes('Marker Felt'),
            'hiding an ordinary message must not strip its extension styling');
        assert.ok(fontEl.style.getPropertyValue('color'), 'the preview colour stays applied too');

        const toolCall = { name: 'Alice', is_system: true, extra: { tool_invocations: [{ id: 't1' }] }, mes: '<font color="#112233">"Hi."</font>' };
        applyCustomFontsToMessageElement(mesElement, [null, toolCall]);
        assert.equal(fontEl.style.getPropertyValue('font-family'), '',
            'genuine host tool messages still get their extension styling cleared');
    } finally {
        for (const key of Object.keys(characterColors)) delete characterColors[key];
        Object.assign(characterColors, previousColors);
        Object.assign(settings, previousSettings);
    }
});

test('ambiguous narrator and character colours do not select either font without metadata', () => {
    const previousSettings = { ...settings };
    const previousColors = { ...characterColors };
    Object.assign(settings, { allowRemoteFonts: false, narratorStyle: { enabled: true, baseColor: '#888888', font: 'Noto Serif' } });
    const narrator = getNarratorVisual(settings, applyThemeReadabilityAndBrightness);
    characterColors.alice = { name: 'Alice', color: narrator.color, baseColor: '#888888', font: 'Marker Felt' };
    try {
        const fontEl = makeElement('font');
        fontEl.setAttribute('color', narrator.color);
        const mesText = { querySelectorAll: () => [fontEl] };
        applyCustomFontsToFontTags(mesText, `[COLORS:Narrator=${narrator.color}]`);
        assert.ok(fontEl.style.getPropertyValue('font-family').includes('Noto Serif'));
        applyCustomFontsToFontTags(mesText, '');
        assert.equal(fontEl.style.getPropertyValue('font-family'), '');
        applyCustomFontsToFontTags(mesText, `[COLORS:Narrator=${narrator.color},Alice=${narrator.color}]`);
        assert.equal(fontEl.style.getPropertyValue('font-family'), '');
    } finally {
        for (const key of Object.keys(characterColors)) delete characterColors[key];
        Object.assign(characterColors, previousColors);
        Object.assign(settings, previousSettings);
    }
});

test('gradient repaint removes a highlight rejected by the shared contrast decision', () => {
    const previousSettings = { ...settings };
    Object.assign(settings, { themeMode: 'dark', highlightMode: true });
    try {
        const element = makeElement();
        const entry = { color: '#eeeeee', gradient: { type: 'linear', stops: [{ color: '#dddddd', position: 100 }] } };
        const paint = surface => applyGradientText(element, entry, { highlightColor: getTextHighlightState(entry.color, surface).color });
        assert.equal(paint('#202328').applied, true);
        assert.equal(element.style.getPropertyValue('--dc-gradient-highlight'), '#eeeeee26');
        assert.equal(element.classList.contains('dc-gradient-highlight'), true);
        assert.equal(paint('#777777').applied, true);
        assert.equal(element.style.getPropertyValue('--dc-gradient-highlight'), '');
        assert.equal(element.classList.contains('dc-gradient-highlight'), false);
        assert.equal(paint('#777777').changed, false, 'unchanged repaint is a no-op');
    } finally {
        Object.assign(settings, previousSettings);
    }
});
