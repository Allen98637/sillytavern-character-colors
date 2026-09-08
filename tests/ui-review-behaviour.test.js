import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { cloneGradient, normalizeGradient, GRADIENT_TYPES } from '../src/gradients.js';
import { getGroupProfile, normalizeGroupKey, normalizeGroupName, normalizeRegistryIdentity, normalizeRegistryIdentityName, isReservedCharacterIdentity, GROUP_PROFILE_AUTOMATION_KEYS } from '../src/group-profiles.js';
import { captureCharacterStyle, CHARACTER_STYLE_FIELD_MASKS } from '../src/character-style.js';

const source = await readFile(new URL('../src/ui.js', import.meta.url), 'utf8');
const noop = () => {};
const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

// Execute the shipped functions, with only host services and DOM boundaries replaced.
function loadFunctions(names, globals = {}, handlers = []) {
    const context = {
        console, requestAnimationFrame: callback => callback(), CSS: { escape: String },
        escapeHtml, escapeAttr: escapeHtml,
        toast: { info: noop, warning: noop, success: noop, error: noop },
        ...globals,
    };
    const functions = names.map(name => {
        const match = new RegExp(`^(?:export )?((?:async )?function ${name}\\()`, 'm').exec(source);
        assert.ok(match, `Missing function ${name}`);
        const start = match.index + (match[0].startsWith('export ') ? 7 : 0);
        const end = source.indexOf('\n}', start);
        assert.ok(end > start, `Missing end of ${name}`);
        return source.slice(start, end + 2);
    });
    const bindings = handlers.map(id => {
        const start = source.indexOf(`    $('${id}').`);
        const end = source.indexOf("\n    $('", start + 1);
        assert.ok(start >= 0 && end > start, `Missing handler ${id}`);
        return source.slice(start, end);
    });
    runInNewContext([...functions, ...bindings].join('\n'), context);
    return context;
}

function element() {
    const attributes = new Map();
    const listeners = new Map();
    return {
        dataset: {}, style: {}, value: '', children: [], parentElement: null,
        classList: { contains: () => false, add: noop, remove: noop, toggle: noop },
        querySelector: () => null, querySelectorAll: () => [], closest: () => null,
        setAttribute(key, value) { attributes.set(key, String(value)); },
        getAttribute: key => attributes.get(key) ?? null,
        hasAttribute: key => attributes.has(key),
        removeAttribute: key => attributes.delete(key),
        addEventListener(type, callback) { listeners.set(type, callback); },
        removeEventListener: type => listeners.delete(type),
        dispatch(type, event = {}) { return listeners.get(type)?.({ target: this, ...event }); },
        focus() { this.focused = true; },
        contains(target) { return this === target || this.children.some(child => child.contains(target)); },
        appendChild(child) { return this.insertBefore(child, null); },
        insertBefore(child, before) {
            child.remove();
            const index = before ? this.children.indexOf(before) : this.children.length;
            assert.ok(index >= 0);
            this.children.splice(index, 0, child);
            child.parentElement = this;
            return child;
        },
        remove() {
            if (this.parentElement) {
                const siblings = this.parentElement.children;
                siblings.splice(siblings.indexOf(this), 1);
                this.parentElement = null;
            }
        },
        get firstElementChild() { return this.children[0] ?? null; },
        get nextElementSibling() {
            const siblings = this.parentElement?.children || [];
            return siblings[siblings.indexOf(this) + 1] ?? null;
        },
    };
}

function reviewHarness(decide, extra = {}) {
    const context = { chat: [{}], chatMetadata: {} };
    const reviews = [{ id: 'same-id', proposedSpeaker: 'Alice', confidence: 0.99, segmentIndex: 0 }];
    const calls = [];
    const functions = [
        'captureAttributionReviewScope', 'isAttributionReviewScopeCurrent',
        'showAttributionReviewDialog', 'editAndAcceptAttributionReview',
        'acceptAllHighConfidenceAttributionReviews', 'acceptAllProposedAttributionReviews',
        'confirmReviewedAction', 'acceptAttributionReviewFromUi',
    ];
    const ui = loadFunctions(functions, {
        closeActiveUiDialog: null, AUTO_HIGH_ATTRIBUTION_CONFIDENCE: 0.9,
        ATTRIBUTION_REVIEW_STATUS: { ACCEPTED: 'accepted' },
        getContext: () => context,
        getPendingAttributionReviews: () => reviews,
        getAttributionReviewPresentation: review => ({ review, messageIndex: 0, stale: false }),
        getKnownReviewSpeakerName: name => name === 'Alice' ? name : '',
        getKnownReviewSpeakerOptions: () => ['Alice'],
        buildAttributionReviewDetails: () => '',
        refreshAttributionReviewStatus: noop,
        notifyUiContextChanged: () => calls.push('context-changed'),
        acceptAttributionReview: id => { calls.push(`accept:${id}`); reviews.length = 0; return { status: 'accepted' }; },
        repaintAcceptedAttributionReview: async () => {},
        rejectAttributionReview: id => { calls.push(`reject:${id}`); reviews.length = 0; },
        dismissAttributionReview: id => { calls.push(`dismiss:${id}`); reviews.length = 0; },
        pruneAttributionReviews: noop,
        jumpToAttributionReviewMessage: () => calls.push('jump'),
        openDecisionDialog: async options => decide(options, context, calls),
        ...extra,
    });
    return { ui, context, reviews, calls };
}

test('every reviewed action refuses a chat switch while its dialog is open', async () => {
    for (const action of ['accept', 'reject', 'dismiss', 'edit', 'jump', 'accept-all', 'accept-high']) {
        let dialogs = 0;
        const { ui, calls } = reviewHarness(async (_options, context) => {
            assert.equal(++dialogs, 1, `${action} must not open a dialog for the new chat`);
            await Promise.resolve();
            context.chat = [{}];
            context.chatMetadata = {};
            return { value: action };
        });
        await ui.showAttributionReviewDialog(null);
        assert.deepEqual(calls, ['context-changed'], action);
    }
});

test('the edit dialog refuses changed metadata and does not retry invalid input in another chat', async () => {
    for (const inputValue of ['Alice', 'Unknown']) {
        let dialogs = 0;
        const { ui, calls } = reviewHarness(async (_options, context) => {
            if (++dialogs === 1) return { value: 'edit' };
            assert.equal(dialogs, 2);
            context.chatMetadata = {};
            return { value: 'accept', inputValue };
        });
        await ui.showAttributionReviewDialog(null);
        assert.deepEqual(calls, ['context-changed']);
    }
});

test('dismissed or superseded edit and bulk dialogs stop the parent flow', async () => {
    for (const action of ['edit', 'accept-all', 'accept-high']) {
        let dialogs = 0;
        const { ui, calls } = reviewHarness(async () => {
            assert.ok(++dialogs <= 2, `${action} reopened a superseded flow`);
            return { value: dialogs === 1 ? action : null };
        });
        await ui.showAttributionReviewDialog(null);
        assert.equal(dialogs, 2);
        assert.deepEqual(calls, []);
    }
});

test('bulk review refuses a switch during confirmation and stops after a switch during repaint', async () => {
    for (const method of ['acceptAllProposedAttributionReviews', 'acceptAllHighConfidenceAttributionReviews']) {
        const first = reviewHarness(async (_options, context) => {
            context.chat = [];
            return { value: 'confirm' };
        });
        assert.equal(await first.ui[method](null), 0);
        assert.deepEqual(first.calls, ['context-changed']);

        const second = reviewHarness(async () => ({ value: 'confirm' }));
        second.reviews.push({ ...second.reviews[0], id: 'second' });
        second.ui.repaintAcceptedAttributionReview = async () => { second.context.chat = []; };
        assert.equal(await second.ui[method](null), 1);
        assert.deepEqual(second.calls, ['accept:same-id', 'context-changed']);
    }
});

test('valid edited acceptance still applies once in the original chat', async () => {
    const { ui, calls } = reviewHarness(async options => {
        if (options.title.startsWith('Edit')) return { value: 'accept', inputValue: 'Alice' };
        return { value: options.title.startsWith('Review suggestion ') ? 'edit' : 'close' };
    });
    await ui.showAttributionReviewDialog(null);
    assert.deepEqual(calls, ['accept:same-id']);
});

test('an accepted review never refreshes or schedules repairs in a different chat', async () => {
    for (const switchDuring of ['decorate', 'refresh']) {
        const context = { chat: [{}], chatMetadata: {} };
        const calls = [];
        const ui = loadFunctions(['repaintAcceptedAttributionReview', 'captureAttributionReviewScope', 'isAttributionReviewScopeCurrent'], {
            getContext: () => context,
            clearMessageDomRepairTimer: noop, cancelMessageDomFollowupRepairs: noop, clearStreamingAttributionOverrides: noop,
            decorateMessageDomFromCurrentRender: async () => {
                if (switchDuring === 'decorate') context.chat = [];
                return false;
            },
            refreshAndDecorateMessageDom: async () => { calls.push('refresh'); context.chat = []; return {}; },
            scheduleMessageDomFollowupRepair: () => calls.push('repair'),
        });
        await ui.repaintAcceptedAttributionReview({ messageIndex: 0 });
        assert.deepEqual(calls, switchDuring === 'decorate' ? [] : ['refresh']);
    }
});

test('fullscreen message jump exits before scrolling and focusing', () => {
    const calls = [];
    const target = element();
    target.focus = () => { calls.push('focus'); document.activeElement = target; };
    const message = { scrollIntoView: () => calls.push('scroll'), querySelector: () => target };
    const document = { querySelector: () => message };
    const ui = loadFunctions(['jumpToAttributionReviewMessage'], {
        document, isSettingsFullscreen: () => true, exitSettingsFullscreen: () => calls.push('exit'),
    });
    ui.jumpToAttributionReviewMessage({ messageIndex: 0, review: { segmentIndex: 0 } });
    assert.deepEqual(calls, ['exit', 'scroll', 'focus']);
    assert.equal(target.getAttribute('tabindex'), '-1');
    target.dispatch('blur');
    assert.equal(target.hasAttribute('tabindex'), false);
});

test('routine legend updates cannot reveal the legend during fullscreen', () => {
    const legend = element();
    const ui = loadFunctions(['updateLegend'], {
        createLegend: () => legend, settings: { enabled: true, showLegend: true },
        characterColors: { alice: { name: 'Alice' } }, FLOATING_LEGEND_RENDER_LIMIT: 200,
        getEffectiveNarratorVisual: () => null, getTransientNarratorCount: () => 0, getContext: () => ({}),
        getColorVisionSimulationForTarget: () => null, getVisualRenderState: () => ({ fallbackColor: '#123456' }),
        normalizeGoogleFontName: () => '', getGradientSignature: () => '', lastLegendSignature: '',
        isSettingsFullscreen: () => true, document: { activeElement: null },
        getGradientPresentation: () => null, buildGradientSurfaceStyle: () => '', getTypographyStyle: () => '',
        registerGradientAnimationRoot: noop, refreshGradientAnimationState: noop,
    });
    ui.updateLegend();
    assert.equal(legend.style.display, 'none');
    ui.characterColors.alice.dialogueCount = 3;
    ui.updateLegend();
    assert.equal(legend.style.display, 'none');
    ui.isSettingsFullscreen = () => false;
    ui.updateLegend();
    assert.equal(legend.style.display, 'block');
    ui.settings.showLegend = false;
    ui.updateLegend();
    assert.equal(legend.style.display, 'none');
});

test('row drafts survive save replacement but never reuse identical rows from another table', () => {
    const list = element();
    const document = { getElementById: id => id === 'dc-char-list' ? list : null, activeElement: null };
    const ui = loadFunctions(['updateCharList'], {
        document, lastRenderedTableKey: null, tableKey: 'table-a',
        getCurrentStorageScope: () => 'chat',
        getStorageKeyForScope: () => ui.tableKey,
        characterColors: { alice: { name: 'Alice', dialogueCount: 0 } },
        normalizeNarratorStyle: () => ({}), settings: {},
        captureScrollPositions: () => [], restoreScrollPositions: noop, installCharListDelegation: noop,
        getSortedEntries: () => Object.entries(ui.characterColors), CHARACTER_LIST_RENDER_LIMIT: 500,
        updateBulkToolbar: noop, refreshGroupProfileControls: noop,
        buildCharRowSignature: (_key, entry) => JSON.stringify(entry), buildCharRowHtml: key => key,
        htmlToNode: () => element(), applyControlHelpText: noop, updateLegend: noop,
        registerGradientAnimationRoot: noop, refreshGradientAnimationState: noop, renderGradientPresetGallery: noop,
    });
    ui.updateCharList();
    const firstRow = list.firstElementChild;
    const input = element();
    input.matches = () => true;
    input.value = 'Uncommitted draft';
    firstRow.appendChild(input);
    document.activeElement = input;
    ui.characterColors = structuredClone(ui.characterColors);
    ui.characterColors.alice.dialogueCount++;
    ui.updateCharList();
    assert.equal(list.firstElementChild, firstRow, 'saving and updating counts must preserve an active editor');
    assert.equal(input.value, 'Uncommitted draft');
    ui.characterColors.alice.dialogueCount = 0;
    ui.tableKey = 'table-b';
    ui.updateCharList();
    assert.notEqual(list.firstElementChild, firstRow, 'same signature must not bypass table identity');
    assert.equal(firstRow.parentElement, null);
});

test('shared group refresh resyncs restored profiles and scopes without discarding unchanged drafts', () => {
    const controls = new Map();
    const get = id => {
        if (!controls.has(id)) controls.set(id, element());
        return controls.get(id);
    };
    get('dc-group-profile-name').value = 'Cast';
    const ui = loadFunctions(['refreshGroupProfileControls', 'syncGroupProfileEditor', 'getGroupProfileEditorName', 'setGroupProfileAutomationControls'], {
        document: { getElementById: get }, characterColors: {}, tableKey: 'table-a',
        getStorageKeyForScope: () => ui.tableKey, getCurrentStorageScope: () => 'chat',
        groupProfiles: { cast: { name: 'Cast', style: captureCharacterStyle({}, CHARACTER_STYLE_FIELD_MASKS.FONT), automation: { autoLock: true } } },
        getGroupProfile, normalizeGroupName, normalizeGroupKey, GROUP_PROFILE_AUTOMATION_KEYS, CHARACTER_STYLE_FIELD_MASKS,
        DEFAULT_CHARACTER_STYLE_FIELD_MASK: CHARACTER_STYLE_FIELD_MASKS.FONT,
        DIALOG_LIST_RENDER_LIMIT: 500, getCharacterKeysForGroup: () => [],
    });
    ui.refreshGroupProfileControls();
    assert.equal(get('dc-group-profile-font').checked, true);
    assert.equal(get('dc-group-profile-autoLock').value, 'true');
    get('dc-group-profile-font').checked = false;
    get('dc-group-profile-source').value = 'draft-source';
    ui.groupProfiles = structuredClone(ui.groupProfiles);
    ui.refreshGroupProfileControls();
    assert.equal(get('dc-group-profile-font').checked, false, 'an unrelated save must not reset draft fields');
    ui.groupProfiles.cast.automation.autoLock = false;
    ui.refreshGroupProfileControls();
    assert.equal(get('dc-group-profile-font').checked, true);
    assert.equal(get('dc-group-profile-autoLock').value, 'false');
    assert.equal(get('dc-group-profile-source').value, '');
    get('dc-group-profile-font').checked = false;
    ui.tableKey = 'table-b';
    ui.refreshGroupProfileControls();
    assert.equal(get('dc-group-profile-font').checked, true, 'identical profiles in another scope still reset drafts');
});

test('removing the last alias from a collapsed row focuses its Edit control', () => {
    const more = element();
    const row = { querySelector: selector => selector === '.dc-more' ? more : null };
    let commits = 0;
    const ui = loadFunctions(['handleAliasRemoveClick', 'focusCharacterControl'], {
        characterColors: { alice: { aliases: ['Al'] } },
        commit: () => commits++, repaintDomAfterCharacterDataChange: noop,
        document: { querySelector: () => row },
    });
    ui.handleAliasRemoveClick({ stopPropagation: noop }, { dataset: { key: 'alice', alias: 'Al' } });
    assert.equal(ui.characterColors.alice.aliases.length, 0);
    assert.equal(commits, 1);
    assert.equal(more.focused, true);
});

test('the delegated exact-angle change creates and updates a custom direction option', () => {
    const list = element();
    const editor = element();
    const angle = element();
    angle.value = '123';
    angle.type = 'number'; angle.min = '0'; angle.max = '360';
    angle.classList.contains = name => name === 'dc-gradient-angle';
    angle.closest = () => editor;
    editor.dataset.key = 'alice';
    const direction = element();
    direction.options = [0, 45, 90, 135, 180, 225, 270, 315].map(value => ({ value: String(value) }));
    direction.appendChild = option => direction.options.push(option);
    editor.querySelector = selector => ({ '.dc-gradient-angle': angle, '.dc-gradient-direction': direction })[selector] || null;
    const gradient = normalizeGradient({ type: 'linear', angle: 90, stops: [{ color: '#ffffff', baseColor: '#ffffff', position: 100 }] });
    const ui = loadFunctions([
        'installCharListDelegation', 'getGradientEditorContext', 'handleGradientEditorMutation',
        'synchronizeGradientColorControls', 'readGradientFromEditor', 'readGradientNumber', 'synchronizeGradientEditorFromEntry',
    ], {
        characterColors: { alice: { gradient } }, cloneGradient, normalizeGradient, GRADIENT_TYPES,
        GRADIENT_DIRECTIONS: direction.options.map(option => ({ value: Number(option.value) })),
        document: { createElement: element }, normalizeHexColor: value => value,
        handleCharListClick: noop, flushColorStateSave: noop,
        applyGradientValue: (key, value) => { ui.characterColors[key].gradient = { ...value, stops: gradient.stops }; },
    });
    ui.installCharListDelegation(list);
    list.dispatch('change', { target: angle });
    assert.equal(direction.options.length, 9);
    assert.equal(direction.value, '');
    assert.equal(direction.options[8].textContent, 'Custom (123\u00b0)');
    angle.value = '124';
    list.dispatch('change', { target: angle });
    assert.equal(direction.options.length, 9);
    assert.equal(direction.options[8].textContent, 'Custom (124\u00b0)');
    angle.value = '90';
    list.dispatch('change', { target: angle });
    assert.equal(direction.value, '90');
});

test('dialog validation retains the same form until valid, while cancel bypasses validation', async () => {
    const body = element();
    const backdrop = element();
    const dialog = element();
    const field = element();
    field.dataset.dialogField = 'name';
    field.value = 'draft';
    let valid = false;
    let reports = 0;
    field.reportValidity = () => { reports++; return valid; };
    const build = element(); build.dataset = { dialogValue: 'build', dialogValidate: 'true' };
    const cancel = element(); cancel.dataset.dialogValue = 'cancel';
    dialog.querySelectorAll = selector => selector === '[data-dialog-value]' ? [build, cancel]
        : selector === '[data-dialog-field]' ? [field] : [];
    backdrop.querySelector = () => dialog;
    const ui = loadFunctions(['openDecisionDialog'], {
        document: { body, createElement: () => backdrop, addEventListener: noop, removeEventListener: noop },
        closeActiveUiDialog: null, registerGradientAnimationRoot: noop, unregisterGradientAnimationRoot: noop,
        claimOutsideInert: () => [], releaseOwnedInert: noop, getDialogFocusables: () => [],
    });
    const result = ui.openDecisionDialog({ title: 'Build', choices: [] });
    build.dispatch('click');
    assert.equal(reports, 1);
    assert.equal(body.children[0], backdrop);
    assert.equal(field.value, 'draft');
    valid = true;
    build.dispatch('click');
    assert.equal((await result).formValues.name, 'draft');
    assert.equal(body.children.length, 0);
    valid = false;
    const cancelled = ui.openDecisionDialog({ title: 'Build', choices: [] });
    cancel.dispatch('click');
    assert.equal((await cancelled).value, 'cancel');
    assert.equal(reports, 2);
});

test('style-pack export requests native name validation including whitespace-only names', async () => {
    let dialog;
    const ui = loadFunctions(['buildStylePackExport', 'stylePackCheckbox'], {
        getCustomPalettes: () => ({}), getCustomGradientPresets: () => ({}), getPresets: () => ({}),
        openDecisionDialog: async options => { dialog = options; return { value: 'cancel' }; },
    });
    await ui.buildStylePackExport(null);
    assert.equal(dialog.choices.find(choice => choice.value === 'build').validate, true);
    const nameInput = dialog.formHtml.match(/<input[^>]*data-dialog-field="name"[^>]*>/)?.[0];
    assert.ok(nameInput?.includes('required'));
    const pattern = nameInput.match(/pattern="([^"]+)"/)[1];
    const validName = new RegExp(`^(?:${pattern})$`, 'v');
    assert.equal(validName.test(''), false);
    assert.equal(validName.test('   '), false);
    assert.equal(validName.test(' My pack '), true);
});

test('style-pack and colour import reads cannot displace a newer review', async () => {
    const controls = new Map();
    const $ = id => {
        if (!controls.has(id)) controls.set(id, element());
        return controls.get(id);
    };
    const pending = [];
    const reviews = [];
    const analyze = () => new Promise(resolve => pending.push(resolve));
    loadFunctions(['runImportAnalysis'], {
        $, importAnalysisRequestId: 0, STYLE_PACK_FILE_LIMIT: 1024 * 1024,
        analyzeStylePackImport: analyze, analyzeColorImport: analyze, announceStylePack: noop,
        reviewAndApplyStylePack: async analysis => reviews.push(analysis),
        reviewAndApplyImport: async analysis => reviews.push(analysis),
    }, ['dc-style-pack-file', 'dc-import-file']);
    for (const order of [['dc-style-pack-file', 'dc-import-file'], ['dc-import-file', 'dc-style-pack-file']]) {
        const older = $(order[0]).onchange({ target: { files: [{ size: 1 }], value: 'old' } });
        const newer = $(order[1]).onchange({ target: { files: [{ size: 1 }], value: 'new' } });
        const resolveOld = pending.shift();
        pending.shift()('new');
        await newer;
        resolveOld('old');
        await older;
    }
    assert.deepEqual(reviews, ['new', 'new']);
});

test('Enter in a colour-code field invokes the change path only once', () => {
    const list = element();
    const input = element();
    input.classList.contains = name => name === 'dc-color-hex';
    let commits = 0;
    const ui = loadFunctions(['installCharListDelegation'], {
        handleCharListClick: noop, maybeAutoRecolorAfterColorChange: noop,
        applyHexInputForElement: () => { commits++; return true; },
    });
    ui.installCharListDelegation(list);
    input.blur = () => list.dispatch('change', { target: input });
    list.dispatch('keydown', { target: input, key: 'Enter', preventDefault: noop });
    assert.equal(commits, 1);
});

test('repair stays busy during shared refreshes and disabled when switched off before completion', async () => {
    const controls = new Map();
    const $ = id => {
        if (!controls.has(id)) controls.set(id, element());
        return controls.get(id);
    };
    let finish;
    const settings = { enabled: true };
    const ui = loadFunctions(['syncProcessControlState'], {
        $, settings, document: { getElementById: $, querySelectorAll: () => [...controls.values()] },
        applyToolCallMessageRepair: () => new Promise(resolve => { finish = resolve; }),
    }, ['dc-repair-tool-calls']);
    const button = $('dc-repair-tool-calls');
    const repair = button.onclick({ currentTarget: button });
    assert.equal(button.disabled, true);
    ui.syncProcessControlState();
    assert.equal(button.disabled, true);
    settings.enabled = false;
    finish();
    await repair;
    assert.equal(button.hasAttribute('aria-busy'), false);
    assert.equal(button.disabled, true);
});

test('add and rename reject full-width prompt punctuation without allowing internal line breaks', () => {
    const characterColors = { alice: { name: 'Alice' } };
    const ui = loadFunctions(['addCharacter', 'renameCharacter'], {
        characterColors, normalizeRegistryIdentity, normalizeRegistryIdentityName, isReservedCharacterIdentity,
        resolveCharacterKeyByNameOrAlias: () => 'alice',
        captureEffectiveColorSnapshot: () => assert.fail('invalid add reached mutation setup'),
        commit: () => assert.fail('invalid rename reached commit'),
    });
    for (const name of ['Alice\uff0cJr', 'Alice\uff1dBob', 'Alice\uff08Jr\uff09', 'Alice\nJr', 'Alice\rJr', 'Alice\tJr']) {
        assert.equal(ui.addCharacter(name), undefined);
        assert.equal(ui.renameCharacter('alice', name), false);
        assert.deepEqual(characterColors, { alice: { name: 'Alice' } });
    }
});
