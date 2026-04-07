export const MODULE_NAME = 'dynamic_tracker';
export const EXTENSION_TITLE = 'Dynamic Tracker';
export const ROOT_CONTAINER_ID = '__root__';
export const VERSION = '1.3.8';

export const AUTO_MODE = Object.freeze({
    NONE: 'none',
    RESPONSES: 'responses',
    INPUTS: 'inputs',
    BOTH: 'both',
});

export const TRACKER_MESSAGE_ROLES = Object.freeze([
    'assistant',
    'system',
    'user',
]);

export const FIELD_TYPES = Object.freeze([
    'string',
    'number',
    'integer',
    'boolean',
    'object',
    'array',
]);

export function generateUid(prefix = 'dt') {
    const randomPart = Math.random().toString(36).slice(2, 10);
    return `${prefix}_${Date.now().toString(36)}_${randomPart}`;
}

export function createFieldNode(overrides = {}) {
    return {
        uid: overrides.uid || generateUid('field'),
        kind: 'field',
        id: '',
        name: '',
        type: 'string',
        description: '',
        required: false,
        collapsible: false,
        title: false,
        children: [],
        ...overrides,
        children: Array.isArray(overrides.children)
            ? overrides.children.map(cloneTrackerNode)
            : [],
    };
}

export function createGroupNode(overrides = {}) {
    return {
        uid: overrides.uid || generateUid('group'),
        kind: 'group',
        name: '',
        children: [],
        ...overrides,
        children: Array.isArray(overrides.children)
            ? overrides.children.map(cloneTrackerNode)
            : [],
    };
}

export function cloneTrackerNode(node) {
    if (!node || typeof node !== 'object') {
        return createFieldNode();
    }

    if (node.kind === 'group') {
        return createGroupNode(node);
    }

    return createFieldNode(node);
}

export function createDefaultFieldTree() {
    return [
        createFieldNode({
            id: 'time',
            name: 'Czas',
            type: 'string',
            description: 'Aktualny czas sceny w formacie HH:MM:SS; YYYY/MM/DD (Dzień tygodnia)',
            required: true,
        }),
        createFieldNode({
            id: 'weather',
            name: 'Pogoda',
            type: 'string',
            description: 'Aktualne warunki pogodowe i temperatura',
            required: true,
        }),
        createFieldNode({
            id: 'inventory',
            name: 'Inventory',
            type: 'string',
            description: 'Lista przedmiotów, które gracz ma przy sobie, oddzielona przecinkami. Jeżeli brak, użyj myślnika.',
            required: true,
        }),
        createGroupNode({
            name: 'Szczegóły',
            children: [
                createFieldNode({
                    id: 'charactersPresent',
                    name: 'Obecni',
                    type: 'array',
                    description: 'Lista postaci obecnych w scenie',
                    required: true,
                }),
                createFieldNode({
                    id: 'sceneSummary',
                    name: 'Podsumowanie',
                    type: 'string',
                    description: 'Bardzo krótkie, rzeczowe podsumowanie aktualnej sceny',
                    required: true,
                }),
            ],
        }),
    ];
}

export const DEFAULT_PROMPT = `### Kluczowe instrukcje:
1. Zwróć **pełny tracker** dla bieżącej sceny.
2. Uzupełnij wszystkie pola wymagane.
3. Jeżeli jakaś informacja nie została podana wprost, użyj najbardziej rozsądnego wniosku z kontekstu.
4. Odpowiedź ma być wyłącznie poprawnym JSON-em zgodnym ze schematem.
5. Wszystkie wartości tekstowe zapisuj po polsku.
6. Pisz zwięźle, faktami, bez stylu opowieści.

Schemat JSON, według którego masz odpowiedzieć:
{{json_fields}}`;

export function createDefaultPreset() {
    return {
        name: 'Default',
        prompt: DEFAULT_PROMPT,
        fields: createDefaultFieldTree(),
    };
}

export function createDefaultSettings() {
    return {
        version: VERSION,
        enabled: true,
        onlyShow: false,
        includeInWorldInfoScanning: false,
        autoMode: AUTO_MODE.NONE,
        schemaPreset: 'default',
        schemaPresets: {
            default: createDefaultPreset(),
        },
        maxResponseTokens: 600,
        includeLastXMessages: 0,
        // 0 means "all trackers" (not "none")
        includeLastXTrackerMessages: 1,
        trackerMessageRole: 'assistant',
    };
}
