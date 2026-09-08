import assert from 'node:assert/strict';
import test from 'node:test';

import { getNarratorVisual, getTransientNarratorCount, normalizeNarratorStyle, setTransientNarratorCount } from '../src/narrator-style.js';

test('narrator normalization and visual derivation preserve supported typography', () => {
    const style = normalizeNarratorStyle({
        enabled: true,
        baseColor: '#123456',
        font: '  Noto   Serif  ',
        style: 'bold italic',
    });
    const visual = getNarratorVisual({ narratorStyle: style });

    assert.equal(style.font, 'Noto Serif');
    assert.equal(style.style, 'bold italic');
    assert.equal(visual.font, 'Noto Serif');
    assert.equal(visual.style, 'bold italic');
});

test('unsupported narrator typography is rejected without discarding valid fields', () => {
    const style = normalizeNarratorStyle({
        enabled: true,
        baseColor: '#abcdef',
        font: '<script>Mono</script>',
        style: 'blinking',
    });

    assert.equal(style.font, 'scriptMonoscript');
    assert.equal(style.style, '');
    assert.equal(style.baseColor, '#abcdef');
});

test('an unknown narration count stays unknown instead of becoming zero', () => {
    setTransientNarratorCount(12, 'source-a');
    assert.equal(getTransientNarratorCount('source-a'), 12);
    setTransientNarratorCount(null, 'source-a');
    assert.equal(getTransientNarratorCount('source-a'), null, 'unknown must not read as zero');
    setTransientNarratorCount(0, 'source-a');
    assert.equal(getTransientNarratorCount('source-a'), 0, 'a genuine zero stays zero');
    assert.equal(getTransientNarratorCount('source-b'), null, 'counts stay isolated per source');
});
