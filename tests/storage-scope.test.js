import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// Every src module reaches SillyTavern through st-api.js, which imports paths that only resolve
// inside a SillyTavern install. Stubbing that one module lets the real save/load cycle run under
// node --test, against a live extension_settings record rather than a source-text assertion.
const stApiStub = `
export const converter = { makeHtml: value => String(value) };
export const power_user = { quote_text_color: '#888888', encode_tags: false, personas: {} };
export const escapeHtml = value => String(value);
export const escapeRegex = value => String(value).replace(/[/\\-\\\\^$*+?.()|[\\]{}]/g, '\\\\$&');
export const extension_settings = {};
let context = {};
export const getContext = () => context;
export const setTestContext = value => { context = value; };
const handlers = new Map();
export const eventSource = {
    on(type, callback) {
        if (!handlers.has(type)) handlers.set(type, []);
        handlers.get(type).push(callback);
    },
    async emit(type, ...args) {
        for (const callback of handlers.get(type) || []) await callback(...args);
    },
};
export const event_types = { CHAT_CHANGED: 'chat_changed', CHAT_RENAMED: 'chat_renamed' };
export const setExtensionPrompt = () => {};
export const saveSettings = async () => {};
export const saveSettingsDebounced = () => {};
export const saveCharacterDebounced = () => {};
export const getCharacters = () => [];
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
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
    createElement: tag => tag === 'template' ? {
        content: { firstElementChild: { ...fakeElement, remove() {}, nextElementSibling: null } },
        innerHTML: '',
    } : ({ ...fakeElement, click() {} }),
});
globalThis.getComputedStyle ??= () => ({ backgroundColor: 'rgb(0, 0, 0)' });
globalThis.toastr ??= { success() {}, error() {}, warning() {}, info() {} };
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1024, innerHeight: 768 };
globalThis.requestAnimationFrame ??= callback => { callback(); return 1; };
globalThis.cancelAnimationFrame ??= () => {};
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.MutationObserver ??= class { observe() {} disconnect() {} };
window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
document.createTreeWalker ??= () => ({ nextNode: () => null });

const stApiUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(stApiStub)}`;
const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === './st-api.js') return { url: stApiUrl, shortCircuit: true };
        return nextResolve(specifier, context);
    },
});
const stApi = await import(stApiUrl);
const storage = await import('../src/storage.js');
const state = await import('../src/state.js');
const main = await import('../src/main.js');
const { settings, MODULE_NAME } = state;
hooks.deregister();

// The host round-trips extension_settings through its own server, and the immediate-persist
// path verifies what it wrote by reading it back. Mirror that so a scope switch can confirm.
globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ settings: JSON.stringify({ extension_settings: stApi.extension_settings }) }),
});

function hostContext(chatId, avatar = 'bob.png') {
    return {
        chat: [],
        chatMetadata: {},
        chatId,
        characterId: 0,
        characters: [{ avatar, name: 'Bob' }],
        groupId: null,
        saveMetadata: async () => {},
    };
}

test('host reload-before-rename events preserve edits across rename-back without merging branches', async () => {
    main.registerEventHandlers();
    settings.enabled = true;
    settings.autoScanOnLoad = false;
    settings.themeMode = 'dark';
    settings.keepCardCharacter = false;
    main.syncAutomaticRuntime();
    await new Promise(resolve => setImmediate(resolve));
    try {
        for (const groupId of [null, 'group-rename']) {
            delete stApi.extension_settings[MODULE_NAME];
            state.setCharacterColors({});
            settings.colorStorageScope = 'chat';
            const initial = { ...hostContext('Original name'), groupId };
            stApi.setTestContext(initial);
            storage.loadData({ persistPrevious: false });
            state.setCharacterColors({ aria: characterEntry('Aria', '#ff0000') });
            storage.saveData();
            const owner = groupId ? `group_${groupId}` : 'card_bob.png';
            const hostKey = name => `dc_chat_${owner}_host_${storage.sanitizeStorageKeyComponent(name)}`;

            const rename = async (oldName, newName, afterReload = () => {}) => {
                const current = stApi.getContext();
                stApi.setTestContext({ ...current, chat: [], chatMetadata: { ...current.chatMetadata }, chatId: newName });
                await stApi.eventSource.emit(stApi.event_types.CHAT_CHANGED);
                afterReload();
                await stApi.eventSource.emit(stApi.event_types.CHAT_RENAMED, {
                    avatarId: 'bob.png', groupId,
                    oldFileName: `${oldName}.jsonl`, newFileName: `${newName}.jsonl`,
                });
            };
            await rename('Original name', 'Temporary name');
            assert.equal(state.characterColors.aria?.baseColor, '#ff0000');
            state.characterColors.aria.baseColor = '#00ff00';
            state.characterColors.aria.color = '#00ff00';
            storage.saveData();
            // Reload before renaming back, so the latest edit is stored at a meta key.
            stApi.setTestContext({ ...stApi.getContext(), chat: [], chatMetadata: { ...stApi.getContext().chatMetadata } });
            await stApi.eventSource.emit(stApi.event_types.CHAT_CHANGED);
            storage.saveData();
            storage.setStoredColorData(hostKey('Original name'), { aria: characterEntry('Aria', '#ff0000') }, settings, { debounce: false });
            await rename('Temporary name', 'Original name', () => { state.characterColors.aria.font = 'Noto Serif'; });
            assert.equal(state.characterColors.aria.baseColor, '#00ff00', 'rename-back must retain the newer colour');
            assert.equal(state.characterColors.aria.font, 'Noto Serif', 'edits made after reload must survive the rename event');
            assert.equal(storage.getStoredColorData(hostKey('Temporary name')), null, 'old host aliases must be retired');

            const source = { ...stApi.getContext(), chat: [], chatMetadata: { ...stApi.getContext().chatMetadata } };
            const branch = { ...source, chat: [], chatId: 'Branch', chatMetadata: { ...source.chatMetadata, main_chat: 'Original name' } };
            state.characterColors.aria.font = 'Noto Sans';
            stApi.setTestContext(branch);
            await stApi.eventSource.emit(stApi.event_types.CHAT_CHANGED);
            assert.equal(state.characterColors.aria.baseColor, '#00ff00');
            assert.equal(state.characterColors.aria.font, 'Noto Sans', 'copying must include unsaved source edits');
            state.characterColors.aria.baseColor = '#0000ff';
            storage.saveData();
            stApi.setTestContext(source);
            await stApi.eventSource.emit(stApi.event_types.CHAT_CHANGED);
            assert.equal(state.characterColors.aria.baseColor, '#00ff00', 'a real branch must remain independent');

            state.characterColors.aria.font = 'Lato';
            source.chatId = 'Without reload';
            await stApi.eventSource.emit(stApi.event_types.CHAT_RENAMED, {
                avatarId: 'bob.png', groupId, oldFileName: 'Original name.jsonl', newFileName: 'Without reload.jsonl',
            });
            assert.equal(state.characterColors.aria.font, 'Lato', 'a rename without a reload must retain unsaved source edits');
            assert.equal(storage.getStoredColorData(hostKey('Original name')), null);
        }
    } finally {
        settings.enabled = false;
        main.syncAutomaticRuntime();
        settings.enabled = true;
        state.setCharacterColors({});
        delete stApi.extension_settings[MODULE_NAME];
        stApi.setTestContext({});
        settings.colorStorageScope = 'card';
    }
});

test('a cross-owner chat import and its branch keep independent non-Kept colours', () => {
    try {
        for (const groupId of [null, 'imported-group']) {
            delete stApi.extension_settings[MODULE_NAME];
            settings.colorStorageScope = 'chat';
            state.setCharacterColors({});
            const source = hostContext('Exported chat', 'source.png');
            stApi.setTestContext(source);
            storage.loadData({ persistPrevious: false });
            state.setCharacterColors({ source: characterEntry('Source', '#112233') });
            storage.saveData();
            const sourceMetadata = structuredClone(source.chatMetadata);
            const sourceId = `meta_${sourceMetadata[storage.CHAT_SCOPE_METADATA_KEY]}`;
            const sourceFallback = storage.getUiState().chatScopeFallbacks[sourceId];

            const imported = { ...hostContext('Imported chat', 'destination.png'), groupId, chatMetadata: structuredClone(sourceMetadata) };
            stApi.setTestContext(imported);
            storage.loadData();
            assert.equal(state.characterColors.source, undefined, 'the foreign table is not an alias for this owner');
            state.setCharacterColors({ local: characterEntry('Local', '#445566') });
            storage.saveData();
            const importedMetadata = structuredClone(imported.chatMetadata);
            stApi.setTestContext({ ...imported, chat: [], chatMetadata: structuredClone(importedMetadata) });
            storage.loadData();
            const branch = {
                ...imported, chat: [], chatId: 'Imported branch',
                chatMetadata: { ...structuredClone(importedMetadata), main_chat: 'Imported chat' },
            };
            stApi.setTestContext(branch);
            storage.loadData();
            assert.equal(state.characterColors.local.baseColor, '#445566');
            assert.equal(state.characterColors.local.keep, false);
            state.characterColors.local.baseColor = '#778899';
            storage.saveData();
            const branchMetadata = structuredClone(branch.chatMetadata);

            stApi.setTestContext({ ...imported, chat: [], chatMetadata: structuredClone(importedMetadata) });
            storage.loadData();
            assert.equal(state.characterColors.local.baseColor, '#445566', 'editing the branch must not change the imported original');
            stApi.setTestContext({ ...branch, chat: [], chatMetadata: branchMetadata });
            storage.loadData();
            assert.equal(state.characterColors.local.baseColor, '#778899', 'the branch retains its own edit on reload');
            stApi.setTestContext({ ...source, chat: [], chatMetadata: sourceMetadata });
            storage.loadData();
            assert.equal(state.characterColors.source.baseColor, '#112233');
            assert.equal(storage.getUiState().chatScopeFallbacks[sourceId], sourceFallback, 'import must not replace the source owner mapping');
        }
    } finally {
        state.setCharacterColors({});
        delete stApi.extension_settings[MODULE_NAME];
        stApi.setTestContext({});
        settings.colorStorageScope = 'card';
    }
});

test('re-enabling after disabled navigation preserves the click through every activation load', async () => {
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const previousGetElement = document.getElementById;
    const values = new Map();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
    } });
    const checkbox = { ...fakeElement, checked: true };
    document.getElementById = id => id === 'dc-enabled' ? checkbox : null;
    main.registerEventHandlers();
    delete stApi.extension_settings[MODULE_NAME];
    stApi.setTestContext(hostContext('Before disable', 'before.png'));
    settings.colorStorageScope = 'card';
    settings.enabled = true;
    settings.autoScanOnLoad = false;
    settings.themeMode = 'dark';
    try {
        main.syncAutomaticRuntime();
        await new Promise(resolve => setImmediate(resolve));
        storage.saveData({ immediate: false });
        checkbox.checked = false;
        settings.enabled = false;
        main.syncAutomaticRuntime();
        storage.saveData({ immediate: false });
        assert.equal(values.get('dc_enabled_local_v1'), 'false');

        storage.setStoredColorData('dc_char_after.png', { next: characterEntry('Next', '#445566') }, settings, { debounce: false });
        stApi.setTestContext(hostContext('After disable', 'after.png'));
        await stApi.eventSource.emit(stApi.event_types.CHAT_CHANGED);
        assert.equal(settings.enabled, false);

        // Match the checkbox handler: set the choice, synchronise runtime, then save.
        checkbox.checked = true;
        settings.enabled = true;
        assert.equal(main.syncAutomaticRuntime(), true);
        assert.equal(settings.enabled, true, 'activation must not restore the older persisted false value');
        assert.equal(checkbox.checked, true, 'the UI must reflect the explicit enable');
        assert.equal(state.characterColors.next.baseColor, '#445566', 'activation must still load the new context');
        storage.saveData({ immediate: false });
        assert.equal(values.get('dc_enabled_local_v1'), 'true');
        storage.loadData({ persistPrevious: false, persistMigrations: false });
        assert.equal(settings.enabled, true, 'a later reload must retain the enable');
    } finally {
        settings.enabled = false;
        main.syncAutomaticRuntime();
        if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
        else delete globalThis.localStorage;
        document.getElementById = previousGetElement;
        settings.enabled = true;
        state.setCharacterColors({});
        delete stApi.extension_settings[MODULE_NAME];
        stApi.setTestContext({});
        settings.colorStorageScope = 'card';
    }
});

test('renaming an inactive chat while disabled moves only the event owner and persists its aliases', async () => {
    main.registerEventHandlers();
    delete stApi.extension_settings[MODULE_NAME];
    settings.enabled = false;
    settings.colorStorageScope = 'chat';
    state.setCharacterColors({});
    stApi.setTestContext(hostContext('Same name', 'unrelated.png'));
    storage.loadData({ persistPrevious: false, persistMigrations: false });
    state.setCharacterColors({ current: characterEntry('Current', '#123456') });
    const actualOldKey = `dc_chat_card_bob.png_host_${storage.sanitizeStorageKeyComponent('Same name')}`;
    const newKey = `dc_chat_card_bob.png_host_${storage.sanitizeStorageKeyComponent('Renamed chat')}`;
    const metaKey = 'dc_chat_card_bob.png_meta_inactive-chat';
    const record = storage.getAutoSyncRecord(true);
    record.ui.chatScopeFallbacks['meta_inactive-chat'] = actualOldKey;
    record.colorData[metaKey] = {
        colors: { aria: characterEntry('Aria', '#ff0000') },
        settings: { colorSchemaVersion: state.COLOR_SCHEMA_VERSION }, groupProfiles: {},
    };
    try {
        await stApi.eventSource.emit(stApi.event_types.CHAT_RENAMED, {
            avatarId: 'bob.png', oldFileName: 'Same name.jsonl', newFileName: 'Renamed chat.jsonl',
        });
        assert.deepEqual(Object.keys(state.characterColors), ['current']);
        assert.equal(storage.getStoredColorData(metaKey), null);
        assert.equal(storage.getStoredColorData(newKey).colors.aria.baseColor, '#ff0000');
        assert.equal(storage.getUiState().chatScopeFallbacks['meta_inactive-chat'], newKey);
        stApi.setTestContext({ ...hostContext('Renamed chat'), chatMetadata: { [storage.CHAT_SCOPE_METADATA_KEY]: 'inactive-chat' } });
        storage.loadData({ persistPrevious: false, persistMigrations: false });
        assert.equal(state.characterColors.aria.baseColor, '#ff0000');
        assert.equal(stApi.getContext().chatMetadata[storage.CHAT_SCOPE_METADATA_KEY], 'inactive-chat');
    } finally {
        settings.enabled = true;
        state.setCharacterColors({});
        delete stApi.extension_settings[MODULE_NAME];
        stApi.setTestContext({});
        settings.colorStorageScope = 'card';
    }
});

test('renaming while per-card storage is active updates the pending per-chat fallback', async () => {
    main.registerEventHandlers();
    delete stApi.extension_settings[MODULE_NAME];
    settings.colorStorageScope = 'chat';
    const context = hostContext('Before');
    stApi.setTestContext(context);
    state.setCharacterColors({});
    storage.loadData({ persistPrevious: false });
    state.setCharacterColors({ aria: characterEntry('Aria', '#ff0000') });
    storage.saveData();
    try {
        assert.equal((await storage.switchColorStorageScope('card')).ok, true);
        context.chatId = 'After';
        await stApi.eventSource.emit(stApi.event_types.CHAT_RENAMED, {
            avatarId: 'bob.png', oldFileName: 'Before.jsonl', newFileName: 'After.jsonl',
        });
        assert.equal(settings.colorStorageScope, 'card');
        assert.equal((await storage.switchColorStorageScope('chat')).ok, true);
        assert.equal(state.characterColors.aria.baseColor, '#ff0000');
        assert.equal(storage.getStorageKey(), 'dc_chat_card_bob.png_host_After');
        assert.equal(storage.getStoredColorData('dc_chat_card_bob.png_host_Before'), null);
    } finally {
        state.setCharacterColors({});
        delete stApi.extension_settings[MODULE_NAME];
        stApi.setTestContext({});
        settings.colorStorageScope = 'card';
    }
});

function withFreshStore(chatId, run) {
    delete stApi.extension_settings[MODULE_NAME];
    stApi.setTestContext(hostContext(chatId));
    settings.colorStorageScope = 'card';
    try {
        return run();
    } finally {
        delete stApi.extension_settings[MODULE_NAME];
        stApi.setTestContext({});
        settings.colorStorageScope = 'card';
    }
}

test('a snapshot that does not mention the scope leaves the active one alone', () => {
    withFreshStore('c1', () => {
        settings.colorStorageScope = 'chat';
        storage.applyStoredSettingsSnapshot({ themeMode: 'dark', colorTheme: 'neon' });
        assert.equal(settings.colorStorageScope, 'chat', 'an unrelated snapshot must not reset the scope');
        storage.applyStoredSettingsSnapshot({});
        assert.equal(settings.colorStorageScope, 'chat', 'an empty snapshot must not reset the scope');
        storage.applyStoredSettingsSnapshot({ colorStorageScope: 'global' });
        assert.equal(settings.colorStorageScope, 'global', 'a snapshot that does carry it still applies');
    });
});

test('a stored record that predates the setting is not stamped with a default', () => {
    withFreshStore('c1', () => {
        stApi.extension_settings[MODULE_NAME] = {
            version: 8,
            globalSettings: { themeMode: 'dark', colorTheme: 'neon' },
            legacyLocalStorageMigrated: true,
        };
        const record = storage.getAutoSyncRecord(true);
        assert.equal(record.globalSettings.colorStorageScope, undefined,
            'reading a record must not write a scope choice the user never made');
        assert.equal(record.globalSettings.themeMode, 'dark', 'the rest of the snapshot still normalizes');
    });
});

test('loading a partial record keeps the scope the user is on', () => {
    for (const globalSettings of [undefined, {}, { themeMode: 'dark' }]) {
        withFreshStore('c1', () => {
            stApi.extension_settings[MODULE_NAME] = {
                version: 8,
                globalSettings,
                colorData: {},
                legacyLocalStorageMigrated: true,
            };
            settings.colorStorageScope = 'chat';
            storage.loadData();
            assert.equal(settings.colorStorageScope, 'chat',
                `a record with globalSettings ${JSON.stringify(globalSettings)} reset the scope`);
        });
    }
});

test('the auto-sync writer keeps both halves of the record in step', () => {
    withFreshStore('c1', () => {
        storage.loadData();
        settings.colorStorageScope = 'chat';
        state.setAutoSyncEnabled(true);
        try {
            storage.saveSettingsToStore({ force: true, schedule: false });
            const record = stApi.extension_settings[MODULE_NAME];
            // globalSettings is the half a reload restores from. Publishing only the transport
            // payload left it empty, and the scope came back as Per card on the next load.
            assert.equal(record.settings.colorStorageScope, 'chat');
            assert.equal(record.globalSettings.colorStorageScope, 'chat',
                'the auto-sync write must not leave globalSettings behind');
        } finally {
            state.setAutoSyncEnabled(false);
        }
    });
});

test('a record whose globalSettings is missing falls back to the auto-sync payload', () => {
    withFreshStore('c1', () => {
        stApi.extension_settings[MODULE_NAME] = {
            version: 8,
            settings: { themeMode: 'dark', colorStorageScope: 'chat' },
            colorData: {},
            legacyLocalStorageMigrated: true,
        };
        settings.colorStorageScope = 'card';
        storage.loadData();
        assert.equal(settings.colorStorageScope, 'chat',
            'a lopsided record still holds the choice in its payload');
    });
});

test('a value globalSettings did record still wins over the payload', () => {
    withFreshStore('c1', () => {
        stApi.extension_settings[MODULE_NAME] = {
            version: 8,
            globalSettings: { colorStorageScope: 'global' },
            settings: { colorStorageScope: 'chat' },
            colorData: {},
            legacyLocalStorageMigrated: true,
        };
        settings.colorStorageScope = 'card';
        storage.loadData();
        assert.equal(settings.colorStorageScope, 'global', 'the fallback fills gaps, it does not override');
    });
});

test('a chosen scope survives a reload, a new chat and a new card', async () => {
    delete stApi.extension_settings[MODULE_NAME];
    stApi.setTestContext(hostContext('c1'));
    settings.colorStorageScope = 'card';
    storage.loadData();

    const result = await storage.switchColorStorageScope('chat', 'copy');
    assert.equal(result.ok, true, result.message);
    assert.equal(stApi.extension_settings[MODULE_NAME].globalSettings.colorStorageScope, 'chat');

    // A reload starts from the module default and has only the stored record to go on.
    settings.colorStorageScope = 'card';
    storage.loadData();
    assert.equal(settings.colorStorageScope, 'chat', 'the scope did not survive a reload');

    for (const [label, context] of [['new chat', hostContext('c2')], ['new card', hostContext('c2', 'alice.png')]]) {
        stApi.setTestContext(context);
        storage.saveData();
        storage.loadData();
        assert.equal(settings.colorStorageScope, 'chat', `the scope did not survive a ${label}`);
    }

    delete stApi.extension_settings[MODULE_NAME];
    stApi.setTestContext({});
    settings.colorStorageScope = 'card';
});

function characterEntry(name, baseColor, extra = {}) {
    return {
        name,
        color: baseColor,
        baseColor,
        locked: false,
        keep: false,
        aliases: [],
        style: '',
        dialogueCount: 0,
        group: '',
        font: '',
        gradient: null,
        gradientGenerator: null,
        ...extra,
    };
}

function withPinnedScope(run) {
    delete stApi.extension_settings[MODULE_NAME];
    stApi.setTestContext(hostContext('c1'));
    settings.colorStorageScope = 'chat';
    storage.loadData();
    try {
        return run();
    } finally {
        state.setCharacterColors({});
        delete stApi.extension_settings[MODULE_NAME];
        stApi.setTestContext({});
        settings.colorStorageScope = 'card';
    }
}

// The reason this store exists: a per-chat table is keyed by the chat, so every new chat used
// to come up empty except for the persona. Keep is the user saying "not this one".
test('a kept character is pinned on save and an unkept one is not', () => {
    withPinnedScope(() => {
        state.setCharacterColors({
            aria: characterEntry('Aria', '#ff0000', { keep: true }),
            kel: characterEntry('Kel', '#00ff00'),
        });
        storage.saveData();
        const pins = storage.getPinnedCharacters();
        assert.equal(pins.aria?.baseColor, '#ff0000');
        assert.equal(pins.kel, undefined, 'only kept characters follow the user around');
    });
});

test('a new chat on the same card comes up with the pinned cast', () => {
    withPinnedScope(() => {
        state.setCharacterColors({
            aria: characterEntry('Aria', '#ff0000', { keep: true, aliases: ['the elf'] }),
            kel: characterEntry('Kel', '#00ff00'),
        });
        storage.saveData();

        stApi.setTestContext(hostContext('c2'));
        storage.loadData();
        assert.equal(state.characterColors.aria?.baseColor, '#ff0000', 'the pinned color must be reproduced exactly');
        assert.equal(state.characterColors.aria?.keep, true, 'a seeded character arrives still pinned');
        assert.deepEqual(state.characterColors.aria?.aliases, ['the elf'], 'aliases describe the character, so they travel');
        assert.equal(state.characterColors.kel, undefined, 'an unpinned character stays behind');
    });
});

test('pins do not follow the user onto another card', () => {
    withPinnedScope(() => {
        state.setCharacterColors({ aria: characterEntry('Aria', '#ff0000', { keep: true }) });
        storage.saveData();

        stApi.setTestContext(hostContext('c2', 'alice.png'));
        storage.loadData();
        assert.equal(state.characterColors.aria, undefined, 'one card cast must not leak into another card chats');
    });
});

test('a save between navigation and table load does not carry pins into the next card', () => {
    withPinnedScope(() => {
        state.setCharacterColors({ aria: characterEntry('Aria', '#ff0000', { keep: true }) });
        storage.saveData();

        // Navigate to another card without loading it, as happens while the
        // extension is disabled, then trigger an ordinary settings save.
        stApi.setTestContext(hostContext('c2', 'alice.png'));
        storage.saveData();
        assert.equal(storage.getPinnedCharacters().aria, undefined,
            'the previous card kept characters must not be pinned onto this card');

        stApi.setTestContext(hostContext('c3', 'alice.png'));
        storage.loadData();
        assert.equal(state.characterColors.aria, undefined, 'one card cast must not leak into another card chats');
    });
});

test('a chat that already knows the character gets the pinned color', () => {
    withPinnedScope(() => {
        state.setCharacterColors({ aria: characterEntry('Aria', '#ff0000', { keep: true }) });
        storage.saveData();

        stApi.setTestContext(hostContext('c2'));
        storage.setStoredColorData(
            storage.getStorageKeyForScope('chat'),
            { aria: characterEntry('Aria', '#0000ff') },
            { ...settings, colorStorageScope: 'chat' },
        );
        storage.loadData();
        assert.equal(state.characterColors.aria?.baseColor, '#ff0000', 'the pin is the one color, in every chat');
        assert.equal(state.characterColors.aria?.keep, true);
    });
});

test('unpinning stops the carry everywhere, not just in this chat', () => {
    withPinnedScope(() => {
        state.setCharacterColors({ aria: characterEntry('Aria', '#ff0000', { keep: true }) });
        storage.saveData();

        state.characterColors.aria.keep = false;
        storage.saveData();
        assert.equal(storage.getPinnedCharacters().aria, undefined);

        stApi.setTestContext(hostContext('c3'));
        storage.loadData();
        assert.equal(state.characterColors.aria, undefined, 'an unpinned character stops seeding new chats');
    });
});

test('unpinning in one chat survives revisiting an older chat that still saved the keep flag', () => {
    withPinnedScope(() => {
        state.setCharacterColors({ aria: characterEntry('Aria', '#ff0000', { keep: true }) });
        storage.saveData();

        // Chat B seeds the pinned cast; the user un-Keeps there.
        stApi.setTestContext(hostContext('c2'));
        storage.loadData();
        assert.equal(state.characterColors.aria?.keep, true, 'the seeded character starts kept');
        state.characterColors.aria.keep = false;
        storage.saveData();
        assert.equal(storage.getPinnedCharacters().aria, undefined);

        // Revisiting chat A reloads its saved keep=true. The stale flag must
        // not be treated as fresh intent: no pin may be re-created, and no
        // later chat may receive the character again.
        stApi.setTestContext(hostContext('c1'));
        storage.loadData();
        assert.equal(state.characterColors.aria?.keep, false, 'the stale keep flag is reconciled away');
        storage.saveData();
        assert.equal(storage.getPinnedCharacters().aria, undefined,
            'a stale table must not re-create the pin');

        stApi.setTestContext(hostContext('c3'));
        storage.loadData();
        assert.equal(state.characterColors.aria, undefined, 'a fresh chat stays free of the unkept character');

        // Re-Keeping is fresh intent and clears the decision again.
        stApi.setTestContext(hostContext('c1'));
        storage.loadData();
        state.characterColors.aria.keep = true;
        storage.saveData();
        assert.equal(storage.getPinnedCharacters().aria?.baseColor, '#ff0000');
    });
});

test('card and global scopes record pins without seeding them back', () => {
    withPinnedScope(() => {
        settings.colorStorageScope = 'card';
        storage.loadData();
        state.setCharacterColors({ aria: characterEntry('Aria', '#ff0000', { keep: true }) });
        storage.saveData();
        // Recorded on card scope so a later switch to per-chat already knows the answer, but
        // never seeded: a card table already outlives a chat change on its own.
        assert.equal(storage.getPinnedCharacters().aria?.baseColor, '#ff0000');

        state.setCharacterColors({});
        assert.equal(storage.restorePinnedCharacters(), false);
        assert.equal(state.characterColors.aria, undefined);
    });
});

test('a user who never pins anyone leaves no bucket behind', () => {
    withPinnedScope(() => {
        state.setCharacterColors({ kel: characterEntry('Kel', '#00ff00') });
        storage.saveData();
        assert.equal(stApi.extension_settings[MODULE_NAME].ui?.pinnedCharacters, undefined,
            'an empty bucket for every card the user opens would ride along in every settings sync');
    });
});

test('a branched chat gets its own table starting as a copy, then diverges', () => {
    delete stApi.extension_settings[MODULE_NAME];
    settings.colorStorageScope = 'chat';
    const contextA = {
        chat: [],
        chatMetadata: {},
        chatId: 'c1',
        characterId: 0,
        characters: [{ avatar: 'bob.png', name: 'Bob' }],
        groupId: null,
        saveMetadata: async () => {},
    };
    try {
        stApi.setTestContext(contextA);
        storage.loadData();
        state.setCharacterColors({ aria: characterEntry('Aria', '#ff0000') });
        storage.saveData();
        const storedId = contextA.chatMetadata[storage.CHAT_SCOPE_METADATA_KEY];
        assert.ok(storedId, 'the source chat should have a stored per-chat ID');

        // Simulate a reload: fresh metadata objects carrying the stored ID, so
        // no in-memory pending state can mask a shared key. The host copies
        // chat metadata verbatim on branch/checkpoint/import under a new chat.
        const reloadA = {
            ...contextA,
            chat: [],
            chatMetadata: { [storage.CHAT_SCOPE_METADATA_KEY]: storedId },
        };
        const branch = {
            ...contextA,
            chat: [],
            chatMetadata: { [storage.CHAT_SCOPE_METADATA_KEY]: storedId },
            chatId: 'c1-branch',
        };
        stApi.setTestContext(reloadA);
        storage.loadData();
        const keyA = storage.getStorageKeyForScope('chat');
        stApi.setTestContext(branch);
        const preB = storage.getStorageKeyForScope('chat', { persistMetadata: false });
        assert.equal(preB, keyA, 'setup check: without rotation the branch would reuse the source key');

        // loadData persists the previous table before switching, so capture
        // the branch table directly instead of loading through it.
        stApi.setTestContext(branch);
        const keyB = storage.getStorageKeyForScope('chat');
        assert.notEqual(keyB, keyA, 'the branch must not keep addressing the source table');
        assert.equal(storage.getStoredColorData(keyB)?.colors?.aria?.baseColor, '#ff0000',
            'the branch starts with the source colors');
        // Emulate opening the branch for real without tripping the stale
        // in-memory active key from the source context.
        stApi.setTestContext(reloadA);
        storage.loadData();
        stApi.setTestContext(branch);
        storage.loadData();
        assert.equal(state.characterColors.aria?.baseColor, '#ff0000',
            'the branch starts with the source colors');

        state.characterColors.aria.baseColor = '#00ff00';
        state.characterColors.aria.color = '#00ff00';
        storage.saveData();

        stApi.setTestContext(reloadA);
        storage.loadData();
        assert.equal(state.characterColors.aria?.baseColor, '#ff0000',
            'editing the branch must not rewrite the source chat');

        stApi.setTestContext({ ...branch, chat: [], chatMetadata: { ...branch.chatMetadata } });
        storage.loadData();
        assert.equal(state.characterColors.aria?.baseColor, '#00ff00',
            'reopening a branch must not load the stale copy made when it was created');
    } finally {
        state.setCharacterColors({});
        delete stApi.extension_settings[MODULE_NAME];
        stApi.setTestContext({});
        settings.colorStorageScope = 'card';
    }
});

test('renaming a card away and back keeps the latest colours', async () => {
    delete stApi.extension_settings[MODULE_NAME];
    settings.colorStorageScope = 'card';
    try {
        stApi.setTestContext(hostContext('c1'));
        storage.loadData();
        state.setCharacterColors({ aria: characterEntry('Aria', '#ff0000') });
        storage.saveData();

        // Rename Bob -> Bobby, then edit the colour while the card is renamed.
        // The host fires the rename event after the context already points at
        // the new card, so migrate under the renamed context like production.
        stApi.setTestContext(hostContext('c1', 'bobby.png'));
        const renamed = await storage.migrateRenamedCharacterStorage('bob.png', 'bobby.png');
        assert.equal(renamed.ok, true);
        assert.ok(stApi.extension_settings[MODULE_NAME].colorData['dc_char_bobby.png'],
            'the renamed card must receive the old table');
        assert.ok(!stApi.extension_settings[MODULE_NAME].colorData['dc_char_bob.png'],
            'the old table must move, not stay behind as a stale copy');

        storage.loadData();
        state.setCharacterColors({ aria: characterEntry('Aria', '#00ff00') });
        storage.saveData();

        // Rename back: the newer colour must survive, not the pre-rename one.
        stApi.setTestContext(hostContext('c1'));
        const renamedBack = await storage.migrateRenamedCharacterStorage('bobby.png', 'bob.png');
        assert.equal(renamedBack.ok, true);
        storage.loadData();
        storage.loadData();
        assert.equal(state.characterColors.aria?.baseColor, '#00ff00',
            'the colour edited under the temporary name must survive the rename back');
    } finally {
        state.setCharacterColors({});
        delete stApi.extension_settings[MODULE_NAME];
        stApi.setTestContext({});
        settings.colorStorageScope = 'card';
    }
});

test('remote sync resolves a chat table stored under its host key', async () => {
    delete stApi.extension_settings[MODULE_NAME];
    settings.colorStorageScope = 'chat';
    const storedId = 'scope-1234';
    const fallbackKey = 'dc_chat_card_bob.png_host_c1';
    const primaryKey = 'dc_chat_card_bob.png_meta_scope-1234';
    try {
        stApi.setTestContext({
            ...hostContext('c1'),
            chatMetadata: { [storage.CHAT_SCOPE_METADATA_KEY]: storedId },
        });
        storage.loadData();
        // Switching scope persists the previous active table through the
        // debounced settings save; let that settle so the sync apply below is
        // not deferred behind it.
        await new Promise(resolve => setTimeout(resolve, 400));
        // A remote record can hold the chat table under its original host-ID
        // key plus the mapping from the durable metadata ID. Sync must load
        // through that mapping instead of showing an empty table.
        const disposition = storage.applyAutoSyncRecord({
            version: 10,
            timestamp: new Date(Date.now() + 1000).toISOString(),
            colorData: {
                [fallbackKey]: {
                    colors: { aria: characterEntry('Aria', '#ff0000') },
                    groupProfiles: {},
                    settings: {},
                },
            },
            ui: { chatScopeFallbacks: { 'meta_scope-1234': fallbackKey } },
        }, { force: true });
        assert.equal(disposition, 'apply');
        assert.equal(state.characterColors.aria?.baseColor, '#ff0000',
            'the incoming host-keyed table must load through its own mapping');

        storage.saveData();
        assert.ok(stApi.extension_settings[MODULE_NAME].colorData[primaryKey],
            'a later save must persist the table under the current key');
    } finally {
        state.setCharacterColors({});
        delete stApi.extension_settings[MODULE_NAME];
        stApi.setTestContext({});
        settings.colorStorageScope = 'card';
    }
});

test('card rename moves explicit un-Keep decisions together with pins and chat tables', async () => {
    delete stApi.extension_settings[MODULE_NAME];
    settings.colorStorageScope = 'chat';
    try {
        stApi.setTestContext(hostContext('rename-unkeep'));
        storage.loadData({ persistPrevious: false });
        state.setCharacterColors({ aria: characterEntry('Aria', '#ff0000', { keep: true }) });
        storage.saveData();
        stApi.setTestContext(hostContext('unkeep-here'));
        storage.loadData();
        state.characterColors.aria.keep = false;
        storage.saveData();

        stApi.setTestContext(hostContext('rename-unkeep', 'renamed.png'));
        assert.equal((await storage.migrateRenamedCharacterStorage('bob.png', 'renamed.png')).ok, true);
        storage.loadData();
        assert.equal(state.characterColors.aria.keep, false);
        assert.equal(storage.getPinnedCharacters().aria, undefined);
        assert.equal(storage.getUiState().unkeptCharacters['card_bob.png'], undefined);
        assert.equal(storage.getUiState().unkeptCharacters['card_renamed.png'].aria, true);
    } finally {
        state.setCharacterColors({});
        delete stApi.extension_settings[MODULE_NAME];
        stApi.setTestContext({});
        settings.colorStorageScope = 'card';
    }
});

test('an approved scope-changing import keeps the pins it restores itself', async () => {
    delete stApi.extension_settings[MODULE_NAME];
    settings.colorStorageScope = 'card';
    try {
        stApi.setTestContext(hostContext('c1'));
        storage.loadData();
        state.setCharacterColors({ aria: characterEntry('Aria', '#ff0000', { keep: true }) });
        storage.saveData();
        assert.ok(storage.getPinnedCharacters().aria, 'setup: Aria is kept in per-card mode');

        const analysis = await storage.analyzeColorImport({
            version: 10,
            colors: { beth: characterEntry('Beth', '#00ff00') },
            settings: { colorStorageScope: 'chat' },
        });
        assert.equal(analysis.ok, true, 'setup: the chat-scope import must review cleanly');
        const applied = await storage.applyColorImport(analysis.payload, {
            mode: 'replace',
            applyScope: true,
        });
        assert.equal(applied.ok, true, `the approved scope change must apply, got ${JSON.stringify(applied)}`);
        assert.equal(settings.colorStorageScope, 'chat', 'the requested scope must be active');
        assert.equal(state.characterColors.beth?.baseColor, '#00ff00', 'the imported character must land');
        assert.equal(state.characterColors.aria?.keep, true,
            'the kept pin the switch itself restored must survive the import');
    } finally {
        state.setCharacterColors({});
        delete stApi.extension_settings[MODULE_NAME];
        stApi.setTestContext({});
        settings.colorStorageScope = 'card';
    }
});
