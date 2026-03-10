import {
    MODULE_NAME,
    ROOT_CONTAINER_ID,
    TRACKER_MESSAGE_ROLES,
    createDefaultFieldTree,
    createDefaultPreset,
    createDefaultSettings,
    cloneTrackerNode,
} from './config.js';

function normalizePreset(preset, fallbackName = 'Preset') {
    const safePreset = preset && typeof preset === 'object' ? preset : {};
    return {
        name: typeof safePreset.name === 'string' && safePreset.name.trim()
            ? safePreset.name.trim()
            : fallbackName,
        prompt: typeof safePreset.prompt === 'string'
            ? safePreset.prompt
            : createDefaultPreset().prompt,
        fields: Array.isArray(safePreset.fields)
            ? safePreset.fields.map(cloneTrackerNode)
            : createDefaultFieldTree(),
    };
}

export function getContext() {
    return SillyTavern.getContext();
}

export function ensureSettings() {
    const context = getContext();
    context.extensionSettings[MODULE_NAME] = context.extensionSettings[MODULE_NAME] || {};
    const settings = context.extensionSettings[MODULE_NAME];
    const defaults = createDefaultSettings();

    settings.version = settings.version || defaults.version;
    settings.autoMode = typeof settings.autoMode === 'string' ? settings.autoMode : defaults.autoMode;
    settings.schemaPreset = typeof settings.schemaPreset === 'string' ? settings.schemaPreset : defaults.schemaPreset;
    settings.maxResponseTokens = Number.isFinite(Number(settings.maxResponseTokens))
        ? Number(settings.maxResponseTokens)
        : defaults.maxResponseTokens;
    settings.includeLastXMessages = Number.isFinite(Number(settings.includeLastXMessages))
        ? Number(settings.includeLastXMessages)
        : defaults.includeLastXMessages;
    settings.includeLastXTrackerMessages = Number.isFinite(Number(settings.includeLastXTrackerMessages))
        ? Number(settings.includeLastXTrackerMessages)
        : defaults.includeLastXTrackerMessages;
    settings.trackerMessageRole = TRACKER_MESSAGE_ROLES.includes(settings.trackerMessageRole)
        ? settings.trackerMessageRole
        : defaults.trackerMessageRole;

    if (!settings.schemaPresets || typeof settings.schemaPresets !== 'object' || Array.isArray(settings.schemaPresets)) {
        settings.schemaPresets = {};
    }

    const normalizedPresets = {};
    for (const [key, preset] of Object.entries(settings.schemaPresets)) {
        normalizedPresets[key] = normalizePreset(preset, preset?.name || key);
    }

    if (!normalizedPresets.default) {
        normalizedPresets.default = createDefaultPreset();
    }

    settings.schemaPresets = normalizedPresets;

    if (!settings.schemaPresets[settings.schemaPreset]) {
        settings.schemaPreset = Object.keys(settings.schemaPresets)[0] || 'default';
    }

    return settings;
}

export function saveSettings() {
    getContext().saveSettingsDebounced();
}

export function getSettings() {
    return ensureSettings();
}

export function getActivePreset(settings = getSettings()) {
    if (!settings.schemaPresets[settings.schemaPreset]) {
        settings.schemaPreset = Object.keys(settings.schemaPresets)[0] || 'default';
    }

    return settings.schemaPresets[settings.schemaPreset];
}

export function createPresetKey(baseName = 'preset') {
    const cleaned = String(baseName)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'preset';

    const settings = getSettings();
    let suffix = 1;
    let candidate = cleaned;

    while (settings.schemaPresets[candidate]) {
        suffix += 1;
        candidate = `${cleaned}_${suffix}`;
    }

    return candidate;
}

function structuredCloneSafe(value) {
    try {
        // eslint-disable-next-line no-undef
        return structuredClone(value);
    } catch {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return value;
        }
    }
}

function getSwipeIndex(message) {
    const idx = message?.swipe_id;
    const num = Number(idx);
    return Number.isInteger(num) ? num : null;
}

function ensureSwipeInfoSlot(message, swipeIndex) {
    if (!message) return null;
    message.swipe_info = Array.isArray(message.swipe_info) ? message.swipe_info : [];
    message.swipe_info[swipeIndex] = message.swipe_info[swipeIndex] || {};
    message.swipe_info[swipeIndex].extra = message.swipe_info[swipeIndex].extra || {};
    return message.swipe_info[swipeIndex];
}

/**
 * Returns the tracker store for the currently active swipe (if swipes are present).
 * Falls back to legacy message.extra storage only for messages without swipes.
 */
export function getTrackerStore(message) {
    if (!message) return null;

    const swipeIndex = getSwipeIndex(message);
    const hasSwipeInfo = Array.isArray(message.swipe_info);

    if (swipeIndex !== null && hasSwipeInfo) {
        const swipeSlot = message.swipe_info?.[swipeIndex];
        const swipeStore = swipeSlot?.extra?.[MODULE_NAME] || null;
        if (swipeStore) {
            return swipeStore;
        }

        // One-time migration (for chats created before per-swipe storage):
        // If there are NO swipe-specific stores at all, but legacy message.extra exists,
        // attach it to the current swipe so the tracker remains visible.
        const anySwipeStore = (message.swipe_info || []).some((entry) => entry?.extra?.[MODULE_NAME]);
        if (!anySwipeStore) {
            const legacy = message?.extra?.[MODULE_NAME] || null;
            if (legacy) {
                const slot = ensureSwipeInfoSlot(message, swipeIndex);
                if (slot) {
                    slot.extra[MODULE_NAME] = structuredCloneSafe(legacy);
                }
                return legacy;
            }
        }

        // IMPORTANT: no fallback to message.extra for other swipes.
        return null;
    }

    return message?.extra?.[MODULE_NAME] || null;
}

/**
 * Stores the tracker store on the currently active swipe slot (swipe_info),
 * so each swipe can have its own tracker.
 */
export function setTrackerStore(message, store) {
    if (!message) return;

    const swipeIndex = getSwipeIndex(message);

    if (swipeIndex !== null) {
        const slot = ensureSwipeInfoSlot(message, swipeIndex);
        if (slot) {
            slot.extra[MODULE_NAME] = structuredCloneSafe(store);
        }
    }

    // Mirror on message.extra for backward compatibility/current swipe convenience.
    message.extra = message.extra || {};
    message.extra[MODULE_NAME] = structuredCloneSafe(store);
}

/**
 * Clears the tracker store from the current swipe slot (if present) and from legacy message.extra.
 */
export function clearTrackerStore(message) {
    if (!message) return;

    const swipeIndex = getSwipeIndex(message);

    if (swipeIndex !== null && Array.isArray(message.swipe_info)) {
        const slot = message.swipe_info?.[swipeIndex];
        if (slot?.extra?.[MODULE_NAME]) {
            delete slot.extra[MODULE_NAME];
        }
    }

    if (message?.extra?.[MODULE_NAME]) {
        delete message.extra[MODULE_NAME];
    }
}

export function getMessageSlice(messages, targetIndex, includeLastXMessages) {
    const endIndex = Math.max(0, Math.min(targetIndex, messages.length - 1));
    const startIndex = includeLastXMessages === 0
        ? 0
        : Math.max(0, endIndex - includeLastXMessages + 1);

    return messages.slice(startIndex, endIndex + 1);
}

export { ROOT_CONTAINER_ID };
