import {
    normalizeHexColor,
    normalizeTextOutlineWidth
} from './utils.js';

export const TEXT_OUTLINE_CLASS = 'dc-text-outline';

function buildOutlineFilter(color, width){
    const hex = normalizeHexColor(color, '#000000');
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);

    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
        <filter id="outline" x="-50%" y="-50%" width="200%" height="200%">
            <feMorphology in="SourceAlpha" operator="dilate" radius="${width}" result="expanded"/>
            <feFlood flood-color="rgb(${r},${g},${b})" result="color"/>
            <feComposite in="color" in2="expanded" operator="in" result="outline"/>
            <feMerge>
                <feMergeNode in="outline"/>
                <feMergeNode in="SourceGraphic"/>
            </feMerge>
        </filter>
    </svg>`;

    return `url("data:image/svg+xml,${encodeURIComponent(svg)}#outline")`;
}

export function getTextOutlineState(entry) {
    return {
        enabled: entry?.outlineEnabled === true,
        color: normalizeHexColor(
            entry?.outlineColor,
            '#000000'
        ),
        width: normalizeTextOutlineWidth(
            entry?.outlineWidth,
            1
        ),
    };
}

export function clearTextOutline(element){
    if (!element) return false;

    let changed = false;

    if (element.classList.contains(TEXT_OUTLINE_CLASS)){
        element.classList.remove(TEXT_OUTLINE_CLASS);
        changed = true;
    }

    if (element.style.getPropertyValue('--dc-text-outline-filter')){
        element.style.removeProperty('--dc-text-outline-filter');
        changed = true;
    }

    return changed;
}

export function applyTextOutline(element, entry){
    if (!element) return false;

    const outline = getTextOutlineState(entry);
    if (!outline.enabled) return clearTextOutline(element);

    let changed = false;

    if (!element.classList.contains(TEXT_OUTLINE_CLASS)){
        element.classList.add(TEXT_OUTLINE_CLASS);
        changed = true;
    }

    const filter = buildOutlineFilter(outline.color, outline.width);

    if (element.style.getPropertyValue('--dc-text-outline-filter') !== filter){
        element.style.setProperty('--dc-text-outline-filter', filter);
        changed = true;
    }

    return changed;
}