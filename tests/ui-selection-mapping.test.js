import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const stubSources = new Map([
    ['./attribution.js', 'export const attributeDialogueSegments = () => ({ segments: [] });'],
    ['./color-blocks.js', 'export const resolveCharacterKeyByNameOrAlias = () => "";'],
    ['./dom-engine.js', `
        export const cancelMessageDomFollowupRepairs = () => {};
        export const clearMessageDomRepairTimer = () => {};
        export const clearStreamingAttributionOverrides = () => {};
        export const decorateMessageDomFromCurrentRender = async () => false;
        export const deleteMessageQuoteOverride = () => false;
        export const getMessageAttributionFreezeSegments = () => ({});
        export const getMessageIndexFromElement = () => -1;
        export const getMessageQuoteOverrideEntry = () => null;
        export const getMessageQuoteOverrideOptions = () => ({});
        export const isStreamingOwnedMessage = () => false;
        export const matchSegmentsToElements = () => {};
        export const refreshAndDecorateMessageDom = async () => false;
        export const refreshMessageDom = () => {};
        export const resolveDomSegmentIndexForElement = () => null;
        export const restoreMessageQuoteOverrideEntry = () => {};
        export const scheduleMessageDomFollowupRepair = () => {};
        export const setMessageQuoteOverride = () => false;
    `],
    ['./fonts.js', 'export const scheduleCustomFontRefresh = () => {};'],
    ['./live-colors.js', `
        export const applyLiveColorChangesFromSnapshot = () => {};
        export const captureEffectiveColorSnapshot = () => null;
        export const commit = () => {};
        export const flushChatSave = () => {};
        export const parseCanonicalFontMarkup = () => null;
        export const queueChatSave = () => {};
        export const replaceCanonicalFontSpanColor = () => null;
    `],
    ['./palettes.js', `
        export const buildCharacterEntry = () => ({ entry: null });
        export const getEntryEffectiveColor = () => "#888888";
        export const setEntryFromEffectiveColor = () => {};
    `],
    ['./st-api.js', `
        export const escapeHtml = value => String(value)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#39;");
        export const eventSource = { on() {} };
        export const event_types = {};
        export const getContext = () => ({ chat: [] });
        export const power_user = { quote_text_color: "#888888" };
    `],
    ['./state.js', `
        export const characterColors = Object.create(null);
        export const isDomEngine = () => false;
        export const runtimeState = {};
        export const settings = {};
    `],
    ['./streaming-paint.js', 'export const paintStreamingMessage = () => false;'],
    ['./ui.js', `
        export const getSortedEntries = () => [];
        export const updateLegend = () => {};
    `],
    ['./utils.js', `
        export const escapeAttr = value => String(value);
        export const hashMessageText = value => String(value);
        export const isToolCallMessage = () => false;
        export const normalizeHexColor = (value, fallback = null) => /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value).toLowerCase() : fallback;
        export const normalizeSegmentText = value => String(value || "");
        export const toast = { error() {}, info() {}, success() {}, warning() {} };
    `],
]);

const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
        if (context.parentURL?.includes('/src/context-menu.js') && stubSources.has(specifier)) {
            return {
                url: `data:text/javascript;charset=utf-8,${encodeURIComponent(stubSources.get(specifier))}`,
                shortCircuit: true,
            };
        }
        return nextResolve(specifier, context);
    },
});

const {
    mapRenderedSelectionToSourceSpan,
    replaceMessageSelectionWithFontTag,
} = await import(new URL('../src/context-menu.js?ui-selection-mapping-test', import.meta.url));
hooks.deregister();

test('maps the final overlapping rendered occurrence to the final source span', () => {
    assert.deepEqual(mapRenderedSelectionToSourceSpan('aaa', 'aaa', 'aa', 1), { start: 1, end: 3 });
});

test('counts unsafe visible occurrences before a later safe occurrence', () => {
    const codeSource = '`aa` aa';
    assert.equal(mapRenderedSelectionToSourceSpan(codeSource, 'aa aa', 'aa', 0), null);
    assert.deepEqual(
        mapRenderedSelectionToSourceSpan(codeSource, 'aa aa', 'aa', 3),
        { start: codeSource.lastIndexOf('aa'), end: codeSource.length },
    );

    const escapedSource = '\\_ _';
    assert.equal(mapRenderedSelectionToSourceSpan(escapedSource, '_ _', '_', 0), null);
    assert.deepEqual(
        mapRenderedSelectionToSourceSpan(escapedSource, '_ _', '_', 2),
        { start: escapedSource.lastIndexOf('_'), end: escapedSource.length },
    );
});

test('does not count hidden HTML or Markdown destinations as rendered occurrences', () => {
    const destinationSource = '[label](aa) aa';
    const destinationStart = destinationSource.lastIndexOf('aa');
    assert.deepEqual(
        mapRenderedSelectionToSourceSpan(destinationSource, 'label aa', 'aa', 6),
        { start: destinationStart, end: destinationStart + 2 },
    );

    const htmlSource = '<span data-value="aa">label</span> aa';
    const htmlStart = htmlSource.lastIndexOf('aa');
    assert.deepEqual(
        mapRenderedSelectionToSourceSpan(htmlSource, 'label aa', 'aa', 6),
        { start: htmlStart, end: htmlStart + 2 },
    );
});

test('counts decoded entities but fails closed when the selected occurrence is encoded', () => {
    const source = '&amp; &';
    assert.equal(mapRenderedSelectionToSourceSpan(source, '& &', '&', 0), null);
    assert.deepEqual(mapRenderedSelectionToSourceSpan(source, '& &', '&', 2), { start: 6, end: 7 });
});

test('fails closed when the local projection cannot decode or model rendered syntax', () => {
    assert.equal(mapRenderedSelectionToSourceSpan('&copy; ©', '© ©', '©', 0), null);
    assert.equal(mapRenderedSelectionToSourceSpan('&copy; ©', '© ©', '©', 2), null);
    assert.equal(mapRenderedSelectionToSourceSpan('![alt](image.png) alt', 'alt alt', 'alt', 4), null);
    assert.equal(mapRenderedSelectionToSourceSpan('<https://example.test> example.test', 'https://example.test example.test', 'example.test', 21), null);
    assert.equal(mapRenderedSelectionToSourceSpan('<alice@example.test> alice', 'alice@example.test alice', 'alice', 19), null);
    assert.equal(mapRenderedSelectionToSourceSpan('<irc:room> room', 'irc:room room', 'room', 9), null);
    assert.equal(mapRenderedSelectionToSourceSpan('&#0; A', '� A', 'A', 2), null);
});

test('keeps UTF-16 source offsets aligned after an astral numeric entity', () => {
    const source = '&#x1F600;AA';
    const firstA = source.indexOf('A');
    assert.deepEqual(mapRenderedSelectionToSourceSpan(source, '😀AA', 'A', 2), {
        start: firstA,
        end: firstA + 1,
    });
    assert.deepEqual(mapRenderedSelectionToSourceSpan(source, '😀AA', 'A', 3), {
        start: firstA + 1,
        end: firstA + 2,
    });
    assert.equal(mapRenderedSelectionToSourceSpan(source, '😀AA', '😀', 0), null);
});

test('excludes nested Markdown destinations from source occurrence mapping', () => {
    const source = '[outer [inner]](aa) aa';
    const start = source.lastIndexOf('aa');
    assert.deepEqual(
        mapRenderedSelectionToSourceSpan(source, 'outer [inner] aa', 'aa', 14),
        { start, end: start + 2 },
    );
});

test('preserves duplicate, multiline, underscore, bracket, and plain-text mapping', () => {
    const cases = [
        ['aa aa', 'aa'],
        ['first line\nsecond line\nsecond line', 'second line'],
        ['name_under name_under', 'name_under'],
        ['[plain] [plain]', '[plain]'],
        ['ordinary text ordinary text', 'ordinary text'],
    ];
    for (const [source, selection] of cases) {
        const start = source.lastIndexOf(selection);
        assert.deepEqual(
            mapRenderedSelectionToSourceSpan(source, source, selection, start),
            { start, end: start + selection.length },
        );
    }
});

test('host paragraph whitespace maps selections back to their exact saved offsets', () => {
    // Installed Showdown with simpleLineBreaks emits
    // <p>First paragraph.</p>\n<p>Second paragraph.</p> for these plain fixtures.
    for (const gap of ['\n\n', '\n\n\n', '\r\n\r\n', '\n \n']) {
        const source = `First paragraph.${gap}Second paragraph.`;
        const rendered = 'First paragraph.\nSecond paragraph.';
        const selection = 'Second paragraph.';
        const start = source.indexOf(selection);
        assert.deepEqual(mapRenderedSelectionToSourceSpan(source, rendered, selection, rendered.indexOf(selection)), {
            start, end: source.length,
        });
        const message = { mes: source };
        assert.equal(replaceMessageSelectionWithFontTag(message, selection, '#123456', {
            renderedText: rendered, renderedStartOffset: rendered.indexOf(selection),
        }), true);
        assert.equal(message.mes, `First paragraph.${gap}<font color="#123456">Second paragraph.</font>`);
    }

    const source = 'Same.\n\nSame.\n\nSame.';
    const rendered = 'Same.\nSame.\nSame.';
    assert.deepEqual(mapRenderedSelectionToSourceSpan(source, rendered, 'Same.', rendered.lastIndexOf('Same.')), {
        start: source.lastIndexOf('Same.'), end: source.length,
    });
    const entitySource = '&#x1F600;\r\n\r\nAA';
    assert.deepEqual(mapRenderedSelectionToSourceSpan(entitySource, '\u{1f600}\nAA', 'A', 4), {
        start: entitySource.length - 1, end: entitySource.length,
    }, 'UTF-16 offsets remain aligned after entity decoding and paragraph contraction');
});

test('paragraph contraction cannot redirect a multiline selection to a later exact occurrence', () => {
    const source = 'a\n\nb a\nb';
    const rendered = 'a\nb a\nb';
    assert.equal(mapRenderedSelectionToSourceSpan(source, rendered, 'a\nb', 0), null);
    const start = source.lastIndexOf('a\nb');
    assert.deepEqual(mapRenderedSelectionToSourceSpan(source, rendered, 'a\nb', rendered.lastIndexOf('a\nb')), {
        start, end: source.length,
    });
    assert.equal(mapRenderedSelectionToSourceSpan(source, rendered, '\nb', 1), null,
        'a contracted separator cannot be represented by just its last source newline');
});

test('paragraph whitespace matching still refuses changed words and unsafe source selections', () => {
    assert.equal(mapRenderedSelectionToSourceSpan('Alice.\n\nBob.', 'Bob.\nAlice.', 'Alice.', 5), null);
    assert.equal(mapRenderedSelectionToSourceSpan('Alice Bob.\n\nEnd.', 'AliceBob.\nEnd.', 'End.', 10), null,
        'spaces inside text are not ignored');
    const source = '`aa`\n\n<span title="aa">aa</span>\n\n&amp; &';
    const rendered = 'aa\naa\n& &';
    assert.equal(mapRenderedSelectionToSourceSpan(source, rendered, 'aa', 0), null);
    const start = source.indexOf('>aa<') + 1;
    assert.deepEqual(mapRenderedSelectionToSourceSpan(source, rendered, 'aa', 3), { start, end: start + 2 });
    assert.equal(mapRenderedSelectionToSourceSpan(source, rendered, '&', rendered.indexOf('&')), null);
    assert.deepEqual(mapRenderedSelectionToSourceSpan(source, rendered, '&', rendered.lastIndexOf('&')), {
        start: source.length - 1, end: source.length,
    });
});

test('escapes exact source text before inserting font markup', () => {
    const selectedText = '5 < 6 & 7';
    const msg = { mes: selectedText };

    assert.equal(replaceMessageSelectionWithFontTag(msg, selectedText, '#12ABef', {
        sourceStart: 0,
        sourceEnd: selectedText.length,
    }), true);
    assert.equal(msg.mes, '<font color="#12abef">5 &lt; 6 &amp; 7</font>');

    const unsafe = { mes: '`aa` aa' };
    assert.equal(replaceMessageSelectionWithFontTag(unsafe, 'aa', '#123456', {
        sourceStart: 1,
        sourceEnd: 3,
    }), false);
    assert.equal(unsafe.mes, '`aa` aa');
});

test('rewritten text with no established correspondence declines the mapping', () => {
    // The macro renders as an extra occurrence, so rendered ordinal 0 no
    // longer matches source ordinal 0.
    assert.equal(mapRenderedSelectionToSourceSpan('{{char}} said Alice.', 'Alice said Alice.', 'Alice', 0), null);

    const heading = '# Heading\n\n#';
    const rendered = 'Heading\n#';
    assert.deepEqual(mapRenderedSelectionToSourceSpan(heading, rendered, '#', rendered.lastIndexOf('#')),
        { start: 11, end: 12 });

    assert.equal(mapRenderedSelectionToSourceSpan('Alice then Bob', 'Bob then Alice', 'Alice', 9), null,
        'equal counts cannot establish the location of rewritten text');
    assert.equal(mapRenderedSelectionToSourceSpan('{{char}} said Alice.', 'Alice said Bob.', 'Alice', 0), null,
        'a macro can add an occurrence while another display rewrite removes one');
});
