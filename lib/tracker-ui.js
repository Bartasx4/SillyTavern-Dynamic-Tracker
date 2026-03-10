import { MODULE_NAME, EXTENSION_TITLE } from './config.js';
import { getTrackerStore } from './state.js';

let wrapperTemplate = `
<div class="dynamic-tracker-wrapper">
    <details open class="dt-root-shell">
        <summary><span>{{title}}</span></summary>
        <div class="dt-root-content">{{content}}</div>
    </details>
</div>
<hr class="dt-divider">
`.trim();

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function fieldValue(data, key) {
    if (!data || typeof data !== 'object') {
        return undefined;
    }

    return data[key];
}

function flattenVisualNodes(nodes = []) {
    return Array.isArray(nodes) ? nodes.filter(Boolean) : [];
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
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

function renderNodeList(nodes, data, options = {}) {
    let html = '';
    let rows = [];

    const flushRows = () => {
        if (!rows.length) {
            return;
        }

        html += `
            <table class="dt-table">
                <tbody>${rows.join('')}</tbody>
            </table>
        `;
        rows = [];
    };

    for (const node of flattenVisualNodes(nodes)) {
        if (options.hiddenTitleUid && node.uid === options.hiddenTitleUid) {
            continue;
        }

        if (node.kind === 'group') {
            flushRows();
            html += renderGroup(node, data, options);
            continue;
        }

        const primitiveArray = node.type === 'array' && !(node.children || []).length;
        const primitiveField = node.type !== 'object' && (node.type !== 'array' || primitiveArray);

        if (primitiveField && !node.collapsible) {
            rows.push(renderPrimitiveRow(node, data));
            continue;
        }

        flushRows();
        html += renderComplexField(node, data, options);
    }

    flushRows();

    if (!html.trim()) {
        return '<div class="dt-empty">Brak danych trackera.</div>';
    }

    return html;
}

function renderPrimitiveRow(node, data) {
    const value = fieldValue(data, node.id);

    if (node.type === 'array') {
        const joined = Array.isArray(value)
            ? value.map((item) => escapeHtml(item)).join(', ')
            : '';
        return `
            <tr>
                <td class="dt-label">${escapeHtml(node.name || node.id)}:</td>
                <td class="dt-value">${joined}</td>
            </tr>
        `;
    }

    return `
        <tr>
            <td class="dt-label">${escapeHtml(node.name || node.id)}:</td>
            <td class="dt-value">${escapeHtml(value ?? '')}</td>
        </tr>
    `;
}

function renderGroup(node, data, options) {
    const content = renderNodeList(node.children || [], data, options);

    return `
        <details class="dt-group">
            <summary><span>${escapeHtml(node.name || 'Group')}</span></summary>
            <div class="dt-group-body">${content}</div>
        </details>
    `;
}

function renderComplexField(node, data, options) {
    if (node.type === 'object') {
        return renderObjectField(node, data, options);
    }

    if (node.type === 'array') {
        return renderArrayField(node, data, options);
    }

    return `
        <div class="dt-section">
            <div class="dt-section-title">${escapeHtml(node.name || node.id)}</div>
            <div class="dt-section-body">${escapeHtml(fieldValue(data, node.id) ?? '')}</div>
        </div>
    `;
}

function renderObjectField(node, data, options) {
    const value = fieldValue(data, node.id);
    const objectValue = isPlainObject(value) ? value : {};
    const content = renderNodeList(node.children || [], objectValue, options);

    if (node.collapsible) {
        return `
            <details class="dt-section">
                <summary><span>${escapeHtml(node.name || node.id)}</span></summary>
                <div class="dt-section-body">${content}</div>
            </details>
        `;
    }

    return `
        <div class="dt-section">
            <div class="dt-section-title">${escapeHtml(node.name || node.id)}</div>
            <div class="dt-section-body">${content}</div>
        </div>
    `;
}

function renderArrayField(node, data, options) {
    const value = fieldValue(data, node.id);
    const items = Array.isArray(value) ? value : [];
    const childNodes = flattenVisualNodes(node.children || []);

    if (!childNodes.length) {
        const listContent = items.length
            ? `<ul class="dt-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
            : '<div class="dt-empty">Brak elementów.</div>';

        if (node.collapsible) {
            return `
                <details class="dt-section">
                    <summary><span>${escapeHtml(node.name || node.id)}</span></summary>
                    <div class="dt-section-body">${listContent}</div>
                </details>
            `;
        }

        return `
            <div class="dt-section">
                <div class="dt-section-title">${escapeHtml(node.name || node.id)}</div>
                <div class="dt-section-body">${listContent}</div>
            </div>
        `;
    }

    const titleChild = findTitleChild(childNodes);
    const itemHtml = items.length
        ? items.map((item, index) => renderArrayItem(node, item, index, titleChild, options)).join('')
        : '<div class="dt-empty">Brak elementów.</div>';

    if (node.collapsible) {
        return `
            <details class="dt-section">
                <summary><span>${escapeHtml(node.name || node.id)}</span></summary>
                <div class="dt-section-body">
                    <div class="dt-array-list">${itemHtml}</div>
                </div>
            </details>
        `;
    }

    return `
        <div class="dt-section">
            <div class="dt-section-title">${escapeHtml(node.name || node.id)}</div>
            <div class="dt-section-body">
                <div class="dt-array-list">${itemHtml}</div>
            </div>
        </div>
    `;
}

function renderArrayItem(node, value, index, titleChild, options) {
    const item = isPlainObject(value) ? value : {};
    const fallbackTitle = `${node.name || node.id} #${index + 1}`;
    // Only render an item heading if a child field is marked as "Title".
    // When there is no title field, we intentionally avoid showing "<ArrayName> #N".
    const heading = titleChild
        ? (fieldValue(item, titleChild.id) || fallbackTitle)
        : '';

    const body = renderNodeList(node.children || [], item, {
        ...options,
        hiddenTitleUid: titleChild?.uid || null,
    });

    const titleHtml = heading
        ? `<div class="dt-array-item-title">${escapeHtml(heading)}</div>`
        : '';

    return `
        <div class="dt-array-item">
            ${titleHtml}
            <div class="dt-array-item-body">${body}</div>
        </div>
    `;
}

export function setTrackerWrapperTemplate(templateText) {
    if (typeof templateText === 'string' && templateText.includes('{{content}}')) {
        wrapperTemplate = templateText;
    }
}

export function removeRenderedTracker(messageElement) {
    messageElement?.querySelectorAll('.mes_dynamic_tracker').forEach((element) => element.remove());
}

export function renderTrackerForMessage(messageId, trackerStore) {
    const messageElement = document.querySelector(`.mes[mesid="${messageId}"]`);
    if (!messageElement) {
        return;
    }

    removeRenderedTracker(messageElement);

    if (!trackerStore?.data || !Array.isArray(trackerStore?.fields)) {
        return;
    }

    const content = renderNodeList(trackerStore.fields, trackerStore.data);
    const title = escapeHtml(trackerStore.title || EXTENSION_TITLE);
    const html = wrapperTemplate
        .replace('{{title}}', title)
        .replace('{{content}}', content);

    const container = document.createElement('div');
    container.className = 'mes_dynamic_tracker';
    container.dataset.dtMessageId = String(messageId);
    container.innerHTML = html;
    messageElement.querySelector('.mes_text')?.before(container);
}

export function renderAllTrackers(chat) {
    if (!Array.isArray(chat)) {
        return;
    }

    chat.forEach((message, index) => {
        renderTrackerForMessage(index, getTrackerStore(message));
    });
}
