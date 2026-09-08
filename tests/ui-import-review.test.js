import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/ui.js', import.meta.url), 'utf8');

function functionSource(name, nextName) {
    const start = source.indexOf(`function ${name}(`);
    const nextFunction = source.indexOf(`function ${nextName}(`, start + 1);
    const end = source.lastIndexOf('\n', nextFunction);
    assert.ok(start >= 0 && nextFunction > start && end > start, `could not isolate ${name}`);
    return source.slice(start, end);
}

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

test('style-pack review shows bounded and escaped cross-preset override diagnostics', () => {
    const helperSource = functionSource('buildStylePackAssignmentOverrideDetails', 'buildStylePackImportDetails');
    const buildDetails = new Function(
        'escapeHtml',
        'STYLE_PACK_OVERRIDE_DIAGNOSTIC_LIMIT',
        `${helperSource}; return buildStylePackAssignmentOverrideDetails;`,
    )(escapeHtml, 3);
    const identityResolutions = Array.from({ length: 5 }, (_, index) => ({
        identities: [index === 0 ? '<alias>' : `alias-${index}`],
        previousAssignment: `Previous ${index}`,
        previousPreset: 'Base',
        overridingAssignment: `Override ${index}`,
        overridingPreset: 'Later',
        resolution: index === 0 ? 'replace-assignment' : 'reassign-alias',
    }));
    const html = buildDetails({
        conflicts: { categories: { assignmentPresets: { identityResolutions } } },
    });

    assert.match(html, /Cross-preset identity resolutions/);
    assert.equal((html.match(/<li>/g) || []).length, 3);
    assert.match(html, /2 additional resolutions? omitted/);
    assert.match(html, /&lt;alias&gt;/);
    assert.doesNotMatch(html, /<alias>/);
});

test('style-pack import validation requires reviewed identity diagnostics and order', () => {
    const reviewStart = source.indexOf('async function reviewAndApplyStylePack(');
    const reviewEnd = source.indexOf('export function renderStylePackRegistry(', reviewStart);
    const reviewSource = source.slice(reviewStart, reviewEnd);

    assert.match(reviewSource, /Array\.isArray\(conflictCategories\.assignmentPresets\?\.identityResolutions\)/);
    assert.match(reviewSource, /Array\.isArray\(conflictCategories\.assignmentPresets\?\.presetOrder\)/);
    assert.match(reviewSource, /presetOrder\.every\(name => typeof name === 'string'\)/);
    assert.match(reviewSource, /typeof analysis\.catalogFingerprint === 'string'/);
    assert.match(reviewSource, /analysis\.catalogFingerprint\.length > 0/);
});

test('auxiliary character options and bulk-visible actions share hard bounds', () => {
    const gallerySource = functionSource('getGradientGalleryTargets', 'focusGradientGalleryControl');
    const groupsSource = functionSource('refreshGroupProfileControls', 'saveGroupProfileFromEditor');
    const toolbarSource = functionSource('updateBulkToolbar', 'getVisibleCharacterEntries');
    const visibleSource = functionSource('getVisibleCharacterEntries', 'updateCharList');

    assert.match(gallerySource, /slice\(0, DIALOG_LIST_RENDER_LIMIT\)/);
    assert.ok((groupsSource.match(/slice\(0, DIALOG_LIST_RENDER_LIMIT\)/g) || []).length >= 2);
    assert.match(toolbarSource, /visibleEntries = getVisibleCharacterEntries\(\)/);
    assert.match(visibleSource, /slice\(0, CHARACTER_LIST_RENDER_LIMIT\)/);
    assert.match(source, /dc-select-visible[\s\S]*?getVisibleCharacterEntries\(\)/);
});

test('import disclosure denies permission changes and row signatures include remote-font policy', () => {
    const disclosureSource = functionSource('buildRemoteFontImportDisclosure', 'reviewAndApplyImport');
    const buildDisclosure = new Function(
        'settings',
        `${disclosureSource}; return buildRemoteFontImportDisclosure;`,
    )({ allowRemoteFonts: false });
    const disclosure = buildDisclosure();
    assert.match(disclosure, /cannot grant remote-font permission/);
    assert.match(disclosure, /enabled separately/);
    assert.doesNotMatch(disclosure, /type="checkbox"/);

    const signatureStart = source.indexOf('export function buildCharRowSignature(');
    const signatureEnd = source.indexOf('export function applyColorInputForElement(', signatureStart);
    const signatureSource = source.slice(signatureStart, signatureEnd);
    assert.match(signatureSource, /settings\.allowRemoteFonts\s*===\s*true/);
});

test('async UI mutations revalidate reviewed bindings before touching live targets', () => {
    const capture = functionSource('captureUiMutationContext', 'isUiMutationContextCurrent');
    const stylePack = functionSource('reviewAndApplyStylePack', 'renderStylePackRegistry');
    const removals = functionSource('confirmCharacterRemoval', 'runSelectedCharacterMutation');
    const avatarStart = source.indexOf("$('dc-avatar-color').onclick = async");
    const avatarEnd = source.indexOf("$('dc-save-card').onclick = async", avatarStart);
    const saveCardEnd = source.indexOf("$('dc-load-card').onclick = async", avatarEnd);
    const avatar = source.slice(avatarStart, avatarEnd);
    const saveCard = source.slice(avatarEnd, saveCardEnd);

    assert.match(capture, /persistMetadata:\s*false/);
    assert.doesNotMatch(capture, /\bgetStorageKey\(\)/);
    assert.ok(stylePack.indexOf('captureUiMutationContext()') < stylePack.indexOf('await openDecisionDialog'));
    assert.ok(stylePack.indexOf('isUiMutationContextCurrent(binding)') < stylePack.indexOf('await applyStylePackImport'));
    assert.ok(removals.indexOf('captureUiMutationContext()') < removals.indexOf('await confirmReviewedAction'));
    assert.ok(removals.indexOf('isUiMutationContextCurrent(binding)') < removals.indexOf('removeCharacterKeys'));
    assert.ok(removals.indexOf('currentCandidates = getCandidates()') < removals.indexOf('removeCharacterKeys'));
    assert.ok(avatar.indexOf('captureUiMutationContext()') < avatar.indexOf('await extractAvatarColor'));
    assert.ok(avatar.indexOf('isUiMutationContextCurrent(binding)') < avatar.indexOf('setEntryFromBaseColor'));
    assert.ok(saveCard.indexOf('captureUiMutationContext()') < saveCard.indexOf('await runImportAnalysis'));
    assert.ok(saveCard.indexOf('isUiMutationContextCurrent(binding)') < saveCard.indexOf('saveToCard()'));
    assert.match(source, /error:\s*'context_changed'/);
});

test('destructive confirmations bind reviewed tables, members, and preset input', () => {
    const controls = functionSource('bindSettingsPanelControls', 'bindConnectionProfileRefresh');
    const regen = controls.slice(controls.indexOf("$('dc-regen').onclick"), controls.indexOf("$('dc-rerandom-gradients').onclick"));
    const gradients = controls.slice(controls.indexOf("$('dc-rerandom-gradients').onclick"), controls.indexOf("$('dc-flip-theme').onclick"));
    const preset = controls.slice(controls.indexOf("$('dc-save-preset').onclick"), controls.indexOf("$('dc-load-preset').onclick"));
    const reset = controls.slice(controls.indexOf("$('dc-reset').onclick"), controls.indexOf('let searchFrame'));
    const group = functionSource('applyGroupProfileToExisting', 'getBulkStyleFieldMask');

    for (const [label, section, mutation] of [
        ['color regeneration', regen, 'regenerateAllColors()'],
        ['gradient regeneration', gradients, 'regenerateAllGradients()'],
        ['color reset', reset, 'createRestoreSnapshot()'],
    ]) {
        assert.ok(section.indexOf('captureUiMutationContext()') < section.indexOf('await confirmReviewedAction'), `${label} must capture before review`);
        assert.ok(section.indexOf('JSON.stringify(characterColors) !== reviewedTable') < section.indexOf(mutation), `${label} must revalidate before mutation`);
    }
    assert.ok(preset.indexOf('reviewedTable') < preset.indexOf('await confirmReviewedAction'));
    assert.ok(preset.indexOf("resolveColorPresetName($('dc-preset-name').value) !== name") < preset.indexOf('saveColorPreset()'));
    assert.ok(preset.indexOf('JSON.stringify([characterColors, groupProfiles]) !== reviewedTable') < preset.indexOf('saveColorPreset()'));
    assert.match(group, /const currentKeys = getCharacterKeysForGroup\(name\)/);
    assert.match(group, /currentKeys\.map\(key => \[key, characterColors\[key\]\?\.group/);
    assert.doesNotMatch(group, /characterColors\[key\] !== reviewedEntries/);
});

test('remaining reviewed chat and table actions reject context drift', () => {
    const scope = functionSource('handleStorageScopeChange', 'buildImportReviewDetails');
    const conflicts = functionSource('showColorConflictReport', 'buildSettingsPageNavHtml');
    const controls = functionSource('bindSettingsPanelControls', 'bindConnectionProfileRefresh');
    const seed = controls.slice(controls.indexOf("$('dc-gradient-new-seed').onclick"), controls.indexOf("$('dc-thought-symbols').oninput"));
    const recolor = controls.slice(controls.indexOf("$('dc-recolor').onclick"), controls.indexOf("$('dc-colorize').onclick"));
    const colorize = controls.slice(controls.indexOf("$('dc-colorize').onclick"), controls.indexOf("$('dc-verify-attr').onclick"));

    assert.ok(scope.indexOf('captureUiMutationContext()') < scope.indexOf('await openDecisionDialog'));
    assert.ok(scope.indexOf('isUiMutationContextCurrent(binding)') < scope.indexOf('await switchColorStorageScope'));
    assert.ok(scope.indexOf('targetFingerprint') < scope.indexOf('await switchColorStorageScope'));
    assert.ok(conflicts.indexOf('captureUiMutationContext()') < conflicts.indexOf('await openDecisionDialog'));
    assert.ok(conflicts.indexOf('isUiMutationContextCurrent(binding)') < conflicts.indexOf('repairPerceptualConflicts()'));
    assert.ok(seed.indexOf('captureUiMutationContext()') < seed.indexOf('await confirmReviewedAction'));
    assert.ok(seed.indexOf('isUiMutationContextCurrent(binding)') < seed.indexOf('createGradientRandomMasterSeed()'));
    assert.ok(recolor.indexOf('captureChatBinding()') < recolor.indexOf('await confirmReviewedAction'));
    assert.ok(recolor.indexOf('isUiChatBindingCurrent(chatBinding)') < recolor.indexOf('recolorAllMessages()'));
    assert.ok(colorize.indexOf('captureChatBinding()') < colorize.indexOf('await confirmReviewedAction'));
    assert.ok(colorize.indexOf('isUiChatBindingCurrent(chatBinding)') < colorize.indexOf("colorizeMessages('all')"));
});

test('style-library installs and force-bold refresh only the state they depend on', () => {
    const stylePack = functionSource('reviewAndApplyStylePack', 'renderStylePackRegistry');
    const controls = functionSource('bindSettingsPanelControls', 'bindConnectionProfileRefresh');
    const forceBold = controls.slice(controls.indexOf("$('dc-force-bold').onchange"), controls.indexOf("$('dc-allow-remote-fonts').onchange"));

    assert.match(stylePack, /const needsScope = fields\.applyAssignments === true \|\| fields\.applyAppearance === true/);
    assert.match(stylePack, /needsScope && !isUiMutationContextCurrent\(binding\)/);
    assert.match(forceBold, /updateLegend\(\)/);
    assert.match(forceBold, /renderNarratorEditor\(\)/);
});

test('UI validation and host refresh hooks use canonical existing APIs', () => {
    const alias = functionSource('handleAliasClick', 'handleFontClick');
    const group = functionSource('readValidatedGroupInput', 'handleGroupClick');
    const galleryPreview = functionSource('getReadableGradientPresetPreview', 'getGradientPresetCatalog');
    const galleryCatalog = functionSource('getGradientPresetCatalog', 'describeGradientGeometry');
    const profileRefresh = functionSource('bindConnectionProfileRefresh', 'createUI');
    const updateList = functionSource('updateCharList', 'setControlHelp');

    assert.ok(alias.indexOf('normalizeRegistryIdentityName(rawAlias)') < alias.indexOf('aliases.push(alias)'));
    assert.ok(alias.indexOf('isReservedCharacterIdentity(alias)') < alias.indexOf('aliases.push(alias)'));
    assert.match(group, /rawValue\s*&&\s*!group/);
    assert.match(galleryPreview, /applyGradientPreset\(preview, preset\)/);
    assert.match(galleryCatalog, /getReadableGradientPresetPreview\(preset\)/);
    assert.match(profileRefresh, /CONNECTION_PROFILE_LOADED/);
    assert.match(profileRefresh, /CONNECTION_PROFILE_CREATED/);
    assert.match(profileRefresh, /CONNECTION_PROFILE_UPDATED/);
    assert.match(profileRefresh, /CONNECTION_PROFILE_DELETED/);
    assert.doesNotMatch(profileRefresh, /setInterval|setTimeout/);
    assert.match(updateList, /narratorEditor\.dataset\.narratorSignature[^\n]*renderNarratorEditor\(\)/);
    assert.match(source, /getCandidates:\s*\(\) => Object\.keys\(characterColors\)\.filter\(k => \(characterColors\[k\]\?\.dialogueCount \|\| 0\) < min\)/);
});

test('storage manager archives against reviewed fingerprints', () => {
    const manager = functionSource('showStorageManager', 'syncProcessControlState');
    assert.ok(manager.indexOf('getStoredColorDataFingerprint(k)') < manager.indexOf('await openDecisionDialog'));
    assert.ok(manager.indexOf('reviewedFingerprints') < manager.indexOf('await archiveStoredColorData'));
    assert.match(manager, /await archiveStoredColorData\(selected, reviewedFingerprints\)/);
    assert.match(manager, /error === 'context_changed'/);
});

test('stale import analyses never replace a newer import review', () => {
    assert.match(source, /let importAnalysisRequestId = 0/);
    const guards = (source.match(/const requestId = \+\+importAnalysisRequestId/g) || []).length;
    assert.ok(guards >= 3, 'every import entry point must supersede in-flight reads');
    assert.match(source, /if \(requestId !== importAnalysisRequestId\) return/);
});

test('a superseded attribution editor stops the review flow', () => {
    const editor = functionSource('editAndAcceptAttributionReview', 'acceptAttributionReviewFromUi');
    assert.match(editor, /if \(decision\.value == null\) return null;/);
    const dialogStart = source.indexOf('function showAttributionReviewDialog(');
    const dialog = source.slice(dialogStart, source.indexOf('\nfunction ', dialogStart + 10));
    assert.match(dialog, /editedSpeaker === null \|\| !isAttributionReviewScopeCurrent\(reviewScope\)\) break/);
    assert.match(dialog, /if \(editedSpeaker\) await acceptAttributionReviewFromUi/);
});

test('direct checkbox changes invalidate the row reuse signature', () => {
    // Selecting a row through its checkbox changes the visible checked state
    // outside updateCharList; a stale data-dc-sig would make the next refresh
    // reuse the row as-is and leave it mismatched with the toolbar count.
    assert.match(source, /t\.closest\('\.dc-char'\)\?\.removeAttribute\('data-dc-sig'\)/);
});

test('attribution review flows stay bound to the chat they started in', () => {
    assert.match(source, /function captureAttributionReviewScope\(\)/);
    assert.match(source, /function isAttributionReviewScopeCurrent\(scope\)/);
    const dialogStart = source.indexOf('function showAttributionReviewDialog(');
    const dialog = source.slice(dialogStart,
        source.indexOf('\nfunction ', dialogStart + 10));
    assert.match(dialog, /const reviewScope = captureAttributionReviewScope\(\)/);
    assert.match(dialog, /isAttributionReviewScopeCurrent\(reviewScope\)/);
    const high = functionSource('acceptAllHighConfidenceAttributionReviews', 'acceptAllProposedAttributionReviews');
    assert.match(high, /const reviewScope = captureAttributionReviewScope\(\)/);
    assert.match(high, /isAttributionReviewScopeCurrent\(reviewScope\)/);
    const proposed = functionSource('acceptAllProposedAttributionReviews', 'showAttributionReviewDialog');
    assert.match(proposed, /const reviewScope = captureAttributionReviewScope\(\)/);
    assert.match(proposed, /isAttributionReviewScopeCurrent\(reviewScope\)/);
});

test('the gradient gallery keeps the chosen Apply target across rebuilds', () => {
    // Rebuilding the gallery must restore the chosen destination, or a search
    // or preset click silently switches Apply back to the selected rows.
    assert.match(source, /let gradientGalleryTarget = 'selected';/);
    assert.match(source, /targetSelect\.value = gradientGalleryTarget;/);
    assert.match(source, /targetSelect\.addEventListener\('change', event => \{ gradientGalleryTarget = event\.target\.value; \}\)/);
});

test('a focused editor cannot survive into a different colour table', () => {
    const update = functionSource('updateCharList', 'setControlHelp');
    assert.match(update, /const tableKey = getStorageKeyForScope\(getCurrentStorageScope\(\), \{ persistMetadata: false \}\)/);
    assert.match(update, /const tableChanged = lastRenderedTableKey !== tableKey;/);
    assert.match(update, /node && !tableChanged && \(node\.getAttribute/);
});

test('history restore resyncs the group profile editor fields', () => {
    const refresh = functionSource('refreshGroupProfileControls', 'saveGroupProfileFromEditor');
    assert.match(refresh, /nameInput\.dataset\.profileSignature !== signature/);
    assert.match(refresh, /syncGroupProfileEditor\(\)/);
    assert.match(functionSource('updateCharList', 'setControlHelp'), /refreshGroupProfileControls\(\)/);
    assert.match(functionSource('syncUIWithSettings', 'formatColorVisionMode'), /refreshGroupProfileControls\(\)/);
});

test('Enter in the colour code field commits once via the change handler', () => {
    const branchStart = source.indexOf("contains('dc-color-hex') && e.key === 'Enter'");
    assert.ok(branchStart >= 0, 'hex field Enter branch missing');
    const branch = source.slice(branchStart, branchStart + 420);
    assert.ok(branch.includes('t.blur();'), 'Enter must move focus out so the change handler commits once');
    assert.ok(!branch.includes('applyHexInputForElement'),
        'Enter must not commit itself or a duplicate history snapshot is pushed');
});

test('a font-only copy never clears a target seeded gradient on paste', () => {
    // The paste options' Gradient checkbox alone must not erase a generator
    // that was never copied: a font-only copy leaves the clipboard generator
    // null, and nulling every target's seeded generator would discard its
    // seed and variation number.
    assert.match(source, /let copiedGradientFieldIncluded = false;/);
    assert.match(source, /copiedGradientFieldIncluded = !!\(fieldMask & CHARACTER_STYLE_FIELD_MASKS\.GRADIENT\);/);
    assert.match(source, /!copiedGradientFieldIncluded\) return result;/);
});

test('character-name validation checks the normalised name for forbidden punctuation', () => {
    // Full-width punctuation NFKC-normalises into the forbidden ASCII set
    // (for example the full-width comma becomes ','). Validating only the raw
    // input would let 'Alice,Jr' be stored and later corrupt the colour
    // metadata prompt block.
    assert.match(source, /\.test\(name\.trim\(\)\.normalize\('NFKC'\)\)/);
    assert.match(source, /\.test\(rawName\.normalize\('NFKC'\)\)/);
});

test('narration editor rebuilds restore focus to the equivalent control', () => {
    // Every committed narration change rebuilds the editor DOM; keyboard
    // editing (Space, arrow keys) must land back on the same control, not on
    // the page body.
    assert.match(source, /const focusedElement = host\.contains\(document\.activeElement\)/);
    assert.match(source, /const focusedId = focusedElement\?\.id/);
    assert.match(source, /if \(focusedId\) host\.querySelector\(/);
    assert.match(source, /focusedStop\.className\.trim\(\)\.split\(/);
});

test('jump to message exits fullscreen before revealing the chat', () => {
    // Fullscreen covers the chat and marks it non-interactive; the jump must
    // exit first or the message stays covered and cannot be focused.
    assert.match(source, /if \(isSettingsFullscreen\(\)\) exitSettingsFullscreen\(\);/);
    const jumpStart = source.indexOf('function jumpToAttributionReviewMessage(');
    const jump = source.slice(jumpStart, source.indexOf('\nfunction ', jumpStart + 10));
    assert.ok(jump.length > 0, 'jump function missing');
    assert.match(jump, /isSettingsFullscreen\(\)\) exitSettingsFullscreen\(\)/);
});

test('tool-call repair shares the busy and disabled control state', () => {
    assert.match(source, /button\.setAttribute\('aria-busy', 'true'\);/);
    assert.match(source, /button\.removeAttribute\('aria-busy'\);/);
    const repairStart = source.indexOf("$('dc-repair-tool-calls').onclick");
    assert.ok(repairStart >= 0, 'repair handler missing');
    const repair = source.slice(repairStart, repairStart + 700);
    assert.match(repair, /syncProcessControlState\(\);/);
});

test('style-pack name validation happens before the dialog is closed', () => {
    const dialog = functionSource('openDecisionDialog', 'confirmReviewedAction');
    assert.match(dialog, /if \(!field\.reportValidity\(\)\) return/);
    assert.ok(dialog.indexOf('field.reportValidity()') < dialog.indexOf('close(button.dataset.dialogValue)'));
    assert.match(source, /value: 'build', label: 'Build pack', primary: true, validate: true/);
    assert.doesNotMatch(source, /previousForm = decision\.formValues/);
});

test('error text has native contrast fallbacks and checkbox marks use native rendering', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(css, /#dc-ext \.dc-field-error \{[^}]*background: Canvas;[^}]*color: CanvasText;/);
    assert.match(css, /@supports \(color: contrast-color\(red\)\) and \(color: rgb\(from red r g b\)\)/);
    assert.match(css, /color: contrast-color\(var\(--dc-danger-surface\)\)/);
    assert.match(css, /--dc-danger-surface: [^;]*rgb\(from var\(--SmartThemeBlurTintColor, #202328\) r g b \/ 1\)/);
    assert.match(css, /input\[type="checkbox"\] \{[^}]*appearance: auto !important;/);
    assert.match(css, /input\[type="checkbox"\]::after \{\s*content: none !important;/);
});

test('inline Escape handlers consume the key before closing editors', () => {
    const escapes = source.match(/ev\.preventDefault\(\);\s*ev\.stopPropagation\(\);\s*close\(\);/g) || [];
    assert.ok(escapes.length >= 4, 'all inline editors must consume Escape before closing');
});

test('context-change safety refusals use a non-suppressible warning', () => {
    const start = source.indexOf('function notifyUiContextChanged(');
    const end = source.indexOf('\nfunction ', start + 10);
    const helper = source.slice(start, end);
    assert.match(helper, /toast\.warning\(message\)/);
    assert.doesNotMatch(helper, /toast\.info\(message\)/);
});

test('custom gradient directions are created when an exact angle needs them', () => {
    const start = source.indexOf('function synchronizeGradientEditorFromEntry(');
    const end = source.indexOf('\nfunction ', start + 10);
    const helper = source.slice(start, end);
    assert.match(helper, /document\.createElement\('option'\)/);
    assert.match(helper, /directionSelect\.appendChild\(customOption\)/);
    assert.match(helper, /customOption\.textContent/);
});

test('card review flows capture their opener before async reads', () => {
    const saveStart = source.indexOf("$('dc-save-card').onclick");
    const loadStart = source.indexOf("$('dc-load-card').onclick");
    const save = source.slice(saveStart, loadStart);
    const load = source.slice(loadStart, source.indexOf("$('dc-undo').onclick", loadStart));
    assert.match(save, /const opener = e\.currentTarget/);
    assert.match(save, /\bopener,/);
    assert.match(load, /const opener = e\.currentTarget/);
    assert.match(load, /reviewAndApplyImport\(analysis, 'card', opener\)/);
});

test('fullscreen hides and restores the floating legend', () => {
    const enterStart = source.indexOf('function enterSettingsFullscreen(');
    const enter = source.slice(enterStart, source.indexOf('\nfunction ', enterStart + 10));
    const exitStart = source.indexOf('function exitSettingsFullscreen(');
    const exit = source.slice(exitStart, source.indexOf('\nfunction ', exitStart + 10));
    assert.match(enter, /legend\.style\.display = 'none'/);
    assert.match(exit, /updateLegend\(\)/);
});
