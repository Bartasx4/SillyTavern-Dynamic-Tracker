import { getTrackerStore } from './state.js';

function normalizeRole(role) {
    if (role === 'system' || role === 'user' || role === 'assistant') {
        return role;
    }

    return 'assistant';
}

function toSyntheticMessageFlags(role) {
    if (role === 'system') {
        return {
            is_user: false,
            is_system: true,
            name: 'System',
        };
    }

    if (role === 'user') {
        return {
            is_user: true,
            is_system: false,
            name: 'Dynamic Tracker',
        };
    }

    return {
        is_user: false,
        is_system: false,
        name: 'Dynamic Tracker',
    };
}

function flattenVisualNodes(nodes = []) {
    return Array.isArray(nodes) ? nodes.filter(Boolean) : [];
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function labelFor(node) {
    return String(node?.name || node?.id || 'Field').trim() || 'Field';
}

function toInlineValue(value) {
    if (Array.isArray(value)) {
        const parts = value
            .map((item) => String(item ?? '').trim())
            .filter(Boolean);
        return parts.join(', ') || '-';
    }

    if (value === undefined || value === null || value === '') {
        return '-';
    }

    return String(value);
}

function findTitleChild(children = []) {
    for (const child of flattenVisualNodes(children)) {
        if (child.kind === 'group') {
            const nested = findTitleChild(child.children || []);
            if (nested) {
                return nested;
            }
            continue;
        }

        if (child.title) {
            return child;
        }
    }

    return null;
}

function appendBlock(lines, block, separated = false) {
    if (!Array.isArray(block) || !block.length) {
        return;
    }

    if (separated && lines.length && lines[lines.length - 1] !== '') {
        lines.push('');
    }

    lines.push(...block);
}

function formatNodeLines(nodes, data, depth = 0, hiddenTitleUid = null) {
    const lines = [];

    for (const node of flattenVisualNodes(nodes)) {
        if (hiddenTitleUid && node.uid === hiddenTitleUid) {
            continue;
        }

        if (node.kind === 'group') {
            appendBlock(lines, formatNodeLines(node.children || [], data, depth, hiddenTitleUid), false);
            continue;
        }

        const indent = '\t'.repeat(depth);
        const label = labelFor(node);
        const value = data?.[node.id];

        if (node.type === 'object') {
            const nestedValue = isPlainObject(value) ? value : {};
            const block = [`${indent}${label}:`];
            block.push(...formatNodeLines(node.children || [], nestedValue, depth + 1));
            appendBlock(lines, block, true);
            continue;
        }

        if (node.type === 'array') {
            const items = Array.isArray(value) ? value : [];
            const childNodes = flattenVisualNodes(node.children || []);

            if (!childNodes.length) {
                lines.push(`${indent}${label}: ${toInlineValue(items)}`);
                continue;
            }

            const titleChild = findTitleChild(childNodes);
            const block = [];

            // If no child field is marked as "Title", do NOT generate artificial headings like "<ArrayName> #1".
            // Render a single container line and indent the fields for each array item.
            if (!titleChild) {
                block.push(`${indent}${label}:`);
            }

            if (!items.length) {
                block.push(titleChild ? `${indent}${label}: -` : `${indent}\t-`);
            } else {
                items.forEach((item, index) => {
                    if (index > 0) {
                        block.push('');
                    }

                    const safeItem = isPlainObject(item) ? item : {};

                    if (titleChild) {
                        const fallbackTitle = `${label} #${index + 1}`;
                        const heading = String(safeItem?.[titleChild.id] ?? '').trim() || fallbackTitle;
                        block.push(`${indent}${heading}:`);

                        const nestedLines = formatNodeLines(node.children || [], safeItem, depth + 1, titleChild?.uid || null);
                        if (nestedLines.length) {
                            block.push(...nestedLines);
                        } else {
                            block.push(`${indent}\t-`);
                        }
                        return;
                    }

                    const nestedLines = formatNodeLines(node.children || [], safeItem, depth + 1, null);
                    if (nestedLines.length) {
                        block.push(...nestedLines);
                    } else {
                        block.push(`${indent}\t-`);
                    }
                });
            }

            appendBlock(lines, block, true);
            continue;
        }

        lines.push(`${indent}${label}: ${toInlineValue(value)}`);
    }

    return lines;
}

function formatTrackerAsText(trackerStore) {
    const bodyLines = formatNodeLines(trackerStore?.fields || [], trackerStore?.data || {}, 0);
    if (!bodyLines.length) {
        bodyLines.push('-');
    }

    return `Status:[\n${bodyLines.join('\n')}\n]`;
}

function formatTrackerAsJson(trackerStore) {
    return `Dynamic Tracker:\n\`\`\`json\n${JSON.stringify(trackerStore?.data || {}, null, 2)}\n\`\`\``;
}

export function createSyntheticTrackerMessage(trackerStore, options = {}) {
    const role = normalizeRole(options.role);
    const format = options.format === 'json' ? 'json' : 'text';
    const flags = toSyntheticMessageFlags(role);

    return {
        ...flags,
        send_date: Date.now(),
        mes: format === 'json'
            ? formatTrackerAsJson(trackerStore)
            : formatTrackerAsText(trackerStore),
        extra: {
            __dynamicTrackerSynthetic: true,
        },
    };
}

export function buildTrackerInjectionMessages(chatMessages, limit, options = {}) {
    if (!Array.isArray(chatMessages) || limit === undefined || limit === null) {
        return;
    }

    // NOTE: Dynamic Tracker semantics: 0 means "include all trackers".
    let remaining = Number(limit);
    if (!Number.isFinite(remaining)) {
        remaining = 0;
    }

    if (remaining < 0) {
        return;
    }

    if (remaining === 0) {
        remaining = Number.POSITIVE_INFINITY;
    }

    for (let index = chatMessages.length - 2; index >= 0 && remaining > 0; index -= 1) {
        const message = chatMessages[index];
        const tracker = getTrackerStore(message);

        if (!tracker?.data) {
            continue;
        }

        chatMessages.splice(index + 1, 0, createSyntheticTrackerMessage(tracker, options));
        remaining -= 1;
    }
}
