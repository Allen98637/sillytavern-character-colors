import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import test from 'node:test';
import {
    hasAttributionVerifierBallotQuorum,
    normalizeAttributionVerifyPasses,
    reduceAttributionVerifierBallots,
} from '../src/verify-consensus.js';

const source = await readFile(new URL('../src/verify.js', import.meta.url), 'utf8');
let moduleSequence = 0;

function deferred() {
    let resolve;
    const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
    return { promise, resolve };
}

async function waitFor(predicate) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw new Error('Timed out waiting for verifier request.');
}

async function loadVerifier(overrides = {}) {
    const importPattern = /^import\s+\{([^}]+)\}\s+from\s+['"][^'"]+['"];\s*$/gm;
    const names = new Set();
    for (const match of source.matchAll(importPattern)) {
        for (const rawName of match[1].split(',')) names.add(rawName.trim());
    }

    const request = deferred();
    const responseQueue = Array.isArray(overrides.responses) ? [...overrides.responses] : null;
    let requestStarted = false;
    let marked = 0;
    let cleared = 0;
    let provenanceMethod = 'message-speaker';
    const preceding = { id: 'm0', name: 'Alice', mes: 'Alice spoke first.', is_user: false, is_system: false, swipe_id: 0, extra: {} };
    const target = { id: 'm1', name: 'Bob', mes: '"Hello."', is_user: false, is_system: false, swipe_id: 0, extra: {} };
    const context = { chat: [preceding, target], chatMetadata: {}, name1: 'User', name2: 'Bob' };
    const settings = {
        enabled: true,
        coloringEngine: 'dom',
        attributionConnectionProfile: null,
        attributionConservativeOnly: false,
        attributionReviewPolicy: 'review',
        attributionMaxTokens: 4096,
        attributionVerifyPasses: 1,
        llmAttributionCheck: true,
        llmAttributionParallel: false,
        autoScanOnLoad: true,
    };
    const segment = () => ({
        index: 0,
        start: 0,
        end: 8,
        text: '"Hello."',
        delimiter: '"',
        assignment: { key: 'bob', name: 'Bob', color: '#112233' },
        confidence: 0.7,
        provenance: { source: 'message-speaker', method: provenanceMethod },
        evidence: [{ type: 'message-speaker' }],
    });
    const isHostSystemOrToolMessage = message => Array.isArray(message?.extra?.tool_invocations)
        || (message?.is_system === true && message?.extra?.type === 'generic');
    const key = `__dcAsyncVerifyStubs_${++moduleSequence}`;
    globalThis[key] = {
        ATTRIBUTION_SOURCE: { LLM: 'llm', FROZEN: 'frozen' },
        ATTRIBUTION_VERIFICATION_STATUS: { CLEAN: 'clean', PENDING_REVIEW: 'pending-review', AUTO_APPLIED: 'auto-applied' },
        isHostSystemOrToolMessage,
        normalizeAttributionConfidence: value => value,
        attributeDialogueSegments: () => ({ segments: [segment()] }),
        clearSpeakerRegexCache() {},
        ensureCharacterEntry: () => ({ created: false }),
        buildNameColorLookup: () => new Map([['bob', { key: 'bob', name: 'Bob', color: '#112233' }]]),
        collectFontColorsFromText: () => new Set(),
        parseNamedColorAssignmentsFromText: () => [],
        resolveCharacterKeyByNameOrAlias: name => String(name).toLowerCase() === 'bob' ? 'bob' : '',
        cancelMessageDomFollowupRepairs() {},
        clearMessageDomRepairTimer() {},
        clearStreamingAttributionOverrides() { cleared++; },
        decorateMessageDomFromCurrentRender: async () => false,
        decorateObservedMessages() {},
        getMessageAttributionFreezeSegments: () => [],
        getMessageQuoteOverrideEntry: () => null,
        getMessageQuoteOverrideOptions: () => ({}),
        isMessageAttributionVerified: () => false,
        markMessageAttributionVerified() { marked++; return true; },
        refreshAndDecorateMessageDom: async () => false,
        scheduleMessageDomFollowupRepair() {},
        setMessageQuoteOverride: () => false,
        setStreamingAttributionOverride: () => false,
        suspendMessageDomWorkForEdit: () => false,
        upsertAttributionReview: () => null,
        normalizeRegistryIdentity: value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : '',
        normalizeRegistryIdentityName(value, maximum = 120) {
            const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
            return name && name.length <= maximum && !/[<>{}]/.test(name) ? name : '';
        },
        callLLMWithProfile: async () => {
            requestStarted = true;
            if (responseQueue && responseQueue.length) return responseQueue.shift();
            return request.promise;
        },
        classifyLlmRequestError: () => ({ category: 'unknown', retryable: false, status: null }),
        hasAttributionVerifierBallotQuorum: valid => valid > 0,
        isSpeakerNamePresentInText: () => false,
        normalizeAttributionVerifyPasses: () => 1,
        reduceAttributionVerifierBallots: ballots => ballots[0] || [],
        commit() {},
        repaintDomAfterCharacterDataChange() {},
        formatPromptLiteralSymbol: value => String(value),
        getThoughtDelimiterSymbols: () => [],
        getContext: () => context,
        getMessageElementByIndex: () => null,
        hashMessageText: value => String(value),
        isCompositeSpeakerLabel: () => false,
        toast: { info() {}, warning() {}, error() {} },
        setVerifyAttributionButtonBusy() {},
        isDomEngine: () => true,
        settings,
        characterColors: { bob: { name: 'Bob', color: '#112233', aliases: [] } },
        attributionChatGeneration: 0,
        attributionVerificationEpoch: 0,
        streamingAttributionGeneration: 0,
        isStreamingGenerationActive: false,
        isVerifyingAttribution: false,
        pendingAttributionVerifications: [],
        pendingAutoAttributionVerifyIndices: new Map(),
        recentAutoAttributionVerifyAttempts: new Map(),
        autoAttributionVerifyTimer: null,
        autoAttributionVerifyTimerDue: 0,
        lastStreamingAttributionVerifyKey: '',
        streamingAttributionVerifyTimer: null,
        AUTO_ATTRIBUTION_VERIFY_DELAY_MS: 10,
        AUTO_ATTRIBUTION_VERIFY_RENDERED_LIMIT: 10,
        AUTO_ATTRIBUTION_VERIFY_RETRY_DELAY_MS: 10,
        AUTO_ATTRIBUTION_VERIFY_STABLE_RETRY_DELAY_MS: 10,
        MAX_PENDING_AUTO_ATTRIBUTION_VERIFICATIONS: 10,
        STREAMING_ATTRIBUTION_VERIFY_DELAY_MS: 10,
        setAttributionVerificationEpoch() {},
        setAutoAttributionVerifyTimer() {},
        setAutoAttributionVerifyTimerDue() {},
        setIsVerifyingAttribution() {},
        setLastStreamingAttributionVerifyKey() {},
        setStreamingAttributionGeneration() {},
        setStreamingAttributionVerifyTimer() {},
        filterPromptCharacterEntries: entries => entries,
        ...overrides,
    };
    const transformed = `const { ${[...names].join(', ')} } = globalThis[${JSON.stringify(key)}];\n${source.replace(importPattern, '')}`;
    try {
        const verify = await import(`data:text/javascript;base64,${Buffer.from(transformed).toString('base64')}#${moduleSequence}`);
        return {
            verify,
            context,
            preceding,
            target,
            request,
            requestStarted: () => requestStarted,
            marked: () => marked,
            cleared: () => cleared,
            changeProvenance: value => { provenanceMethod = value; },
        };
    } finally {
        delete globalThis[key];
    }
}

globalThis.document ??= { body: {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
globalThis.getComputedStyle ??= () => ({ backgroundColor: 'rgb(0, 0, 0)' });

test('attribution verifier uses the filtered known-speaker table', async () => {
    const fixture = await loadVerifier({
        characterColors: {
            active: { name: 'Active', color: '#123456', aliases: [] },
            retired: { name: 'Retired', color: '#654321', aliases: ['Old'] },
        },
        filterPromptCharacterEntries: entries => entries
            .filter(entry => entry.name !== 'Retired')
            .map(entry => entry.name === 'Active' ? { ...entry, aliases: [] } : entry),
    });
    const prompt = fixture.verify.buildAttributionVerifierPrompt(
        fixture.target,
        1,
        [{ index: 0, start: 0, end: 8, text: '"Hello."', delimiter: '"', assignment: { name: 'Active' } }],
        new Map([['retired', { key: 'retired', name: 'Retired', color: '#654321' }]]),
    );
    assert.match(prompt, /Active/);
    assert.doesNotMatch(prompt, /Retired|Old/);
});

test('verifier performs no post-await writes when submitted context or target provenance becomes stale', async () => {
    const mutations = [
        fixture => { fixture.preceding.mes = 'Edited context.'; },
        fixture => { fixture.target.name = 'Carol'; },
        fixture => { fixture.target.is_user = true; },
        fixture => { fixture.target.swipe_id = 1; },
        fixture => { fixture.changeProvenance('changed-provenance'); },
    ];

    for (const mutate of mutations) {
        const fixture = await loadVerifier();
        const run = fixture.verify.verifyAttributionsWithLLM(1);
        await waitFor(fixture.requestStarted);
        mutate(fixture);
        fixture.request.resolve('{"corrections":[]}');
        assert.deepEqual(await run, { checked: false, corrections: 0, createdCharacters: false });
        assert.equal(fixture.marked(), 0);
        assert.equal(fixture.cleared(), 0);
    }
});

test('an unchanged verifier target can be marked clean after the request', async () => {
    const fixture = await loadVerifier();
    const run = fixture.verify.verifyAttributionsWithLLM(1);
    await waitFor(fixture.requestStarted);
    fixture.request.resolve('{"corrections":[]}');
    assert.equal((await run).checked, true);
    assert.equal(fixture.marked(), 1);
});

test('verification applies every agreed correction instead of aborting on its own writes', async () => {
    let appliedOverrides = 0;
    const segmentAssignments = ['bob', 'bob'];
    const settings = {
        enabled: true,
        coloringEngine: 'dom',
        attributionConnectionProfile: null,
        attributionConservativeOnly: false,
        attributionReviewPolicy: 'legacy-auto',
        attributionMaxTokens: 4096,
        attributionVerifyPasses: 1,
        llmAttributionCheck: true,
        llmAttributionParallel: false,
        autoScanOnLoad: true,
    };
    const segments = () => [0, 1].map(index => ({
        index,
        start: index * 20,
        end: index * 20 + 8,
        text: `"Quote ${index}."`,
        delimiter: '"',
        assignment: { key: segmentAssignments[index], name: 'Bob', color: '#112233' },
        confidence: 0.7,
        provenance: { source: 'message-speaker', method: 'speech-tag' },
        evidence: [{ type: 'message-speaker' }],
    }));
    const fixture = await loadVerifier({
        settings,
        characterColors: {
            alice: { name: 'Alice', color: '#223344', aliases: [] },
            bob: { name: 'Bob', color: '#112233', aliases: [] },
        },
        resolveCharacterKeyByNameOrAlias: name => ({ alice: 'alice', bob: 'bob' })[String(name).toLowerCase()] || '',
        buildNameColorLookup: () => new Map([
            ['alice', { key: 'alice', name: 'Alice', color: '#223344' }],
            ['bob', { key: 'bob', name: 'Bob', color: '#112233' }],
        ]),
        attributeDialogueSegments: () => ({ segments: segments() }),
        setMessageQuoteOverride: (mesIndex, msg, index) => {
            appliedOverrides++;
            // Own writes change what a recomputation sees; the apply loop must
            // keep going instead of treating this as an external edit.
            segmentAssignments[index] = 'alice';
            return true;
        },
    });
    const run = fixture.verify.verifyAttributionsWithLLM(1);
    await waitFor(fixture.requestStarted);
    fixture.request.resolve(JSON.stringify({ corrections: [
        { index: 0, speaker: 'Alice', confidence: 0.95, reason: 'speech tag' },
        { index: 1, speaker: 'Alice', confidence: 0.9, reason: 'speech tag' },
    ] }));
    const result = await run;
    assert.equal(result.checked, true);
    assert.equal(result.corrections, 2);
    assert.equal(appliedOverrides, 2);
    assert.equal(fixture.marked(), 1);
});

test('verification drops results when request inputs change mid-flight', async () => {
    {
        // Alias moves: the answer's speaker mapping no longer matches the
        // submitted request, so nothing may be applied or marked.
        let appliedOverrides = 0;
        const aliasTable = { alice: 'alice', al: 'alice', carol: 'carol', bob: 'bob' };
        const fixture = await loadVerifier({
            settings: { ...settingsForPasses(1), attributionReviewPolicy: 'legacy-auto' },
            characterColors: {
                alice: { name: 'Alice', color: '#223344', aliases: ['Al'] },
                carol: { name: 'Carol', color: '#334455', aliases: [] },
                bob: { name: 'Bob', color: '#112233', aliases: [] },
            },
            resolveCharacterKeyByNameOrAlias: name => aliasTable[String(name).toLowerCase()] || '',
            buildNameColorLookup: () => new Map([
                ['alice', { key: 'alice', name: 'Alice', color: '#223344' }],
                ['carol', { key: 'carol', name: 'Carol', color: '#334455' }],
                ['bob', { key: 'bob', name: 'Bob', color: '#112233' }],
            ]),
            setMessageQuoteOverride: () => { appliedOverrides++; return true; },
        });
        const run = fixture.verify.verifyAttributionsWithLLM(1);
        await waitFor(fixture.requestStarted);
        aliasTable.al = 'carol';
        fixture.request.resolve(JSON.stringify({ corrections: [
            { index: 0, speaker: 'Al', confidence: 0.9, reason: 'speech tag' },
        ] }));
        assert.equal((await run).checked, false);
        assert.equal(appliedOverrides, 0);
        assert.equal(fixture.marked(), 0);
    }

    {
        // Thought delimiters changed: the request no longer describes the
        // current segmentation, so the result must not mark the message.
        const settings = { ...settingsForPasses(1) };
        const fixture = await loadVerifier({ settings });
        const run = fixture.verify.verifyAttributionsWithLLM(1);
        await waitFor(fixture.requestStarted);
        settings.thoughtSymbols = '~';
        fixture.request.resolve('{"corrections":[]}');
        assert.equal((await run).checked, false);
        assert.equal(fixture.marked(), 0);
    }

    {
        // Pass count changed: one completed request no longer satisfies the
        // requested consensus, so the message must stay unverified.
        const settings = { ...settingsForPasses(1) };
        const fixture = await loadVerifier({
            settings,
            normalizeAttributionVerifyPasses,
        });
        const run = fixture.verify.verifyAttributionsWithLLM(1);
        await waitFor(fixture.requestStarted);
        settings.attributionVerifyPasses = 3;
        fixture.request.resolve('{"corrections":[]}');
        assert.equal((await run).checked, false);
        assert.equal(fixture.marked(), 0);
    }
});

test('consensus treats aliases of one character as a single speaker', async () => {
    let appliedOverrides = 0;
    const fixture = await loadVerifier({
        responses: [
            JSON.stringify({ corrections: [{ index: 0, speaker: 'Alice', confidence: 0.9, reason: 'speech tag' }] }),
            JSON.stringify({ corrections: [{ index: 0, speaker: 'Al', confidence: 0.8, reason: 'speech tag' }] }),
            JSON.stringify({ corrections: [{ index: 0, speaker: 'Ally', confidence: 0.7, reason: 'speech tag' }] }),
        ],
        settings: { ...settingsForPasses(3) },
        characterColors: {
            alice: { name: 'Alice', color: '#223344', aliases: ['Al', 'Ally'] },
            bob: { name: 'Bob', color: '#112233', aliases: [] },
        },
        resolveCharacterKeyByNameOrAlias: name => ({ alice: 'alice', al: 'alice', ally: 'alice', bob: 'bob' })[String(name).toLowerCase()] || '',
        buildNameColorLookup: () => new Map([
            ['alice', { key: 'alice', name: 'Alice', color: '#223344' }],
            ['bob', { key: 'bob', name: 'Bob', color: '#112233' }],
        ]),
        hasAttributionVerifierBallotQuorum,
        normalizeAttributionVerifyPasses,
        reduceAttributionVerifierBallots,
        setMessageQuoteOverride: () => { appliedOverrides++; return true; },
    });
    const run = fixture.verify.verifyAttributionsWithLLM(1);
    await waitFor(fixture.requestStarted);
    const result = await run;
    assert.equal(result.checked, true);
    assert.equal(result.corrections, 1);
    assert.equal(appliedOverrides, 1);
    assert.equal(fixture.marked(), 1);
});

function settingsForPasses(passes) {
    return {
        enabled: true,
        coloringEngine: 'dom',
        attributionConnectionProfile: null,
        attributionConservativeOnly: false,
        attributionReviewPolicy: 'legacy-auto',
        attributionMaxTokens: 4096,
        attributionVerifyPasses: passes,
        llmAttributionCheck: true,
        llmAttributionParallel: false,
        autoScanOnLoad: true,
    };
}

test('real verifier modules reject every changed speaker mapping before writes, including empty ballots', async t => {
    const hostSource = `
        export const converter = { makeHtml: value => String(value) };
        export const power_user = { quote_text_color: '#888888', encode_tags: false, personas: {} };
        export const escapeHtml = value => String(value);
        export const escapeRegex = value => RegExp.escape(String(value));
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
        export const generateQuietPrompt = async () => { throw new Error('Unexpected host request'); };
        export const registerMacro = () => {};
        export const getRequestHeaders = () => ({});
        export const saveMetadata = () => {};
        export const saveMetadataDebounced = () => {};
        export const promptManager = null;
    `;
    const llmSource = `
        let reply;
        export const setReply = value => { reply = value; };
        export const callLLMWithProfile = (...args) => reply(...args);
        export const classifyLlmRequestError = () => ({});
        export const populateProfileDropdown = () => {};
    `;
    const hostUrl = `data:text/javascript,${encodeURIComponent(hostSource)}`;
    const llmUrl = `data:text/javascript,${encodeURIComponent(llmSource)}`;
    const hooks = registerHooks({
        resolve(specifier, context, nextResolve) {
            if (specifier === './st-api.js') return { url: hostUrl, shortCircuit: true };
            if (specifier === './llm.js') return { url: llmUrl, shortCircuit: true };
            return nextResolve(specifier, context);
        },
    });
    let verify, state, host, llm;
    try {
        verify = await import('../src/verify.js');
        state = await import('../src/state.js');
        host = await import(hostUrl);
        llm = await import(llmUrl);
    } finally {
        hooks.deregister();
    }
    const previousSettings = { ...state.settings };
    const previousCharacters = { ...state.characterColors };
    const reset = () => {
        Object.assign(state.settings, settingsForPasses(1), { thoughtSymbols: '*' });
        for (const key of Object.keys(state.characterColors)) delete state.characterColors[key];
        Object.assign(state.characterColors, {
            alice: { name: 'Alice', color: '#223344', aliases: ['Al'] },
            bob: { name: 'Bob', color: '#112233', aliases: [] },
            carol: { name: 'Carol', color: '#334455', aliases: [] },
        });
        const message = { id: 'real-message', swipe_id: 0, name: 'Bob', mes: 'Bob said "One." Bob said "Two."' };
        const context = { chat: [message], chatMetadata: {} };
        host.setTestContext(context);
        return context;
    };
    const changes = {
        'unmentioned alias move': () => { state.characterColors.alice.aliases = []; state.characterColors.carol.aliases = ['Al']; },
        'new alias': () => { state.characterColors.carol.aliases = ['Caz']; },
        'unmentioned canonical rename': () => { state.characterColors.alice.name = 'Alicia'; },
        'registry addition': () => { state.characterColors.dana = { name: 'Dana', color: '#445566', aliases: [] }; },
    };
    try {
        for (const [name, change] of Object.entries(changes)) {
            await t.test(name, async () => {
                const context = reset();
                const response = deferred();
                let started = false;
                llm.setReply(() => { started = true; return response.promise; });
                const run = verify.verifyAttributionsWithLLM(0);
                await waitFor(() => started);
                change();
                const registry = structuredClone(state.characterColors);
                response.resolve('{"corrections":[]}');
                assert.equal((await run).checked, false);
                assert.deepEqual(context.chatMetadata, {}, 'no override, review or verified marker may be written');
                assert.deepEqual({ ...state.characterColors }, registry);
            });
        }
        await t.test('unchanged key-priority alias collisions and multiple self writes', async () => {
            const context = reset();
            state.characterColors.alice.aliases.push('Bob');
            state.settings.attributionVerifyPasses = 3;
            let passes = 0;
            llm.setReply(async () => {
                const speaker = ['Alice', 'Al', 'AL'][passes++];
                return JSON.stringify({ corrections: [0, 1].map(index => ({ index, speaker, confidence: 0.95, reason: 'Explicit speaker correction.' })) });
            });
            const result = await verify.verifyAttributionsWithLLM(0);
            assert.equal(passes, 3);
            assert.equal(result.corrections, 2);
            assert.equal(result.checked, true);
            assert.deepEqual(context.chatMetadata.dialogue_colors_overrides['0'].segments, { 0: 'Alice', 1: 'Alice' });
            assert.equal(context.chatMetadata.dialogue_colors_overrides['0'].verificationStatus, 'auto-applied');
        });
    } finally {
        Object.assign(state.settings, previousSettings);
        for (const key of Object.keys(state.characterColors)) delete state.characterColors[key];
        Object.assign(state.characterColors, previousCharacters);
        host.setTestContext({ chat: [], chatMetadata: {} });
    }
});
