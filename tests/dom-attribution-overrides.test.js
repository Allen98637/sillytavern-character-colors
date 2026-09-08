import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// Every src module reaches SillyTavern through st-api.js, which imports paths
// that only resolve inside a SillyTavern install. Stubbing that one module lets
// the real attribution, segmentation and override code run under node --test.
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

// Theme detection reads the page background to pick readability bounds.
globalThis.document ??= { body: {}, querySelector: () => null, querySelectorAll: () => [] };
globalThis.getComputedStyle ??= () => ({ backgroundColor: 'rgb(0, 0, 0)' });

const stApiUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(stApiStub)}`;
const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === './st-api.js') return { url: stApiUrl, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});

const stApi = await import(stApiUrl);
const { buildDialogueRegex, DIALOGUE_SKIP_GROUP } = await import('../src/color-blocks.js');
const { attributeDialogueSegments } = await import('../src/attribution.js');
const {
    MAX_PERSISTED_ATTRIBUTION_OVERRIDE_MESSAGES,
    MAX_ATTRIBUTION_RECONCILE_MESSAGES,
    MAX_ATTRIBUTION_RECONCILE_RECORDS,
    acceptAttributionReview,
    deleteMessageQuoteOverride,
    getMessageQuoteOverrideOptions,
    getMessageQuoteOverrideEntry,
    getMessageAttributionFreezeSegments,
    getMessageDomReadiness,
    getAttributionReviewAdapter,
    isMessageAttributionVerified,
    listAttributionReviews,
    markMessageAttributionVerified,
    matchSegmentsToElements,
    queueObservedMessageDecoration,
    reconcileMessageQuoteOverridesAfterDeletion,
    refreshDomDialogueCounts,
    renderMessageDomFallback,
    resolveDomSegmentIndexForElement,
    restoreMessageQuoteOverrideEntry,
    setMessageQuoteOverride,
    setStreamingAttributionOverride,
    snapshotChatMetadataScope,
    stopDomHealthCheck,
    upsertAttributionReview,
} = await import('../src/dom-engine.js');
const { ATTRIBUTION_REVIEW_STATUS, ATTRIBUTION_SOURCE, ATTRIBUTION_VERIFICATION_STATUS } = await import('../src/attribution-store.js');
const { characterColors, runtimeState, settings } = await import('../src/state.js');
const { normalizeSegmentText } = await import('../src/utils.js');
hooks.deregister();

// Copied from SillyTavern public/script.js (the quote replace inside
// messageFormatting). The extension's segmentation has to agree with it or
// segment indices stop lining up with the rendered <q> elements.
const SILLYTAVERN_QUOTE_RE = /<style>[\s\S]*?<\/style>|```[\s\S]*?```|~~~[\s\S]*?~~~|``[\s\S]*?``|`[\s\S]*?`|(".*?")|(\u201C.*?\u201D)|(\u00AB.*?\u00BB)|(\u300C.*?\u300D)|(\u300E.*?\u300F)|(\uFF02.*?\uFF02)/gim;

function renderSillyTavernQuotes(text) {
    const quotes = [];
    // Copied from the same place: with encode_tags off (the default) the host hides the double
    // quotes inside every HTML tag behind U+FFFE before the quote pass, then restores them, so
    // an attribute value never becomes a <q>.
    const masked = String(text).replace(/<([^>]+)>/g, (_, contents) => `<${contents.replaceAll('"', '\ufffe')}>`);
    masked.replace(SILLYTAVERN_QUOTE_RE, (match, ...groups) => {
        const captured = groups.slice(0, 6).find(value => value !== undefined);
        if (captured !== undefined) quotes.push(captured.replaceAll('\ufffe', '"'));
        return match;
    });
    return quotes;
}

function extractQuoteSegments(text, speaker = 'Bob') {
    return attributeDialogueSegments(text, speaker)
        .segments
        .filter(segment => segment.delimiter !== '*' && segment.delimiter !== '_');
}

// Minimal stand-ins for the DOM nodes resolveDomSegmentIndexForElement walks.
function createFakeElement(tagName, textContent, mesText) {
    const attributes = new Map();
    return {
        tagName,
        textContent,
        closest: selector => (selector === '.mes_text' ? mesText : null),
        matches: selector => selector === tagName.toLowerCase(),
        hasAttribute: name => attributes.has(name),
        getAttribute: name => (attributes.has(name) ? attributes.get(name) : null),
        setAttribute: (name, value) => attributes.set(name, String(value)),
    };
}

function createFakeMesText(quoteTexts) {
    const mesText = { elements: [] };
    mesText.elements = quoteTexts.map(text => createFakeElement('Q', text, mesText));
    mesText.querySelectorAll = selector => (selector === 'q' ? mesText.elements : []);
    return mesText;
}

function withCharacters(names, run) {
    const previousColors = { ...characterColors };
    const previousEngine = settings.coloringEngine;
    const previousSymbols = settings.thoughtSymbols;
    for (const key of Object.keys(characterColors)) delete characterColors[key];
    for (const name of names) {
        characterColors[name.toLowerCase()] = { name, color: '#112233', aliases: [] };
    }
    settings.coloringEngine = 'dom';
    settings.thoughtSymbols = '*';
    try {
        return run();
    } finally {
        for (const key of Object.keys(characterColors)) delete characterColors[key];
        Object.assign(characterColors, previousColors);
        settings.coloringEngine = previousEngine;
        settings.thoughtSymbols = previousSymbols;
    }
}

function withChat(messages, run) {
    const metadata = {};
    stApi.setTestContext({ chat: messages, chatMetadata: metadata });
    try {
        return run(metadata);
    } finally {
        stApi.setTestContext({ chat: [], chatMetadata: {} });
    }
}

function speakersFor(mesIndex, message) {
    return attributeDialogueSegments(message.mes, message.name, {
        autoAddMessageSpeaker: false,
        ...getMessageQuoteOverrideOptions(mesIndex, message),
        mesIndex,
    }).segments.map(segment => segment.assignment?.name || null);
}

function frozenSiblings(mesIndex, message, segmentIndex) {
    const frozen = {};
    for (const segment of attributeDialogueSegments(message.mes, message.name, {
        autoAddMessageSpeaker: false,
        ...getMessageQuoteOverrideOptions(mesIndex, message),
        mesIndex,
    }).segments) {
        if (segment.index === segmentIndex) continue;
        const name = segment.assignment?.name || segment.assignment?.key;
        if (name) frozen[String(segment.index)] = name;
    }
    return frozen;
}

test('an 81-character speaker survives override storage intact', () => {
    const longName = 'a'.repeat(81);
    withCharacters([longName, 'Bob'], () => {
        const message = { id: 'm-1', name: 'Bob', mes: '"Hello."' };
        withChat([message], metadata => {
            assert.equal(setMessageQuoteOverride(0, message, 0, longName), true);
            assert.equal(metadata.dialogue_colors_overrides['0'].segments['0'], longName,
                'the full accepted name must be stored, not a truncated copy');
            assert.equal(speakersFor(0, message)[0], longName,
                'the stored override must resolve back to the long-named character');
        });
    });
});

test('segmentation matches SillyTavern rendered quotes', () => {
    const cases = [
        '"This this"\n"Reply reply"',
        '"A"\n\n"B"',
        '*thinks* "A"\n"B"',
        '"He said **stop**"\n"B"',
        '\u00abBonjour\u00bb\n"Reply reply"',
        '\u300cKonnichiwa\u300d\n"Reply reply"',
        '\u300eShiro\u300f\n"B"',
        '\uff02Hi\uff02\n"B"',
        '\u201cHi\u201d\n"B"',
        '"This this\n"Reply reply"',
        'The 6" pipe.\n"This this"\n"Reply reply"',
        'Type `say "hi"` then "B"',
        '```\nsay "hi"\n```\n"B"',
        '"This this\nstill talking"\n\n"Reply reply"',
        '"" and "B"',
        '<style>q{color:"red"}</style>\n"B"',
        '<STYLE>q{color:"red"}</STYLE>\n"B"',
        '<div class="stat-block">"A"</div>\n"B"',
        '<img src="portrait.png" alt="Bob">\n"B"',
        '<font color="#aabbcc">"A"</font>\n"B"',
        '"A <span class="tag"> B"\n"C"',
        '<div\n  class="wrapped">"A"</div>',
        '"6" and <div class="x">"B"</div>',
    ];
    withCharacters(['Bob'], () => {
        for (const text of cases) {
            assert.deepEqual(
                extractQuoteSegments(text).map(segment => segment.text),
                renderSillyTavernQuotes(text),
                `segmentation diverged for ${JSON.stringify(text)}`,
            );
        }
    });
});

test('hidden HTML thoughts are excluded before segment numbering and counting', () => {
    withCharacters(['Alice', 'Bob'], () => {
        for (const hidden of [
            '<span data-hint="*thought*"></span>',
            '<span data-hint="*" data-other="`"></span>',
            '<!-- *thought* -->',
            '<script>"hidden"; *thought*</script>',
            '<style data-label="*thought*">*thought*</style>',
            '<textarea>*thought*</textarea>',
            '<pre><code>*thought*</code></pre>',
            '`<script>`',
            '```html\n<script> *thought*\n```',
            '<span data-hint="`"></span> `<script>`',
            '<script>const template = `hidden</script> `<script>`',
        ]) {
            const message = { id: 'hidden-thought', name: 'Alice', mes: `${hidden}\nBob: *thought*` };
            withChat([message], () => {
                const segments = attributeDialogueSegments(message.mes, message.name).segments;
                assert.equal(segments.length, 1, hidden);
                assert.equal(segments[0].index, 0);
                assert.equal(segments[0].text, '*thought*');
                assert.equal(segments[0].start, message.mes.lastIndexOf('*thought*'));
                assert.equal(segments[0].assignment?.name, 'Bob', hidden);
                refreshDomDialogueCounts([message]);
                assert.equal(characterColors.bob.dialogueCount, 1);
                assert.equal(characterColors.alice.dialogueCount || 0, 0);
                const mesText = { querySelector: () => null, querySelectorAll: selector => selector === 'em' ? [emphasis] : [] };
                const emphasis = createFakeElement('EM', 'thought', mesText);
                assert.equal(resolveDomSegmentIndexForElement(emphasis, 0, message), 0);
                const readiness = getMessageDomReadiness({ querySelector: () => mesText }, message, 0);
                assert.equal(readiness.totalSegments, 1);
                assert.equal(readiness.matchedSegments, 1);
                assert.equal(readiness.expectedDecorations, 1);
                assert.equal(readiness.ready, true);
            });
        }
        const visible = '<span title="*hidden*">Bob: *thought*</span> Bob: "Hello <b>there</b>."';
        assert.deepEqual(attributeDialogueSegments(visible, 'Alice').segments.map(segment => segment.text), [
            '*thought*', '"Hello <b>there</b>."',
        ]);
    });
});

test('manual and frozen overrides remain bound to their segmentation configuration through variants and deletion', () => {
    withCharacters(['Alice', 'Bob', 'Carol'], () => {
        const message = { id: 'configured', name: 'Bob', mes: '*Bob waits.* "Hello." "Goodbye."', swipe_id: 0 };
        const chat = [{ id: 'before', mes: 'Earlier.' }, message];
        withChat(chat, metadata => {
            assert.equal(setMessageQuoteOverride(1, message, 1, 'Alice', {
                freezeSegments: getMessageAttributionFreezeSegments(1, message, 1),
            }), true);
            const original = structuredClone(getMessageQuoteOverrideEntry(1, message));
            assert.deepEqual(speakersFor(1, message), ['Bob', 'Alice', 'Bob']);
            settings.thoughtSymbols = '';
            assert.equal(getMessageQuoteOverrideEntry(1, message), null);
            assert.equal(isMessageAttributionVerified(1, message), false);
            assert.deepEqual(speakersFor(1, message), ['Bob', 'Bob']);
            assert.equal(setMessageQuoteOverride(1, message, 1, 'Carol', {
                freezeSegments: getMessageAttributionFreezeSegments(1, message, 1),
            }), true);
            assert.deepEqual(speakersFor(1, message), ['Bob', 'Carol']);
            metadata.dialogue_colors_overrides = JSON.parse(JSON.stringify(metadata.dialogue_colors_overrides));
            settings.thoughtSymbols = '*';
            assert.deepEqual(speakersFor(1, message), ['Bob', 'Alice', 'Bob']);
            restoreMessageQuoteOverrideEntry(1, original);
            assert.deepEqual(speakersFor(1, message), ['Bob', 'Alice', 'Bob']);
            settings.thoughtSymbols = '';
            assert.deepEqual(speakersFor(1, message), ['Bob', 'Carol']);
            chat.shift();
            assert.equal(reconcileMessageQuoteOverridesAfterDeletion(chat), true);
            assert.deepEqual(speakersFor(0, message), ['Bob', 'Carol']);
            settings.thoughtSymbols = '*';
            assert.deepEqual(speakersFor(0, message), ['Bob', 'Alice', 'Bob']);
            assert.equal(Object.keys(metadata.dialogue_colors_overrides['0'].variants).length, 1);
        });
    });
});

test('pre-parser-key overrides cannot transfer a hidden thought correction onto visible text', () => {
    withCharacters(['Alice', 'Bob'], () => {
        const message = { id: 'old-parser', name: 'Alice', mes: '<span data-hint="*thought*"></span>\nBob: *thought*' };
        withChat([message], metadata => {
            setMessageQuoteOverride(0, message, 0, 'Alice');
            const legacy = metadata.dialogue_colors_overrides['0'];
            delete legacy.segmentationKey;
            const before = JSON.stringify(metadata);
            assert.equal(getMessageQuoteOverrideEntry(0, message), null);
            assert.equal(isMessageAttributionVerified(0, message), false);
            assert.deepEqual(speakersFor(0, message), ['Bob']);
            assert.equal(JSON.stringify(metadata), before, 'reading an incompatible record does not migrate its indices');
            delete legacy.messageId;
            delete legacy.messageFingerprint;
            assert.equal(getMessageQuoteOverrideEntry(0, message), null, 'hash-only migration cannot bypass parser identity');
            setMessageQuoteOverride(0, message, 0, 'Bob');
            assert.deepEqual(speakersFor(0, message), ['Bob']);
            assert.equal(Object.keys(metadata.dialogue_colors_overrides['0'].variants).length, 1,
                'an explicit new correction archives rather than retags the old record');
        });
    });
});

test('code spans and fences are skipped rather than segmented', () => {
    const regex = buildDialogueRegex();
    const matches = Array.from('Type `say "hi"` then "B"'.matchAll(regex));
    assert.equal(matches.filter(match => match.groups?.[DIALOGUE_SKIP_GROUP] !== undefined).length, 1);
    withCharacters(['Bob'], () => {
        assert.deepEqual(extractQuoteSegments('Type `say "hi"` then "B"').map(segment => segment.text), ['"B"']);
    });
});

test('every rendered quote resolves to a distinct segment index', () => {
    withCharacters(['Bob'], () => {
        for (const text of [
            '"This this"\n"Reply reply"',
            '\u00abBonjour\u00bb\n"Reply reply"',
            'The 6" pipe.\n"This this"\n"Reply reply"',
        ]) {
            const message = { id: `m-${text.length}`, name: 'Bob', mes: text };
            withChat([message], () => {
                const mesText = createFakeMesText(renderSillyTavernQuotes(text));
                const indices = mesText.elements
                    .map(element => resolveDomSegmentIndexForElement(element, 0, message))
                    .filter(Number.isFinite);
                assert.equal(indices.length, mesText.elements.length, `unresolved quote in ${JSON.stringify(text)}`);
                assert.equal(new Set(indices).size, indices.length, `duplicate segment index in ${JSON.stringify(text)}`);
            });
        }
    });
});

test('an unmappable quote refuses to resolve instead of guessing an index', () => {
    withCharacters(['Bob'], () => {
        const message = { id: 'm-1', name: 'Bob', mes: '"This this"\n"Reply reply"' };
        withChat([message], () => {
            const mesText = createFakeMesText(['"Something else entirely"']);
            mesText.elements[0].setAttribute('data-dc-seg', '0');
            assert.equal(Number.isNaN(resolveDomSegmentIndexForElement(mesText.elements[0], 0, message)), true);
        });
    });
});

test('a manual override does not re-attribute its neighbours', () => {
    const texts = [
        '"A" "B"',
        '"A"\n"B"',
        '"A"\n"B"\n"C"',
        '"A"\n"B"\n"C"\n"D"',
        '"A" "B"\n"C" "D"',
    ];
    withCharacters(['Bob', 'Alice'], () => {
        for (const text of texts) {
            const message = { id: `m-${text.length}`, name: 'Bob', mes: text };
            for (let pinned = 0; pinned < extractQuoteSegments(text).length; pinned++) {
                withChat([message], () => {
                    const before = speakersFor(0, message);
                    assert.equal(
                        setMessageQuoteOverride(0, message, pinned, 'Alice', {
                            source: ATTRIBUTION_SOURCE.MANUAL,
                            freezeSegments: frozenSiblings(0, message, pinned),
                        }),
                        true,
                    );
                    const after = speakersFor(0, message);
                    const expected = before.slice();
                    expected[pinned] = 'Alice';
                    assert.deepEqual(after, expected, `override on ${pinned} of ${JSON.stringify(text)} cascaded`);
                });
            }
        }
    });
});

test('frozen siblings are recorded separately and dropped with the last real override', () => {
    withCharacters(['Bob', 'Alice'], () => {
        const message = { id: 'm-1', name: 'Bob', mes: '"A"\n"B"\n"C"' };
        withChat([message], metadata => {
            setMessageQuoteOverride(0, message, 0, 'Alice', {
                source: ATTRIBUTION_SOURCE.MANUAL,
                freezeSegments: frozenSiblings(0, message, 0),
            });
            const entry = metadata.dialogue_colors_overrides['0'];
            assert.equal(entry.sources['0'], ATTRIBUTION_SOURCE.MANUAL);
            assert.equal(entry.sources['1'], ATTRIBUTION_SOURCE.FROZEN);
            assert.equal(entry.sources['2'], ATTRIBUTION_SOURCE.FROZEN);

            assert.equal(deleteMessageQuoteOverride(0, message, 0), true);
            assert.equal(metadata.dialogue_colors_overrides['0'], undefined);
            assert.deepEqual(speakersFor(0, message), ['Bob', 'Bob', 'Bob']);
        });
    });
});

test('clearing one of two manual overrides keeps the frozen snapshot', () => {
    withCharacters(['Bob', 'Alice', 'Carol'], () => {
        const message = { id: 'm-1', name: 'Bob', mes: '"A"\n"B"\n"C"\n"D"' };
        withChat([message], metadata => {
            setMessageQuoteOverride(0, message, 0, 'Alice', {
                source: ATTRIBUTION_SOURCE.MANUAL,
                freezeSegments: frozenSiblings(0, message, 0),
            });
            setMessageQuoteOverride(0, message, 2, 'Carol', { source: ATTRIBUTION_SOURCE.MANUAL });
            assert.equal(deleteMessageQuoteOverride(0, message, 0), true);
            const entry = metadata.dialogue_colors_overrides['0'];
            assert.equal(entry.segments['2'], 'Carol');
            assert.equal(entry.sources['1'], ATTRIBUTION_SOURCE.FROZEN);
            assert.equal(entry.sources['3'], ATTRIBUTION_SOURCE.FROZEN);
        });
    });
});

test('an existing verification-only entry still gets frozen siblings', () => {
    withCharacters(['Bob', 'Alice'], () => {
        const message = { id: 'm-1', name: 'Bob', mes: '"A"\n"B"\n"C"' };
        withChat([message], metadata => {
            assert.equal(markMessageAttributionVerified(0, message, ATTRIBUTION_VERIFICATION_STATUS.CLEAN), true);
            assert.deepEqual(metadata.dialogue_colors_overrides['0'].segments, {});
            assert.equal(setMessageQuoteOverride(0, message, 0, 'Alice', {
                source: ATTRIBUTION_SOURCE.MANUAL,
                freezeSegments: {},
            }), true);
            assert.equal(metadata.dialogue_colors_overrides['0'].sources['1'], ATTRIBUTION_SOURCE.FROZEN);
            assert.equal(metadata.dialogue_colors_overrides['0'].sources['2'], ATTRIBUTION_SOURCE.FROZEN);
        });
    });
});

test('reassigning after deleting the last override rebuilds the frozen snapshot', () => {
    withCharacters(['Bob', 'Alice'], () => {
        const message = { id: 'm-1', name: 'Bob', mes: '"A"\n"B"\n"C"' };
        withChat([message], metadata => {
            assert.equal(setMessageQuoteOverride(0, message, 0, 'Alice', { freezeSegments: {} }), true);
            assert.equal(deleteMessageQuoteOverride(0, message, 0), true);
            assert.equal(metadata.dialogue_colors_overrides['0'], undefined);
            assert.equal(setMessageQuoteOverride(0, message, 2, 'Alice', { freezeSegments: {} }), true);
            assert.equal(metadata.dialogue_colors_overrides['0'].sources['0'], ATTRIBUTION_SOURCE.FROZEN);
            assert.equal(metadata.dialogue_colors_overrides['0'].sources['1'], ATTRIBUTION_SOURCE.FROZEN);
        });
    });
});

test('an unresolved frozen sibling remains explicitly unassigned', () => {
    withCharacters(['Alice'], () => {
        const message = { id: 'm-1', name: '', mes: '"A" "B"' };
        withChat([message], metadata => {
            assert.deepEqual(speakersFor(0, message), [null, null]);
            assert.equal(setMessageQuoteOverride(0, message, 0, 'Alice', { freezeSegments: {} }), true);
            const entry = metadata.dialogue_colors_overrides['0'];
            assert.equal(Object.prototype.hasOwnProperty.call(entry.segments, '1'), true);
            assert.equal(entry.segments['1'], null);
            assert.equal(entry.sources['1'], ATTRIBUTION_SOURCE.FROZEN);
            assert.deepEqual(speakersFor(0, message), ['Alice', null]);
        });
    });
});

test('a frozen speaker removed from the registry stays unresolved', () => {
    withCharacters(['Alice', 'Bob'], () => {
        const message = { id: 'm-1', name: 'Alice', mes: '"A"\n"B"' };
        withChat([message], () => {
            assert.equal(setMessageQuoteOverride(0, message, 0, 'Bob', { source: ATTRIBUTION_SOURCE.FROZEN }), true);
            delete characterColors.bob;
            assert.deepEqual(speakersFor(0, message), [null, 'Alice']);
        });
    });
});

test('the frozen snapshot includes a streaming-visible sibling', () => {
    withCharacters(['Alice', 'Bob', 'Carol'], () => {
        const message = { id: 'm-1', name: 'Alice', mes: '"A"\n"B"' };
        withChat([message], metadata => {
            assert.equal(setStreamingAttributionOverride(0, message, 1, 'Bob'), true);
            assert.equal(setMessageQuoteOverride(0, message, 0, 'Carol', { freezeSegments: {} }), true);
            const entry = metadata.dialogue_colors_overrides['0'];
            assert.equal(entry.segments['1'], 'Bob');
            assert.equal(entry.sources['1'], ATTRIBUTION_SOURCE.FROZEN);
        });
    });
});

test('freezing never overwrites a real sibling and manual writes drop stale review evidence', () => {
    withCharacters(['Alice', 'Bob', 'Carol'], () => {
        const message = { id: 'm-1', name: 'Bob', mes: '"A"\n"B"' };
        withChat([message], metadata => {
            assert.equal(setMessageQuoteOverride(0, message, 1, 'Carol', {
                source: ATTRIBUTION_SOURCE.REVIEW,
                confidence: 0.9,
                reviewId: 'review-1',
                evidence: [{ type: 'review' }],
            }), true);
            assert.equal(setMessageQuoteOverride(0, message, 0, 'Alice', {
                source: ATTRIBUTION_SOURCE.MANUAL,
                freezeSegments: { 1: 'Bob' },
            }), true);
            let entry = metadata.dialogue_colors_overrides['0'];
            assert.equal(entry.segments['1'], 'Carol');
            assert.equal(entry.sources['1'], ATTRIBUTION_SOURCE.REVIEW);

            assert.equal(setMessageQuoteOverride(0, message, 1, 'Bob', { source: ATTRIBUTION_SOURCE.MANUAL }), true);
            entry = metadata.dialogue_colors_overrides['0'];
            assert.equal(entry.confidences?.['1'], undefined);
            assert.equal(entry.reviewIds?.['1'], undefined);
            assert.equal(entry.records?.['1'], undefined);
        });
    });
});

test('review acceptance uses the freeze-preserving persistent write', () => {
    withCharacters(['Alice', 'Bob'], () => {
        const message = { id: 'm-1', name: 'Bob', mes: '"A"\n"B"' };
        withChat([message], metadata => {
            const [segment] = attributeDialogueSegments(message.mes, message.name, { autoAddMessageSpeaker: false }).segments;
            const review = upsertAttributionReview({
                message,
                messageIndex: 0,
                segment,
                currentSpeaker: 'Bob',
                proposedSpeaker: 'Alice',
                source: ATTRIBUTION_SOURCE.LLM,
                confidence: 0.9,
            });
            assert.ok(review);
            assert.equal(acceptAttributionReview(review.id)?.status, 'accepted');
            const entry = metadata.dialogue_colors_overrides['0'];
            assert.equal(entry.segments['0'], 'Alice');
            assert.equal(entry.sources['0'], ATTRIBUTION_SOURCE.REVIEW);
            assert.equal(entry.segments['1'], 'Bob');
            assert.equal(entry.sources['1'], ATTRIBUTION_SOURCE.FROZEN);
            settings.thoughtSymbols = '';
            assert.equal(getMessageQuoteOverrideEntry(0, message), null, 'accepted reviews carry the same segmentation binding');
            settings.thoughtSymbols = '*';
            assert.equal(getMessageQuoteOverrideEntry(0, message).segments['0'], 'Alice');
        });
    });
});

test('identical messages keep independent pending reviews', () => {
    withCharacters(['Alice', 'Bob'], () => {
        const messages = [
            { id: 'm-a', name: 'Bob', mes: '"Same."' },
            { id: 'm-b', name: 'Bob', mes: '"Same."' },
        ];
        withChat(messages, metadata => {
            const reviews = messages.map((message, messageIndex) => {
                const [segment] = attributeDialogueSegments(message.mes, message.name, { autoAddMessageSpeaker: false }).segments;
                return upsertAttributionReview({
                    message,
                    messageIndex,
                    segment,
                    currentSpeaker: 'Bob',
                    proposedSpeaker: 'Alice',
                    source: ATTRIBUTION_SOURCE.LLM,
                    confidence: 0.9,
                });
            });
            assert.ok(reviews[0] && reviews[1]);
            assert.notEqual(reviews[0].id, reviews[1].id, 'identical text in two messages must not share a review id');
            assert.equal(listAttributionReviews({ status: ATTRIBUTION_REVIEW_STATUS.PENDING }).length, 2);
            assert.equal(acceptAttributionReview(reviews[0].id)?.status, ATTRIBUTION_REVIEW_STATUS.ACCEPTED);
            const remaining = listAttributionReviews({ status: ATTRIBUTION_REVIEW_STATUS.PENDING });
            assert.equal(remaining.length, 1, 'accepting one review must leave the other pending');
            assert.equal(remaining[0].id, reviews[1].id);
        });
    });
});

test('reviews for different swipes of one message stay independent', () => {
    withCharacters(['Alice', 'Bob'], () => {
        const message = { id: 'm-1', swipe_id: 0, name: 'Bob', mes: '"Same."' };
        withChat([message], metadata => {
            const [segment] = attributeDialogueSegments(message.mes, message.name, { autoAddMessageSpeaker: false }).segments;
            const first = upsertAttributionReview({
                message, messageIndex: 0, segment,
                currentSpeaker: 'Bob', proposedSpeaker: 'Alice',
                source: ATTRIBUTION_SOURCE.LLM, confidence: 0.9,
            });
            message.swipe_id = 1;
            const second = upsertAttributionReview({
                message, messageIndex: 0, segment,
                currentSpeaker: 'Bob', proposedSpeaker: 'Alice',
                source: ATTRIBUTION_SOURCE.LLM, confidence: 0.9,
            });
            assert.ok(first && second);
            assert.notEqual(first.id, second.id, 'each swipe is its own review target');
            assert.equal(listAttributionReviews({ status: ATTRIBUTION_REVIEW_STATUS.PENDING }).length, 2);
        });
    });
});

test('accepting a review after a swipe change refuses the write', () => {
    withCharacters(['Alice', 'Bob'], () => {
        const message = { id: 'm-1', swipe_id: 0, name: 'Bob', mes: '"Same."' };
        withChat([message], metadata => {
            const [segment] = attributeDialogueSegments(message.mes, message.name, { autoAddMessageSpeaker: false }).segments;
            const review = upsertAttributionReview({
                message, messageIndex: 0, segment,
                currentSpeaker: 'Bob', proposedSpeaker: 'Alice',
                source: ATTRIBUTION_SOURCE.LLM, confidence: 0.9,
            });
            assert.ok(review);
            message.swipe_id = 1;
            assert.equal(acceptAttributionReview(review.id), null);
            assert.equal(metadata.dialogue_colors_overrides?.['0'], undefined, 'no override may be written for a different swipe');
        });
    });
});

test('accepting a review after thought delimiters reindex segments refuses the write', () => {
    withCharacters(['Alice', 'Bob'], () => {
        settings.thoughtSymbols = '';
        const message = { id: 'm-1', name: 'Bob', mes: '*thinks* "Hi."' };
        withChat([message], metadata => {
            const quote = attributeDialogueSegments(message.mes, message.name, { autoAddMessageSpeaker: false })
                .segments.find(segment => segment.delimiter !== '*' && segment.delimiter !== '_');
            const review = upsertAttributionReview({
                message, messageIndex: 0, segment: quote,
                currentSpeaker: 'Bob', proposedSpeaker: 'Alice',
                source: ATTRIBUTION_SOURCE.LLM, confidence: 0.9,
            });
            assert.ok(review);
            settings.thoughtSymbols = '*';
            assert.equal(acceptAttributionReview(review.id), null);
            assert.equal(metadata.dialogue_colors_overrides?.['0'], undefined, 'no override may land on the reindexed thought');
        });
    });
});

test('review acceptance rejects changed context, missing boundaries, removed swipe and non-dialogue messages', () => {
    const changes = [
        (message, metadata, preceding) => { preceding.mes = 'Edited context.'; },
        (message, metadata) => { delete metadata.dialogue_colors_attribution_reviews.pending[0].segmentStart; },
        (message, metadata) => { delete metadata.dialogue_colors_attribution_reviews.pending[0].contextFingerprint; },
        message => { delete message.swipe_id; },
        message => { message.is_user = true; },
        message => { message.extra = { tool_invocations: [] }; },
    ];
    withCharacters(['Alice', 'Bob'], () => {
        for (const change of changes) {
            const preceding = { id: 'prior', name: 'Bob', mes: 'Earlier context.' };
            const message = { id: 'reviewed', name: 'Bob', mes: '"Same"', swipe_id: 0 };
            withChat([preceding, message], metadata => {
                const segment = attributeDialogueSegments(message.mes, message.name).segments[0];
                const review = upsertAttributionReview({ message, messageIndex: 1, segment, proposedSpeaker: 'Alice' });
                change(message, metadata, preceding);
                assert.equal(acceptAttributionReview(review.id), null);
                assert.equal(metadata.dialogue_colors_overrides, undefined);
            });
        }
    });
});

test('ID-less reviews cannot collide with an identical replacement after deletion', () => {
    withCharacters(['Alice', 'Bob'], () => {
        const message = { name: 'Bob', mes: '"Same"' };
        withChat([message], metadata => {
            const segment = attributeDialogueSegments(message.mes, message.name).segments[0];
            const first = upsertAttributionReview({ message, messageIndex: 0, segment, proposedSpeaker: 'Alice' });
            assert.equal(acceptAttributionReview(first.id)?.status, 'accepted');
            delete metadata.dialogue_colors_overrides;
            const replacement = { ...message };
            stApi.setTestContext({ chat: [replacement], chatMetadata: metadata });
            acceptAttributionReview(first.id);
            assert.equal(metadata.dialogue_colors_overrides, undefined, 'an old decision cannot mark the replacement clean');
            const second = upsertAttributionReview({ message: replacement, messageIndex: 0, segment, proposedSpeaker: 'Alice' });
            assert.notEqual(second.id, first.id);
            assert.equal(second.status, 'pending');
            assert.equal(acceptAttributionReview(second.id)?.status, 'accepted');
        });
    });
});

test('a retained review adapter cannot write into a replacement chat', () => {
    withCharacters(['Alice', 'Bob'], () => {
        const message = { id: 'reviewed', name: 'Bob', mes: '"Same"' };
        withChat([message], metadata => {
            const segment = attributeDialogueSegments(message.mes, message.name).segments[0];
            const review = upsertAttributionReview({ message, messageIndex: 0, segment, proposedSpeaker: 'Alice' });
            const adapter = getAttributionReviewAdapter();
            const replacementMetadata = structuredClone(metadata);
            stApi.setTestContext({ chat: [{ ...message }], chatMetadata: replacementMetadata });
            assert.equal(adapter.accept(review.id), null);
            assert.equal(replacementMetadata.dialogue_colors_overrides, undefined);
        });
    });
});

test('reconciliation leaves data byte-identical when any scan budget is exceeded', () => {
    withChat([], metadata => {
        const entry = { hash: 'saved', messageId: 'missing', segments: { 0: 'Alice' } };
        const maps = [
            { 0: { ...entry, segments: Object.fromEntries(Array.from({ length: 513 }, (_, index) => [index, 'Alice'])) } },
            Object.fromEntries(Array.from({ length: MAX_PERSISTED_ATTRIBUTION_OVERRIDE_MESSAGES + 1 }, (_, index) => [index, { ...entry, messageId: String(index) }])),
            { 0: { ...entry, variants: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [index, { ...entry, messageId: String(index) }])) } },
            Object.fromEntries(Array.from({ length: Math.ceil(MAX_ATTRIBUTION_RECONCILE_RECORDS / 65) }, (_, index) => [index, {
                ...entry, variants: Object.fromEntries(Array.from({ length: 64 }, (_, variant) => [variant, { ...entry, messageId: `${index}-${variant}` }])),
            }])),
        ];
        for (const map of maps) {
            metadata.dialogue_colors_overrides = map;
            const before = JSON.stringify(metadata);
            assert.equal(reconcileMessageQuoteOverridesAfterDeletion([]), false);
            assert.equal(JSON.stringify(metadata), before);
        }
        metadata.dialogue_colors_overrides = { 0: entry };
        const before = JSON.stringify(metadata);
        assert.equal(reconcileMessageQuoteOverridesAfterDeletion(new Array(MAX_ATTRIBUTION_RECONCILE_MESSAGES + 1)), false);
        assert.equal(JSON.stringify(metadata), before);
    });
});

test('message deletion reconciliation follows stable message identity', () => {
    withCharacters(['Alice', 'Bob'], () => {
        const messages = [
            { id: 'a', name: 'Bob', mes: '"A"' },
            { id: 'b', name: 'Bob', mes: '"B"' },
            { id: 'c', name: 'Bob', mes: '"C"' },
        ];
        withChat(messages, metadata => {
            messages.forEach((message, index) => setMessageQuoteOverride(index, message, 0, 'Alice'));
            stApi.setTestContext({ chat: [messages[0], messages[2]], chatMetadata: metadata });
            assert.equal(reconcileMessageQuoteOverridesAfterDeletion(), true);
            assert.deepEqual(Object.keys(metadata.dialogue_colors_overrides), ['0', '1']);
            assert.equal(metadata.dialogue_colors_overrides['0'].messageId, 'a');
            assert.equal(metadata.dialogue_colors_overrides['1'].messageId, 'c');
        });
    });
});

test('message deletion uniquely reconciles a legacy hash-only override', () => {
    withCharacters(['Alice', 'Bob'], () => {
        const messages = [
            { id: 'a', name: 'Bob', mes: '"A"' },
            { id: 'b', name: 'Bob', mes: '"B"' },
        ];
        withChat(messages, metadata => {
            assert.equal(setMessageQuoteOverride(1, messages[1], 0, 'Alice'), true);
            const legacy = metadata.dialogue_colors_overrides['1'];
            delete legacy.messageId;
            delete legacy.messageFingerprint;
            delete legacy.textLength;

            stApi.setTestContext({ chat: [messages[1]], chatMetadata: metadata });
            assert.equal(reconcileMessageQuoteOverridesAfterDeletion(), true);
            assert.deepEqual(metadata.dialogue_colors_overrides['0'], legacy);
            assert.equal(metadata.dialogue_colors_overrides['0'].segments['0'], 'Alice');
        });
    });
});

test('swipes at one message index retain independent overrides', () => {
    withCharacters(['Alice', 'Bob', 'Carol'], () => {
        const message = { id: 'm-1', swipe_id: 0, name: 'Bob', mes: 'Alice said "First."' };
        withChat([message], metadata => {
            assert.equal(setMessageQuoteOverride(0, message, 0, 'Alice'), true);
            message.swipe_id = 1;
            message.mes = 'Carol said "Second."';
            assert.equal(setMessageQuoteOverride(0, message, 0, 'Carol'), true);
            assert.equal(metadata.dialogue_colors_overrides['0'].segments['0'], 'Carol');
            assert.equal(Object.keys(metadata.dialogue_colors_overrides['0'].variants).length, 1);

            message.swipe_id = 0;
            message.mes = 'Alice said "First."';
            assert.equal(getMessageQuoteOverrideOptions(0, message).overrides['0'], 'Alice');
            message.swipe_id = 1;
            message.mes = 'Carol said "Second."';
            assert.equal(getMessageQuoteOverrideOptions(0, message).overrides['0'], 'Carol');
        });
    });
});

test('deletion moves unique records while preserving an ambiguous record inert', () => {
    withCharacters(['Alice', 'Bob'], () => {
        const duplicate = () => ({ name: 'Bob', mes: '"Same"' });
        const unique = { id: 'unique', name: 'Bob', mes: '"Unique"' };
        const oldChat = [{ id: 'deleted', name: 'Bob', mes: 'gone' }, duplicate(), duplicate(), unique];
        withChat(oldChat, metadata => {
            assert.equal(setMessageQuoteOverride(2, oldChat[2], 0, 'Alice'), true);
            assert.equal(setMessageQuoteOverride(3, unique, 0, 'Alice'), true);
            const currentChat = [duplicate(), duplicate(), unique];
            stApi.setTestContext({ chat: currentChat, chatMetadata: metadata });

            assert.equal(reconcileMessageQuoteOverridesAfterDeletion(), true);
            const active = metadata.dialogue_colors_overrides['2'];
            assert.equal(active.messageId, 'unique');
            assert.equal(active.segments['0'], 'Alice');
            assert.equal(Object.keys(active.variants).length, 1);
        });
    });
});

test('activation reconciliation repairs a deletion that happened while disabled', () => {
    withCharacters(['Alice', 'Bob'], () => {
        const messages = [
            { id: 'a', name: 'Bob', mes: '"A"' },
            { id: 'b', name: 'Bob', mes: '"B"' },
        ];
        withChat(messages, metadata => {
            assert.equal(setMessageQuoteOverride(1, messages[1], 0, 'Alice'), true);
            stApi.setTestContext({ chat: [messages[1]], chatMetadata: metadata });
            assert.equal(reconcileMessageQuoteOverridesAfterDeletion(undefined, { deletion: false }), true);
            assert.equal(metadata.dialogue_colors_overrides['0'].messageId, 'b');
        });
    });
});

test('override snapshots stop before an over-cap raw entry', () => {
    const overrides = {};
    for (let index = 0; index < MAX_PERSISTED_ATTRIBUTION_OVERRIDE_MESSAGES; index++) {
        overrides[String(index)] = { hash: String(index), segments: {} };
    }
    Object.defineProperty(overrides, 'overflow', {
        enumerable: true,
        get() { throw new Error('raw override cap was crossed'); },
    });
    assert.doesNotThrow(() => snapshotChatMetadataScope({ dialogue_colors_overrides: overrides }));
});

test('read-only segment mapping does not register an unknown message speaker', () => {
    withCharacters([], () => {
        const message = { id: 'm-1', name: 'Unseen Speaker', mes: '"Hello"' };
        withChat([message], () => {
            const mesText = createFakeMesText(['"Hello"']);
            assert.equal(resolveDomSegmentIndexForElement(mesText.elements[0], 0, message), 0);
            assert.equal(characterColors['unseen speaker'], undefined);
        });
    });
});

test('fallback rendering escapes markup when host formatting is unavailable or fails', () => {
    const originalDocument = globalThis.document;
    const payload = '<img src=x onerror="globalThis.pwned=true">';
    const message = { id: 'm-1', name: 'Bob', mes: payload };
    const mesText = {
        innerHTML: '',
        querySelectorAll: () => [],
    };
    const mesElement = {
        isConnected: true,
        getAttribute: name => name === 'mesid' ? '0' : null,
        querySelector: selector => selector === '.mes_text' ? mesText : null,
    };
    const chatRoot = {};
    globalThis.document = {
        body: {},
        getElementById: id => id === 'chat' ? chatRoot : null,
        querySelector: selector => selector.includes('.mes[mesid="0"]') ? mesElement : null,
        querySelectorAll: () => [],
    };
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        for (const messageFormatting of [undefined, () => '', () => { throw new Error('formatter failed'); }]) {
            mesText.innerHTML = '';
            stApi.setTestContext({ chat: [message], chatMetadata: {}, messageFormatting });
            assert.equal(renderMessageDomFallback(0, message), true);
            assert.doesNotMatch(mesText.innerHTML, /<img\b/i);
            assert.match(mesText.innerHTML, /&lt;img/);
        }
    } finally {
        console.warn = originalWarn;
        globalThis.document = originalDocument;
        stApi.setTestContext({ chat: [], chatMetadata: {} });
    }
});

test('observer work rejects detached elements and teardown clears settle work', () => {
    const detached = { isConnected: false };
    const pendingBefore = runtimeState.pendingObservedMessages.size;
    queueObservedMessageDecoration(detached);
    assert.equal(runtimeState.pendingObservedMessages.size, pendingBefore);

    let settleDisconnected = false;
    let chatDisconnected = false;
    const settleTimer = setTimeout(() => {}, 60000);
    const retryTimer = setTimeout(() => {}, 60000);
    runtimeState.messageSettleObservers.set({}, {
        observer: { disconnect() { settleDisconnected = true; } },
        fallbackTimer: settleTimer,
        retryTimers: [retryTimer],
    });
    runtimeState.pendingObservedMessages.add({ isConnected: false });
    runtimeState.chatObserver = { disconnect() { chatDisconnected = true; } };
    runtimeState.chatObserverTimer = setTimeout(() => {}, 60000);
    stopDomHealthCheck();
    assert.equal(settleDisconnected, true);
    assert.equal(chatDisconnected, true);
    assert.equal(runtimeState.messageSettleObservers.size, 0);
    assert.equal(runtimeState.pendingObservedMessages.size, 0);
    assert.equal(runtimeState.chatObserverTimer, null);
});

test('matchSegmentsToElements never hands two elements the same segment', () => {
    const mesText = createFakeMesText(['"A"', '"A"', '"B"']);
    const segments = [
        { index: 0, text: '"A"', delimiter: '"' },
        { index: 1, text: '"A"', delimiter: '"' },
        { index: 2, text: '"B"', delimiter: '"' },
    ];
    const pairs = [];
    matchSegmentsToElements(segments, mesText.elements, seg => normalizeSegmentText(seg.text), (seg, el) => {
        pairs.push([seg.index, mesText.elements.indexOf(el)]);
    });
    assert.deepEqual(pairs, [[0, 0], [1, 1], [2, 2]]);
});
