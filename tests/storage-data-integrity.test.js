import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const values = new Map();
const deviceStorage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    clear() { values.clear(); },
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: deviceStorage });

const stApiStub = `
export const converter = { makeHtml: value => String(value) };
export const power_user = { quote_text_color: '#888888', encode_tags: false, personas: {} };
export const escapeHtml = value => String(value);
export const escapeRegex = value => String(value).replace(/[/\\-\\\\^$*+?.()|[\\]{}]/g, '\\\\$&');
export const extension_settings = {};
let context = {};
export const getContext = () => context;
export const setTestContext = value => { context = value; };
export const eventSource = { on() {}, emit() {} };
export const event_types = {};
export const setExtensionPrompt = () => {};
export const saveSettings = async () => globalThis.__dcSaveSettings?.();
export const saveSettingsDebounced = () => {};
export const saveCharacterDebounced = () => {};
export const getCharacters = async () => globalThis.__dcGetCharacters?.();
export const extension_prompt_types = {};
export const extension_prompt_roles = {};
export const generateQuietPrompt = async () => '';
export const registerMacro = () => {};
export const getRequestHeaders = () => ({});
export const saveMetadata = async () => {};
export const saveMetadataDebounced = () => {};
export const promptManager = null;
`;

globalThis.document ??= {};
const fakeElement = {
    style: {},
    dataset: {},
    children: [],
    firstElementChild: null,
    addEventListener() {},
    removeEventListener() {},
    append() {},
    appendChild() {},
    replaceChildren() {},
    insertBefore() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    contains: () => false,
    closest: () => null,
    focus() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { add() {}, remove() {}, toggle() {} },
};
Object.assign(globalThis.document, {
    body: { ...fakeElement, children: [], ownerDocument: globalThis.document },
    hidden: false,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: id => id === 'dc-char-list' ? fakeElement : null,
    addEventListener() {},
    removeEventListener() {},
    createElement: tag => tag === 'template' ? {
        content: { firstElementChild: { ...fakeElement, remove() {}, nextElementSibling: null } },
        innerHTML: '',
    } : ({
        click() {},
        style: {},
        dataset: {},
        append() {},
        appendChild() {},
        addEventListener() {},
        removeEventListener() {},
        classList: { add() {}, remove() {}, toggle() {} },
    }),
});
globalThis.getComputedStyle ??= () => ({ backgroundColor: 'rgb(0, 0, 0)' });
globalThis.toastr ??= { success() {}, error() {}, warning() {}, info() {} };
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1024, innerHeight: 768 };
globalThis.requestAnimationFrame ??= callback => { callback(); return 1; };
globalThis.cancelAnimationFrame ??= () => {};

const stApiUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(stApiStub)}`;
const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === './st-api.js') return { url: stApiUrl, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});
const stApi = await import(stApiUrl);
const storage = await import('../src/storage.js');
const history = await import('../src/history.js');
const state = await import('../src/state.js');
hooks.deregister();

const { COLOR_SCHEMA_VERSION, MODULE_NAME, settings } = state;

globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ settings: JSON.stringify({ extension_settings: stApi.extension_settings }) }),
});

function character(name, color, extra = {}) {
    return {
        name,
        color,
        baseColor: color,
        aliases: [],
        dialogueCount: 0,
        group: '',
        style: '',
        font: '',
        gradient: null,
        gradientGenerator: null,
        locked: false,
        keep: false,
        ...extra,
    };
}

function context(avatar = 'card.png', extra = {}) {
    return {
        chat: [],
        chatMetadata: {},
        chatId: 'chat-1',
        characterId: 0,
        characters: [{ name: 'Card', avatar, data: { extensions: {} } }],
        ...extra,
    };
}

function reset(activeContext = context()) {
    values.clear();
    delete stApi.extension_settings[MODULE_NAME];
    stApi.setTestContext(activeContext);
    state.setCharacterColors({});
    state.setGroupProfiles({});
    state.setColorHistory([]);
    state.setHistoryIndex(-1);
    settings.colorStorageScope = 'card';
    settings.colorTheme = 'pastel';
    settings.persistPersonaColor = false;
    settings.keepPersonaCharacter = false;
    settings.keepCardCharacter = false;
    settings.disableToasts = true;
    storage.loadData({ persistPrevious: false, persistMigrations: false, allowMetadataPersistence: false });
}

async function waitForLegacyMigrationMarker(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (values.get(storage.LEGACY_LOCAL_STORAGE_MIGRATION_KEY) === 'true') return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('legacy migration marker was not committed after a verified save');
}

test('legacy migration completion is device-local and waits for complete enumeration', async () => {
    reset();
    values.set('dc_global', JSON.stringify({
        colors: { Alice: character('Alice', '#112233') },
        settings: { colorSchemaVersion: COLOR_SCHEMA_VERSION },
    }));
    stApi.extension_settings[MODULE_NAME] = {
        version: COLOR_SCHEMA_VERSION,
        colorData: {},
        legacyLocalStorageMigrated: true,
    };
    stApi.extension_settings.regex = null;

    const first = storage.migrateLegacyLocalStorageIfNeeded();
    assert.equal(first.ok, true);
    assert.equal(first.migrated, true, 'a synced legacy flag must not suppress this device');
    assert.equal(storage.getAutoSyncRecord(true).colorData.dc_global.colors.alice.name, 'Alice');
    assert.equal(values.has(storage.LEGACY_LOCAL_STORAGE_MIGRATION_KEY), false,
        'the marker must wait for a verified save');
    await waitForLegacyMigrationMarker();
    assert.equal(storage.migrateLegacyLocalStorageIfNeeded().migrated, false);

    values.delete(storage.LEGACY_LOCAL_STORAGE_MIGRATION_KEY);
    const key = deviceStorage.key;
    deviceStorage.key = () => { throw new Error('blocked'); };
    const failed = storage.migrateLegacyLocalStorageIfNeeded();
    deviceStorage.key = key;
    assert.equal(failed.error, 'legacy_storage_enumeration_failed');
    assert.equal(values.has(storage.LEGACY_LOCAL_STORAGE_MIGRATION_KEY), false);
});

test('an interrupted legacy migration is retried instead of suppressed', async () => {
    reset();
    values.set('dc_global', JSON.stringify({
        colors: { Alice: character('Alice', '#112233') },
        settings: { colorSchemaVersion: COLOR_SCHEMA_VERSION },
    }));
    stApi.extension_settings.regex = null;

    const fetchRestore = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    try {
        const first = storage.migrateLegacyLocalStorageIfNeeded();
        assert.equal(first.migrated, true);
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(values.has(storage.LEGACY_LOCAL_STORAGE_MIGRATION_KEY), false,
            'an unverified save must not mark the migration complete');
    } finally {
        globalThis.fetch = fetchRestore;
    }

    delete stApi.extension_settings[MODULE_NAME];
    const second = storage.migrateLegacyLocalStorageIfNeeded();
    assert.equal(second.migrated, true, 'an unsaved migration must run again on restart');
    assert.equal(storage.getAutoSyncRecord(true).colorData.dc_global.colors.alice.name, 'Alice');
    await waitForLegacyMigrationMarker();
});

test('future schemas fail closed without rewriting records or import sources', async () => {
    reset();
    const future = { version: COLOR_SCHEMA_VERSION + 1, colorData: { untouched: { future: true } } };
    stApi.extension_settings[MODULE_NAME] = future;
    const before = JSON.stringify(future);

    assert.throws(() => storage.getAutoSyncRecord(true), error => error?.code === 'unsupported_schema_version');
    assert.equal(storage.applyAutoSyncRecord(future), 'unsupported_schema_version');
    assert.equal(storage.loadData().error, 'unsupported_schema_version');
    assert.equal(JSON.stringify(stApi.extension_settings[MODULE_NAME]), before);

    delete stApi.extension_settings[MODULE_NAME];
    storage.loadData({ persistPrevious: false, persistMigrations: false, allowMetadataPersistence: false });
    for (const analyze of [storage.analyzeColorImport, storage.analyzeSettingsImport]) {
        const source = analyze === storage.analyzeColorImport
            ? { version: COLOR_SCHEMA_VERSION + 1, colors: {} }
            : { version: COLOR_SCHEMA_VERSION + 1, settings: { themeMode: 'dark' } };
        const result = await analyze(JSON.stringify(source));
        assert.equal(result.error, 'unsupported_schema_version');
    }
    assert.equal(storage.analyzeCardData({ version: COLOR_SCHEMA_VERSION + 1, colors: {} }).error, 'unsupported_schema_version');
});

test('reviewed imports reject normalized source and destination changes before mutation', async () => {
    reset();
    state.setCharacterColors({ current: character('Current', '#112233') });
    storage.saveData({ immediate: false });

    const changedSource = await storage.analyzeColorImport(JSON.stringify({
        version: COLOR_SCHEMA_VERSION,
        colors: { incoming: character('Incoming', '#445566') },
    }));
    changedSource.payload.colors.incoming.baseColor = '#abcdef';
    const sourceResult = await storage.applyColorImport(changedSource.payload, { mode: 'replace', applyScope: false });
    assert.equal(sourceResult.error, 'context_changed');
    assert.deepEqual(Object.keys(state.characterColors), ['current']);

    const changedDestination = await storage.analyzeColorImport(JSON.stringify({
        version: COLOR_SCHEMA_VERSION,
        colors: { incoming: character('Incoming', '#445566') },
    }));
    state.characterColors.current.baseColor = '#778899';
    const destinationResult = await storage.applyColorImport(changedDestination.payload, { mode: 'merge', applyScope: false });
    assert.equal(destinationResult.error, 'context_changed');
    assert.equal(state.characterColors.incoming, undefined);
    assert.equal(state.characterColors.current.baseColor, '#778899');
});

test('replace restores Keep pins immediately and history removes stale forward rename pins', async () => {
    reset();
    settings.colorStorageScope = 'chat';
    storage.loadData({ persistPrevious: false, persistMigrations: false, allowMetadataPersistence: false });
    state.setCharacterColors({ old: character('Old', '#112233', { keep: true }) });
    storage.saveData({ immediate: false });

    const analysis = await storage.analyzeColorImport(JSON.stringify({
        version: COLOR_SCHEMA_VERSION,
        colors: { incoming: character('Incoming', '#445566') },
    }));
    const replaced = await storage.applyColorImport(analysis.payload, { mode: 'replace', applyScope: false });
    assert.equal(replaced.ok, true, replaced.message);
    assert.equal(state.characterColors.old.keep, true);

    state.setColorHistory([history.createHistorySnapshot()]);
    state.setHistoryIndex(0);
    state.characterColors.next = { ...state.characterColors.old, name: 'Next' };
    delete state.characterColors.old;
    storage.removePinnedCharacterKey('old');
    history.saveHistory();
    storage.saveData({ immediate: false });
    assert.ok(storage.getPinnedCharacters().next);
    assert.equal(storage.getPinnedCharacters().old, undefined);

    history.undo();
    assert.ok(storage.getPinnedCharacters().old);
    assert.equal(storage.getPinnedCharacters().next, undefined);
    history.redo();
    assert.ok(storage.getPinnedCharacters().next);
    assert.equal(storage.getPinnedCharacters().old, undefined);
});

test('custom palette references must resolve and portable exports carry their palette', async () => {
    reset();
    const missing = await storage.analyzeSettingsImport(JSON.stringify({
        version: COLOR_SCHEMA_VERSION,
        settings: { colorTheme: 'custom:Missing' },
    }));
    assert.equal(missing.error, 'missing_custom_palette');

    const selfContained = await storage.analyzeSettingsImport(JSON.stringify({
        version: COLOR_SCHEMA_VERSION,
        settings: { colorTheme: 'custom:Ocean' },
        customPalettes: { Ocean: ['#112233', '#445566'] },
        customPaletteMeta: { Ocean: { notes: 'portable' } },
    }));
    assert.equal(selfContained.ok, true, selfContained.message);
    const applied = await storage.applySettingsImport(selfContained.payload, { mode: 'merge', applyScope: false });
    assert.equal(applied.ok, true, applied.message);
    assert.equal(settings.colorTheme, 'custom:Ocean');
    assert.deepEqual(storage.getAutoSyncRecord(true).customPalettes.Ocean, ['#112233', '#445566']);

    let exportedBlob;
    const createObjectURL = URL.createObjectURL;
    const revokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = blob => { exportedBlob = blob; return 'blob:test'; };
    URL.revokeObjectURL = () => {};
    try {
        storage.exportSettings();
        const exported = JSON.parse(await exportedBlob.text());
        assert.equal(exported.settings.colorTheme, 'custom:Ocean');
        assert.deepEqual(exported.customPalettes.Ocean, ['#112233', '#445566']);
    } finally {
        URL.createObjectURL = createObjectURL;
        URL.revokeObjectURL = revokeObjectURL;
    }
});

test('card writes require an awaitable bound writer and verify settled data', async () => {
    const cardContext = context();
    reset(cardContext);
    state.setCharacterColors({ card: character('Card', '#123456') });
    const unavailable = await storage.saveToCard();
    assert.equal(unavailable.error, 'card_save_unavailable');
    assert.equal(cardContext.characters[0].data.extensions.dialogueColors, undefined);

    let settled = false;
    cardContext.writeExtensionField = async (characterId, key, value) => {
        await Promise.resolve();
        cardContext.characters[characterId].data.extensions[key] = value;
        settled = true;
    };
    globalThis.__dcGetCharacters = async () => {};
    const saved = await storage.saveToCard();
    assert.equal(saved.ok, true, saved.message);
    assert.equal(settled, true);
    assert.equal(cardContext.characters[0].data.extensions.dialogueColors.version, COLOR_SCHEMA_VERSION);
    delete globalThis.__dcGetCharacters;
});

test('archive fingerprints reject changed selected data without deleting it', async () => {
    reset();
    const key = 'dc_char_inactive';
    storage.setStoredColorData(key, { old: character('Old', '#112233') }, settings, { debounce: false });
    const fingerprint = storage.getStoredColorDataFingerprint(key);
    storage.getUserColorDataStore()[key].colors.old.baseColor = '#445566';

    const result = await storage.archiveStoredColorData([key], { [key]: fingerprint });
    assert.equal(result.error, 'context_changed');
    assert.ok(storage.getUserColorDataStore()[key]);
    assert.equal(storage.getArchivedColorData(), null);
});

test('successful replace keeps undo and redo across the import boundary', async () => {
    reset();
    state.setCharacterColors({ old: character('Old', '#112233') });
    storage.saveData({ immediate: false });
    history.saveHistory();

    const analysis = await storage.analyzeColorImport(JSON.stringify({
        version: COLOR_SCHEMA_VERSION,
        colors: { next: character('Next', '#445566') },
    }));
    const replaced = await storage.applyColorImport(analysis.payload, { mode: 'replace', applyScope: false });
    assert.equal(replaced.ok, true, replaced.message);
    assert.deepEqual(Object.keys(state.characterColors), ['next']);

    history.undo();
    assert.deepEqual(Object.keys(state.characterColors), ['old']);
    assert.equal(state.characterColors.old.name, 'Old');
    const restoredColor = state.characterColors.old.color;

    history.redo();
    assert.deepEqual(Object.keys(state.characterColors), ['next']);

    history.undo();
    assert.deepEqual(Object.keys(state.characterColors), ['old']);
    assert.equal(state.characterColors.old.color, restoredColor);
});

test('successful empty replace stays undoable', async () => {
    reset();
    state.setCharacterColors({ old: character('Old', '#112233') });
    storage.saveData({ immediate: false });
    history.saveHistory();

    const analysis = await storage.analyzeColorImport(JSON.stringify({
        version: COLOR_SCHEMA_VERSION,
        colors: {},
    }));
    const replaced = await storage.applyColorImport(analysis.payload, { mode: 'replace', applyScope: false });
    assert.equal(replaced.ok, true, replaced.message);
    assert.deepEqual(Object.keys(state.characterColors), []);

    history.undo();
    assert.deepEqual(Object.keys(state.characterColors), ['old']);
});

test('failed import recovery keeps a concurrently edited new character whole', async () => {
    reset();
    state.setCharacterColors({ old: character('Old', '#112233') });
    storage.saveData({ immediate: false });

    const analysis = await storage.analyzeColorImport(JSON.stringify({
        version: COLOR_SCHEMA_VERSION,
        colors: { aria: character('Aria', '#445566') },
    }));

    let releaseFetch;
    let fetchReached = false;
    let editedBase;
    let editedColor;
    const pendingFetch = new Promise(resolve => { releaseFetch = resolve; });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = () => {
        calls += 1;
        if (calls === 1) { fetchReached = true; return pendingFetch; }
        return originalFetch();
    };
    try {
        const importPromise = storage.applyColorImport(analysis.payload, { mode: 'replace', applyScope: false });
        const deadline = Date.now() + 3000;
        while (!fetchReached && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.equal(fetchReached, true, 'the import must reach its save before the edit');
        state.characterColors.aria.font = 'Noto Serif';
        storage.saveData({ immediate: false });
        const editedBaseValue = state.characterColors.aria.baseColor;
        const editedColorValue = state.characterColors.aria.color;
        editedBase = editedBaseValue;
        editedColor = editedColorValue;
        releaseFetch({ ok: false, status: 500, json: async () => ({}) });

        const result = await importPromise;
        assert.equal(result.ok, false);
        assert.equal(result.rollbackPersisted, true, result.message);
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.equal(state.characterColors.old?.name, 'Old', 'the previous table must be restored');
    assert.equal(state.characterColors.aria?.name, 'Aria', 'the edited import must keep its name');
    assert.equal(state.characterColors.aria?.baseColor, editedBase, 'the edited import must keep its color');
    assert.equal(state.characterColors.aria?.color, editedColor, 'the edited import must keep its display color');
    assert.equal(state.characterColors.aria?.font, 'Noto Serif', 'the concurrent edit must survive');
});

test('disablement survives a reload as device-local state', () => {
    reset();
    settings.enabled = true;
    storage.saveData({ immediate: false });

    settings.enabled = false;
    storage.saveData({ immediate: false });
    settings.enabled = true;
    storage.loadData({ persistPrevious: false, persistMigrations: false, allowMetadataPersistence: false });
    assert.equal(settings.enabled, false, 'the saved disabled state must be restored on reload');

    settings.enabled = true;
    storage.saveData({ immediate: false });
    settings.enabled = false;
    storage.loadData({ persistPrevious: false, persistMigrations: false, allowMetadataPersistence: false });
    assert.equal(settings.enabled, true, 're-enabling must also survive a reload');
});

test('a modern colour import without settings keeps its explicit base colours', async () => {
    reset();
    const analysis = await storage.analyzeColorImport(JSON.stringify({
        version: COLOR_SCHEMA_VERSION,
        colors: { hue: character('Hue', '#abcdef', { baseColor: '#112233' }) },
    }));
    const applied = await storage.applyColorImport(analysis.payload, { mode: 'replace', applyScope: false });
    assert.equal(applied.ok, true, applied.message);
    assert.equal(state.characterColors.hue?.baseColor, '#112233',
        'the explicitly supplied base colour must survive application');
});

test('narrator gradient seeds keep their separators through settings normalisation', () => {
    reset();
    settings.narratorStyle = {
        enabled: true,
        baseColor: '#888888',
        gradient: {
            type: 'linear',
            angle: 90,
            stops: [
                { position: 0, color: '#111111', baseColor: '#111111' },
                { position: 100, color: '#222222', baseColor: '#222222' },
            ],
        },
        gradientGenerator: { algorithm: 'dc-gradient-v1', seed: 'abcd1234\u001fNarrator\u001e2', iteration: 2 },
    };
    storage.saveData({ immediate: false });
    const first = storage.getAutoSyncRecord(true);
    assert.equal(first.settings?.narratorStyle?.gradientGenerator?.seed, 'abcd1234\u001fNarrator\u001e2',
        'the seed grammar separators must survive a save');

    settings.narratorStyle.gradientGenerator.seed = 'ab\u0000cd\u0009ef\u001fNarrator';
    storage.saveData({ immediate: false });
    const second = storage.getAutoSyncRecord(true);
    assert.equal(second.settings?.narratorStyle?.gradientGenerator?.seed, 'abcdef\u001fNarrator',
        'genuine control characters are still stripped while separators survive');
});

test('a failed local enabled write keeps the session choice even when reads still work', () => {
    reset();
    settings.enabled = true;
    storage.saveData({ immediate: false });
    const write = deviceStorage.setItem;
    deviceStorage.setItem = (key, value) => {
        if (key === 'dc_enabled_local_v1') throw new Error('quota exceeded');
        write(key, value);
    };
    try {
        settings.enabled = false;
        storage.saveData({ immediate: false });
        storage.loadData({ persistPrevious: false, persistMigrations: false });
        assert.equal(settings.enabled, false);
    } finally {
        deviceStorage.setItem = write;
        settings.enabled = true;
        storage.saveData({ immediate: false });
    }
});

test('a different verified save cannot complete an unsaved legacy migration', async () => {
    reset();
    values.set('dc_global', JSON.stringify({ colors: { alice: character('Alice', '#112233') } }));
    stApi.extension_settings.regex = null;
    storage.migrateLegacyLocalStorageIfNeeded();
    // Replace the queued migration before persistence starts, then verify unrelated data.
    stApi.extension_settings[MODULE_NAME] = storage.buildAutoSyncRecord({ version: COLOR_SCHEMA_VERSION });
    storage.queueImmediateSettingsSave();
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(values.has(storage.LEGACY_LOCAL_STORAGE_MIGRATION_KEY), false);
    assert.equal(storage.migrateLegacyLocalStorageIfNeeded().migrated, true);
    await waitForLegacyMigrationMarker();
});

test('redoing an un-Keep restores its cross-chat decision', () => {
    reset();
    settings.colorStorageScope = 'chat';
    storage.loadData({ persistPrevious: false, persistMigrations: false });
    state.setCharacterColors({ alice: character('Alice', '#112233', { keep: true }) });
    storage.saveData({ immediate: false });
    history.saveHistory();
    state.characterColors.alice.keep = false;
    history.saveHistory();
    storage.saveData({ immediate: false });
    history.undo();
    history.redo();
    assert.equal(storage.getPinnedCharacters().alice, undefined);
    assert.equal(storage.getUiState().unkeptCharacters['card_card.png'].alice, true);
});

test('a style-pack replacement remains undoable', async () => {
    reset();
    state.setCharacterColors({ old: character('Old', '#112233') });
    storage.saveData({ immediate: false });
    history.saveHistory();
    const review = await storage.analyzeStylePackImport({
        format: 'dialogue-colors-style-pack', formatVersion: 1,
        metadata: { name: 'Replace cast' },
        assignmentPresets: { Cast: [{ name: 'New', color: '#445566' }] },
    });
    const result = await storage.applyStylePackImport(review, { applyAssignments: true, assignmentApplyMode: 'replace' });
    assert.equal(result.ok, true, result.message);
    history.undo();
    assert.deepEqual(Object.keys(state.characterColors), ['old']);
    history.redo();
    assert.deepEqual(Object.keys(state.characterColors), ['new']);
});

test('scope-changing imports reject edits during source and destination saves', async () => {
    for (const editAt of ['source', 'destination-saved', 'destination-unsaved']) {
        const editDestination = editAt !== 'source';
        reset();
        state.setCharacterColors({ old: character('Old', '#112233') });
        storage.saveData({ immediate: false });
        const targetKey = storage.getStorageKeyForScope('chat');
        storage.setStoredColorData(targetKey, { target: character('Target', '#334455') }, settings, { debounce: false });
        const review = await storage.analyzeColorImport({
            version: COLOR_SCHEMA_VERSION,
            colors: { incoming: character('Incoming', '#445566') },
            settings: { colorStorageScope: 'chat' },
        });
        let edited = false;
        const fetchOriginal = globalThis.fetch;
        globalThis.fetch = async () => {
            const saved = JSON.stringify({ extension_settings: stApi.extension_settings });
            if (!edited && (settings.colorStorageScope === 'chat') === editDestination) {
                edited = true;
                if (editDestination) {
                    state.characterColors.target.font = 'Noto Serif';
                    if (editAt === 'destination-saved') storage.saveData({ immediate: false });
                } else {
                    storage.getUserColorDataStore()[targetKey].colors.target.font = 'Noto Serif';
                }
            }
            return { ok: true, json: async () => ({ settings: saved }) };
        };
        try {
            const result = await storage.applyColorImport(review.payload, { mode: 'replace', applyScope: true });
            assert.equal(edited, true);
            assert.equal(result.ok, false, 'an edit made during the scope switch must invalidate review');
            assert.equal(storage.getStoredColorData(targetKey).colors.target.font, 'Noto Serif');
            assert.equal(state.characterColors.incoming, undefined);
            if (settings.colorStorageScope === 'card') {
                assert.equal(state.characterColors.target, undefined, 'destination edits must not leak into the source table');
            }
        } finally {
            globalThis.fetch = fetchOriginal;
        }
    }
});

test('failed imports remove untouched new pin siblings but retain the concurrently edited pin', async () => {
    reset();
    const review = await storage.analyzeColorImport({
        version: COLOR_SCHEMA_VERSION,
        colors: {
            alice: character('Alice', '#112233', { keep: true }),
            bob: character('Bob', '#445566', { keep: true }),
        },
    });
    const originalFetch = globalThis.fetch;
    let edited = false;
    globalThis.fetch = async () => {
        if (!edited && state.characterColors.alice) {
            edited = true;
            state.characterColors.alice.font = 'Noto Serif';
            storage.saveData({ immediate: false });
            return { ok: false, status: 500 };
        }
        return originalFetch();
    };
    try {
        const result = await storage.applyColorImport(review.payload, { mode: 'replace' });
        assert.equal(result.ok, false);
        assert.equal(storage.getPinnedCharacters().bob, undefined);
        assert.equal(storage.getPinnedCharacters().alice.font, 'Noto Serif');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('an import records its undo state before a concurrent edit is added to history', async () => {
    reset();
    state.setCharacterColors({ old: character('Old', '#112233') });
    storage.saveData({ immediate: false });
    const review = await storage.analyzeColorImport({
        version: COLOR_SCHEMA_VERSION,
        colors: { incoming: character('Incoming', '#445566') },
    });
    const originalFetch = globalThis.fetch;
    let edited = false;
    let reads = 0;
    globalThis.fetch = async () => {
        const saved = JSON.stringify({ extension_settings: stApi.extension_settings });
        // The first read verifies the ordinary save queued by commit; the second
        // is the import transaction's own verification.
        if (++reads === 2 && state.characterColors.incoming) {
            edited = true;
            state.characterColors.incoming.font = 'Noto Serif';
            history.saveHistory();
            storage.saveData({ immediate: false });
        }
        return { ok: true, json: async () => ({ settings: saved }) };
    };
    try {
        const result = await storage.applyColorImport(review.payload, { mode: 'replace' });
        assert.equal(result.ok, true, result.message);
        assert.equal(edited, true);
        history.undo();
        assert.equal(state.characterColors.incoming?.font, '');
        history.undo();
        assert.deepEqual(Object.keys(state.characterColors), ['old']);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('legacy module disablement migrates before portable settings discard it', () => {
    reset();
    stApi.extension_settings[MODULE_NAME] = {
        version: COLOR_SCHEMA_VERSION,
        globalSettings: { enabled: false },
    };
    settings.enabled = true;
    storage.loadData({ persistPrevious: false, persistMigrations: false });
    assert.equal(settings.enabled, false);
    assert.equal(values.get('dc_enabled_local_v1'), 'false');
    assert.equal(storage.getAutoSyncRecord(true).globalSettings.enabled, undefined);
});

test('restored inactive persona aliases remain editable under their persona identity', () => {
    reset(context('card.png', { name1: 'Marisol', userAvatar: 'mari.png' }));
    settings.persistPersonaColor = true;
    state.setCharacterColors({ mari: character('Mari', '#112233', { aliases: ['Marisol'] }) });
    storage.saveData({ immediate: false });
    const pins = storage.captureHistoryPinState();
    assert.equal(pins.personas['avatar:mari.png'].persona, 'Marisol');
    stApi.setTestContext(context('card.png', {
        name1: 'Other', userAvatar: 'other.png', chat: [{ name: 'Marisol', is_user: true }],
    }));
    state.setCharacterColors({});
    storage.restorePinnedPersonaColor();
    const entry = Object.values(state.characterColors)[0];
    entry.font = 'Noto Serif';
    storage.syncPinnedPersonaColors();
    assert.equal(storage.getPinnedPersonaColors()['avatar:mari.png'].font, 'Noto Serif');
});

test('a failed chat-rename save retries the new binding instead of restoring the old filename', async () => {
    reset();
    settings.colorStorageScope = 'chat';
    storage.loadData({ persistPrevious: false, persistMigrations: false });
    state.setCharacterColors({ aria: character('Aria', '#112233') });
    storage.saveData({ immediate: false });
    const active = stApi.getContext();
    active.chatId = 'renamed';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    try {
        const result = await storage.migrateRenamedChatStorage({
            avatarId: 'card.png', oldFileName: 'chat-1.jsonl', newFileName: 'renamed.jsonl',
        });
        assert.equal(result.ok, false);
        assert.equal(result.error, 'chat_rename_persist_failed');
        assert.equal(storage.getStorageKey(), 'dc_chat_card_card.png_host_renamed');
        assert.equal(storage.getStoredColorData('dc_chat_card_card.png_host_chat-1'), null);
        assert.equal(state.characterColors.aria.baseColor, '#112233');
    } finally {
        globalThis.fetch = originalFetch;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    storage.loadData({ persistPrevious: false, persistMigrations: false });
    assert.equal(state.characterColors.aria.baseColor, '#112233');
});
