import {
    MODULE_NAME,
    EXTENSION_TITLE,
    AUTO_MODE,
    ROOT_CONTAINER_ID,
    createFieldNode,
    createGroupNode,
    cloneTrackerNode,
} from './lib/config.js';
import {
    getContext,
    getSettings,
    getActivePreset,
    saveSettings,
    createPresetKey,
    getTrackerStore,
    setTrackerStore,
    clearTrackerStore,
} from './lib/state.js';
import {
    buildJsonSchema,
    schemaToPrettyString,
    findNodeByUid,
    removeNode,
    addNode,
    moveNode,
    moveNodeWithinParent,
    collectContainerOptions,
    validateTrackerData,
    normalizeNodeForSave,
    flattenSchemaLevel,
} from './lib/schema.js';
import {
    buildTrackerInjectionMessages,
    createSyntheticTrackerMessage,
} from './lib/context-builder.js';
import {
    setTrackerWrapperTemplate,
    renderTrackerForMessage,
    removeRenderedTracker,
} from './lib/tracker-ui.js';
import {
    MAX_INJECTION_DEPTH,
    extension_prompt_roles,
    extension_prompt_types,
    eventSource,
    event_types,
    generateQuietPrompt,
    stopGeneration,
} from '../../../../script.js';
import { POPUP_RESULT, POPUP_TYPE } from '../../../../scripts/popup.js';

const pendingControllers = new Map();
let activeQuietGenerationPlan = null;
let buttonObserver = null;
let buttonRefreshQueued = false;
let buttonRefreshTimer = null;
let buttonRefreshLastRun = 0;
let trackerRefreshQueued = false;
const trackerRefreshIds = new Set();
const trackerRefreshTimers = new Map();
let injectionRefreshTimer = null;
let lastInjectionKey = null;
let lastInjectionPrompt = null;
const uiState = {
    mounted: false,
    currentEditUid: null,
    suppressEvents: false,
    settingsRoot: null,
    elements: {},
    containerOptions: [],
};

function getMessageButton(messageElement) {
    return messageElement?.querySelector('.mes_dynamic_tracker_button') || null;
}

function installMessageButtons() {
    const templateContainer = document.querySelector('#message_template .mes_buttons .extraMesButtons');
    if (templateContainer && !templateContainer.querySelector('.mes_dynamic_tracker_button')) {
        templateContainer.prepend(createMessageButton());
    }

    document.querySelectorAll('.mes .mes_buttons .extraMesButtons').forEach((container) => {
        if (!container.querySelector('.mes_dynamic_tracker_button')) {
            container.prepend(createMessageButton());
        }
    });
}

function syncPendingButtons() {
    for (const messageId of pendingControllers.keys()) {
        setButtonPendingState(messageId, true);
    }
}

function scheduleButtonRefresh() {
    if (!getSettings().enabled) {
        syncEnabledUi();
        return;
    }
    // Streaming and other extensions can generate a lot of DOM mutations.
    // Debounce button scanning to avoid repeatedly walking the whole chat DOM.
    if (buttonRefreshTimer) {
        clearTimeout(buttonRefreshTimer);
    }

    buttonRefreshTimer = setTimeout(() => {
        buttonRefreshTimer = null;

        // Safety cooldown: do not run more often than every ~200ms.
        const now = Date.now();
        if (now - buttonRefreshLastRun < 200) {
            return;
        }
        buttonRefreshLastRun = now;

        if (buttonRefreshQueued) {
            return;
        }
        buttonRefreshQueued = true;
        requestAnimationFrame(() => {
            buttonRefreshQueued = false;
            installMessageButtons();
            syncPendingButtons();
        });
    }, 120);
}

function ensureMessageButtonObserver() {
    if (buttonObserver) {
        return;
    }

    const target = document.querySelector('#chat') || document.body;
    if (!target) {
        return;
    }

    buttonObserver = new MutationObserver((mutations) => {
        scheduleButtonRefresh();

        // SillyTavern may re-render message DOM during swipes/abort operations.
        // When that happens, our tracker blocks can disappear from the chat DOM until a full refresh.
        // We re-render trackers when we detect relevant message-level mutations.
        // Re-render trackers when ST changes message DOM (swipes, abort, message edits).
        // Swipe changes often mutate the children of `.mes_text` without replacing the `.mes` node,
        // so we must treat mutations *inside* messages as relevant too.
        const affected = collectAffectedMessageIds(mutations);
        if (affected.size) {
            for (const messageId of affected) {
                queueTrackerRefresh(messageId);
            }
        }
    });

    buttonObserver.observe(target, { childList: true, subtree: true });
}

function collectAffectedMessageIds(mutations = []) {
    const ids = new Set();

    const isInternalTrackerNode = (element) => {
        if (!element || element.nodeType !== 1) return false;
        const el = /** @type {HTMLElement} */ (element);
        return (
            el.classList?.contains('mes_dynamic_tracker') ||
            el.closest?.('.mes_dynamic_tracker') ||
            el.classList?.contains('mes_dynamic_tracker_button') ||
            el.closest?.('.mes_dynamic_tracker_button')
        );
    };

    const mutationIsOnlyInternal = (mutation) => {
        const nodes = [];
        if (mutation.addedNodes) nodes.push(...mutation.addedNodes);
        if (mutation.removedNodes) nodes.push(...mutation.removedNodes);
        const elementNodes = nodes.filter((n) => n && n.nodeType === 1);
        return elementNodes.length > 0 && elementNodes.every(isInternalTrackerNode);
    };

    const isRelevantChangeNode = (element) => {
        if (!element || element.nodeType !== 1) return false;
        const el = /** @type {HTMLElement} */ (element);
        // We only care about high-level message structure changes.
        // This avoids re-rendering trackers on every streaming token or regex rewrite.
        return (
            el.classList?.contains('mes') ||
            el.classList?.contains('mes_text') ||
            el.querySelector?.('.mes_text')
        );
    };

    const addFromElement = (element) => {
        if (!element || element.nodeType !== 1) {
            return;
        }

        const el = /** @type {HTMLElement} */ (element);

        // Ignore mutations originating from our own tracker blocks/buttons.
        // Without this, re-rendering the tracker would trigger the observer again,
        // causing an endless refresh loop that breaks <details> toggling.
        if (isInternalTrackerNode(el)) {
            return;
        }

        // Ignore low-level nodes (e.g. streaming spans inside .mes_text).
        if (!isRelevantChangeNode(el)) {
            return;
        }

        const mes = el.classList?.contains('mes') ? el : el.closest?.('.mes');
        if (!mes) {
            return;
        }

        const raw = mes.getAttribute('mesid');
        const messageId = Number.parseInt(raw, 10);
        if (!Number.isNaN(messageId)) {
            ids.add(messageId);
        }
    };

    for (const mutation of mutations) {
        // Skip mutations that are exclusively our own DOM insertions/removals.
        if (mutationIsOnlyInternal(mutation)) {
            continue;
        }

        for (const node of mutation.addedNodes || []) {
            addFromElement(node);
        }

        for (const node of mutation.removedNodes || []) {
            addFromElement(node);
        }
    }

    return ids;
}

function queueTrackerRefresh(messageId) {
    const id = Number.parseInt(String(messageId), 10);
    if (Number.isNaN(id)) {
        return;
    }

    // Debounce per message to avoid repeated re-renders during streaming or rapid DOM churn.
    if (trackerRefreshTimers.has(id)) {
        clearTimeout(trackerRefreshTimers.get(id));
    }

    trackerRefreshTimers.set(
        id,
        setTimeout(() => {
            trackerRefreshTimers.delete(id);
            trackerRefreshIds.add(id);
            scheduleTrackerRefresh();
        }, 180),
    );
}

function scheduleTrackerRefresh() {
    if (trackerRefreshQueued) {
        return;
    }

    trackerRefreshQueued = true;
    requestAnimationFrame(() => {
        trackerRefreshQueued = false;

        // When disabled, do not render trackers at all (but keep data in chat files).
        if (!getSettings().enabled) {
            document.querySelectorAll('#chat .mes').forEach((el) => removeRenderedTracker(el));
            return;
        }

        const chat = getContext().chat || [];
        if (trackerRefreshIds.size) {
            for (const id of trackerRefreshIds) {
                renderTrackerForMessage(id, getTrackerStore(chat[id]));
            }
            trackerRefreshIds.clear();
            return;
        }

        // Fallback (should be rare): only render trackers for visible messages.
        renderVisibleTrackers(chat);
    });
}

function renderVisibleTrackers(chat) {
    if (!getSettings().enabled) {
        // Hide trackers from UI without deleting them from chat data.
        document.querySelectorAll('#chat .mes').forEach((el) => removeRenderedTracker(el));
        return;
    }
    // Avoid iterating the whole chat history; render only currently visible message DOM nodes.
    document.querySelectorAll('#chat .mes[mesid]').forEach((element) => {
        const id = Number.parseInt(element.getAttribute('mesid'), 10);
        if (Number.isNaN(id)) {
            return;
        }
        renderTrackerForMessage(id, getTrackerStore(chat?.[id]));
    });
}

function createMessageButton() {
    const button = document.createElement('div');
    button.className = 'mes_button mes_dynamic_tracker_button fa-solid fa-list-check interactable';
    button.tabIndex = 0;
    button.title = EXTENSION_TITLE;
    return button;
}

function setButtonPendingState(messageId, isPending) {
    const messageElement = document.querySelector(`.mes[mesid="${messageId}"]`);
    const button = getMessageButton(messageElement);
    button?.classList.toggle('spinning', !!isPending);
}

function showToast(type, message) {
    if (typeof toastr?.[type] === 'function') {
        toastr[type](message, EXTENSION_TITLE);
        return;
    }

    console[type === 'error' ? 'error' : 'log'](`[${EXTENSION_TITLE}] ${message}`);
}

function syncEnabledUi() {
    const enabled = !!getSettings().enabled;

    // Hide/show message buttons.
    document.querySelectorAll('.mes_dynamic_tracker_button').forEach((button) => {
        // Use inline style so it works regardless of theme CSS.
        button.style.display = enabled ? '' : 'none';
    });

    // When disabled, remove rendered trackers from DOM, but keep them in chat metadata.
    if (!enabled) {
        document.querySelectorAll('#chat .mes').forEach((el) => removeRenderedTracker(el));
    }
}

function resolveExtensionPromptRole(roleString) {
    const roles = extension_prompt_roles || {};
    if (roleString === 'system') {
        return roles.SYSTEM ?? roles.System ?? 0;
    }
    if (roleString === 'user') {
        return roles.USER ?? roles.User ?? 1;
    }
    return roles.ASSISTANT ?? roles.Assistant ?? 2;
}

function resolveExtensionPromptTypeInChat() {
    const types = extension_prompt_types || {};
    return types.IN_CHAT ?? 1;
}

function clearTrackerPromptInjection() {
    const ctx = getContext();
    if (typeof ctx.setExtensionPrompt !== 'function') {
        return;
    }
    ctx.setExtensionPrompt(MODULE_NAME, '', extension_prompt_types?.NONE ?? 0, MAX_INJECTION_DEPTH);
    lastInjectionKey = null;
    lastInjectionPrompt = null;
}

function collectTrackersForInjection(messages, limitSetting) {
    if (!Array.isArray(messages)) {
        return [];
    }

    const raw = Number(limitSetting);
    let remaining = Number.isFinite(raw) ? raw : 0;
    // Semantics: 0 means "all trackers".
    if (remaining === 0) {
        remaining = Number.POSITIVE_INFINITY;
    }

    if (remaining < 0) {
        return [];
    }

    const selected = [];
    for (let index = messages.length - 2; index >= 0 && remaining > 0; index -= 1) {
        const store = getTrackerStore(messages[index]);
        if (store?.data) {
            selected.push({ messageId: index, store });
            remaining -= 1;
        }
    }

    return selected.reverse();
}

function buildTrackerPromptText(selectedTrackers, role) {
    const parts = [];
    for (const entry of selectedTrackers) {
        const synthetic = createSyntheticTrackerMessage(entry.store, { format: 'text', role });
        if (synthetic?.mes) {
            parts.push(String(synthetic.mes));
        }
    }
    return parts.join('\n\n').trim();
}

function applyTrackerPromptInjection(force = false) {
    const ctx = getContext();
    const settings = getSettings();

    if (typeof ctx.setExtensionPrompt !== 'function') {
        return;
    }

    if (!settings.enabled || settings.onlyShow) {
        clearTrackerPromptInjection();
        return;
    }

    const selected = collectTrackersForInjection(ctx.chat || [], settings.includeLastXTrackerMessages);
    if (!selected.length) {
        clearTrackerPromptInjection();
        return;
    }

    const includeWI = !!settings.includeInWorldInfoScanning;
    const roleString = settings.trackerMessageRole || 'assistant';
    const roleNum = resolveExtensionPromptRole(roleString);
    const typeNum = resolveExtensionPromptTypeInChat();
    const key = [
        String(settings.includeLastXTrackerMessages),
        roleString,
        includeWI ? 'wi1' : 'wi0',
        selected.map((e) => `${e.messageId}:${Number(e.store?.createdAt) || 0}`).join(','),
    ].join('|');

    if (!force && key === lastInjectionKey) {
        return;
    }

    const prompt = buildTrackerPromptText(selected, roleString);
    if (!prompt) {
        clearTrackerPromptInjection();
        return;
    }

    // Avoid redundant writes (some ST builds do extra work on setExtensionPrompt).
    if (!force && prompt === lastInjectionPrompt && key === lastInjectionKey) {
        return;
    }

    ctx.setExtensionPrompt(
        MODULE_NAME,
        prompt,
        typeNum,
        MAX_INJECTION_DEPTH,
        includeWI,
        roleNum,
    );

    lastInjectionKey = key;
    lastInjectionPrompt = prompt;
}

function scheduleInjectionRefresh(force = false) {
    if (injectionRefreshTimer) {
        clearTimeout(injectionRefreshTimer);
    }
    injectionRefreshTimer = setTimeout(() => {
        injectionRefreshTimer = null;
        applyTrackerPromptInjection(force);
    }, 150);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function setFormStatus(message = '', isError = false) {
    const target = uiState.elements.formStatus;
    if (!target) {
        return;
    }

    target.textContent = message;
    target.style.color = isError ? 'var(--SmartThemeQuoteColor, #ff8080)' : '';
}

function ensurePresetExists() {
    const settings = getSettings();
    if (!settings.schemaPresets[settings.schemaPreset]) {
        settings.schemaPreset = Object.keys(settings.schemaPresets)[0] || 'default';
    }
    return settings;
}

function renderPresetSelect() {
    const settings = ensurePresetExists();
    const select = uiState.elements.schemaPreset;
    if (!select) {
        return;
    }

    const entries = Object.entries(settings.schemaPresets);
    select.innerHTML = '';

    for (const [key, preset] of entries) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = preset.name || key;
        option.selected = settings.schemaPreset === key;
        select.append(option);
    }
}

function renderParentSelect() {
    const preset = getActivePreset();
    const select = uiState.elements.parentSelect;
    if (!select) {
        return;
    }

    uiState.containerOptions = collectContainerOptions(preset.fields || []);
    select.innerHTML = '';

    for (const optionData of uiState.containerOptions) {
        const option = document.createElement('option');
        option.value = optionData.value;
        option.textContent = optionData.label;
        select.append(option);
    }

    const currentValue = select.dataset.selectedParent || ROOT_CONTAINER_ID;
    if (uiState.containerOptions.some((entry) => entry.value === currentValue)) {
        select.value = currentValue;
    } else {
        select.value = ROOT_CONTAINER_ID;
    }

    syncFormVisibility();
}

function getContainerOption(value) {
    return uiState.containerOptions.find((option) => option.value === value) || uiState.containerOptions[0] || {
        value: ROOT_CONTAINER_ID,
        label: 'Root',
        titleAllowed: false,
    };
}

function renderFieldTree() {
    const container = uiState.elements.fieldTree;
    if (!container) {
        return;
    }

    const preset = getActivePreset();
    if (!preset.fields?.length) {
        container.innerHTML = '<div class="dt-empty">No fields configured for this preset.</div>';
        return;
    }

    container.innerHTML = renderFieldBranch(preset.fields);
}

function renderFieldBranch(nodes) {
    return `
        <ul class="dt-tree-list">
            ${nodes.map((node, index) => renderFieldNode(node, index, nodes.length)).join('')}
        </ul>
    `;
}

function renderTreeAction(iconClass, action, uid, title, enabled = true) {
    const classes = `dt-tree-action ${iconClass}${enabled ? '' : ' is-disabled'}`;
    const dataAction = enabled ? ` data-dt-action="${escapeHtml(action)}" data-dt-uid="${escapeHtml(uid)}"` : '';
    return `<span class="${classes}"${dataAction} title="${escapeHtml(title)}"></span>`;
}

function renderFieldNode(node, index, siblingCount) {
    const typeLabel = node.kind === 'group' ? 'group' : node.type;
    const mainLabel = node.kind === 'group'
        ? escapeHtml(node.name || 'Group')
        : `${escapeHtml(node.name || node.id || 'Field')} <small>(${escapeHtml(node.id || 'no-id')})</small>`;

    const meta = [];

    if (node.kind === 'field' && node.required) {
        meta.push('required');
    }

    if (node.kind === 'field' && node.collapsible) {
        meta.push('collapsible');
    }

    if (node.kind === 'field' && node.title) {
        meta.push('title');
    }

    const tooltip = node.kind === 'field' && typeof node.description === 'string' && node.description.trim()
        ? ` title="${escapeHtml(node.description.trim())}"`
        : '';

    return `
        <li>
            <div class="dt-tree-row">
                <span class="dt-tree-tag">${escapeHtml(typeLabel)}</span>
                <span class="dt-tree-main"${tooltip}>
                    ${mainLabel}
                    ${meta.length ? `<small> — ${escapeHtml(meta.join(', '))}</small>` : ''}
                </span>
                <span class="dt-tree-actions">
                    ${renderTreeAction('fa-solid fa-arrow-up', 'move-up', node.uid, 'Move up', index > 0)}
                    ${renderTreeAction('fa-solid fa-arrow-down', 'move-down', node.uid, 'Move down', index < siblingCount - 1)}
                    ${renderTreeAction('fa-solid fa-pen-to-square', 'edit', node.uid, 'Edit')}
                    ${renderTreeAction('fa-solid fa-trash', 'delete', node.uid, 'Delete')}
                </span>
            </div>
            ${node.children?.length ? renderFieldBranch(node.children) : ''}
        </li>
    `;
}

function populateFormFromNode(node, parentUid = ROOT_CONTAINER_ID) {
    uiState.currentEditUid = node?.uid || null;
    uiState.elements.parentSelect.dataset.selectedParent = parentUid || ROOT_CONTAINER_ID;
    renderParentSelect();

    uiState.suppressEvents = true;
    uiState.elements.entryKind.value = node?.kind === 'group' ? 'group' : 'field';
    uiState.elements.fieldId.value = node?.kind === 'field' ? (node.id || '') : '';
    uiState.elements.fieldName.value = node?.name || '';
    uiState.elements.fieldType.value = node?.kind === 'field' ? (node.type || 'string') : 'string';
    uiState.elements.fieldDescription.value = node?.kind === 'field' ? (node.description || '') : '';
    uiState.elements.fieldRequired.checked = !!node?.required;
    uiState.elements.fieldCollapsible.checked = !!node?.collapsible;
    uiState.elements.fieldTitle.checked = !!node?.title;
    uiState.suppressEvents = false;

    syncFormVisibility();
    uiState.elements.saveField.textContent = uiState.currentEditUid ? 'Update field' : 'Add field';
    setFormStatus(uiState.currentEditUid ? 'Editing existing entry.' : '');
}

function resetForm() {
    uiState.currentEditUid = null;
    uiState.elements.parentSelect.dataset.selectedParent = ROOT_CONTAINER_ID;
    renderParentSelect();

    uiState.suppressEvents = true;
    uiState.elements.entryKind.value = 'field';
    uiState.elements.fieldId.value = '';
    uiState.elements.fieldName.value = '';
    uiState.elements.fieldType.value = 'string';
    uiState.elements.fieldDescription.value = '';
    uiState.elements.fieldRequired.checked = false;
    uiState.elements.fieldCollapsible.checked = false;
    uiState.elements.fieldTitle.checked = false;
    uiState.suppressEvents = false;

    uiState.elements.saveField.textContent = 'Add field';
    syncFormVisibility();
    setFormStatus('');
}

function syncFormVisibility() {
    if (!uiState.elements.entryKind) {
        return;
    }

    const isGroup = uiState.elements.entryKind.value === 'group';
    const fieldType = uiState.elements.fieldType.value;
    const parentOption = getContainerOption(uiState.elements.parentSelect.value);

    const idField = uiState.elements.fieldId.closest('label');
    const typeField = uiState.elements.fieldType.closest('label');
    const descriptionField = uiState.elements.fieldDescription.closest('label');
    const requiredField = uiState.elements.fieldRequired.closest('label');
    const collapsibleField = uiState.elements.fieldCollapsible.closest('label');
    const titleField = uiState.elements.fieldTitle.closest('label');

    [idField, typeField, descriptionField, requiredField].forEach((element) => {
        element.style.display = isGroup ? 'none' : '';
    });

    collapsibleField.style.display = isGroup ? 'none' : '';
    titleField.style.display = isGroup ? 'none' : '';

    uiState.elements.fieldCollapsible.disabled = isGroup || !['object', 'array'].includes(fieldType);
    uiState.elements.fieldTitle.disabled = isGroup || !parentOption.titleAllowed;

    if (uiState.elements.fieldCollapsible.disabled) {
        uiState.elements.fieldCollapsible.checked = false;
    }

    if (uiState.elements.fieldTitle.disabled) {
        uiState.elements.fieldTitle.checked = false;
    }
}

function refreshUi() {
    const settings = ensurePresetExists();
    const preset = getActivePreset(settings);

    uiState.suppressEvents = true;
    renderPresetSelect();
    renderParentSelect();

    uiState.elements.enabled.checked = !!settings.enabled;
    uiState.elements.onlyShow.checked = !!settings.onlyShow;
    uiState.elements.includeWIScan.checked = !!settings.includeInWorldInfoScanning;
    uiState.elements.autoMode.value = settings.autoMode;
    uiState.elements.prompt.value = preset.prompt || '';
    uiState.elements.maxTokens.value = settings.maxResponseTokens;
    uiState.elements.includeMessages.value = settings.includeLastXMessages;
    uiState.elements.includeTrackers.value = settings.includeLastXTrackerMessages;
    uiState.elements.trackerRole.value = settings.trackerMessageRole || 'assistant';
    uiState.suppressEvents = false;

    syncEnabledUi();

    renderFieldTree();
    if (!uiState.currentEditUid) {
        resetForm();
    } else {
        const presetFields = getActivePreset().fields;
        const location = findNodeLocationWithParent(presetFields, uiState.currentEditUid);
        if (location) {
            populateFormFromNode(location.node, location.parentUid);
        } else {
            resetForm();
        }
    }
}

function findNodeLocationWithParent(nodes, uid, parentUid = ROOT_CONTAINER_ID) {
    for (const node of nodes) {
        if (!node) {
            continue;
        }

        if (node.uid === uid) {
            return {
                node,
                parentUid,
            };
        }

        if (Array.isArray(node.children) && node.children.length) {
            const nested = findNodeLocationWithParent(node.children, uid, node.uid);
            if (nested) {
                return nested;
            }
        }
    }

    return null;
}

function upsertFieldFromForm() {
    const settings = getSettings();
    if (!settings.enabled) {
        showToast('info', 'Dynamic Tracker is disabled.');
        return;
    }
    const preset = getActivePreset(settings);
    const parentUid = uiState.elements.parentSelect.value || ROOT_CONTAINER_ID;
    const isGroup = uiState.elements.entryKind.value === 'group';

    let rawNode;

    if (isGroup) {
        const groupName = uiState.elements.fieldName.value.trim();
        if (!groupName) {
            setFormStatus('Group name is required.', true);
            return;
        }

        rawNode = createGroupNode({
            uid: uiState.currentEditUid || undefined,
            name: groupName,
            children: uiState.currentEditUid
                ? (findNodeByUid(preset.fields, uiState.currentEditUid)?.children || []).map(cloneTrackerNode)
                : [],
        });
    } else {
        const id = uiState.elements.fieldId.value.trim();
        const name = uiState.elements.fieldName.value.trim();

        if (!id) {
            setFormStatus('Field id is required.', true);
            return;
        }

        if (!name) {
            setFormStatus('Field name is required.', true);
            return;
        }

        const existingChildren = uiState.currentEditUid
            ? (findNodeByUid(preset.fields, uiState.currentEditUid)?.children || []).map(cloneTrackerNode)
            : [];

        rawNode = createFieldNode({
            uid: uiState.currentEditUid || undefined,
            id,
            name,
            type: uiState.elements.fieldType.value,
            description: uiState.elements.fieldDescription.value.trim(),
            required: uiState.elements.fieldRequired.checked,
            collapsible: uiState.elements.fieldCollapsible.checked,
            title: uiState.elements.fieldTitle.checked,
            children: existingChildren,
        });
    }

    const node = normalizeNodeForSave(rawNode);

    if (uiState.currentEditUid) {
        moveNode(preset.fields, uiState.currentEditUid, parentUid);
        const movedNode = findNodeByUid(preset.fields, uiState.currentEditUid);
        if (!movedNode) {
            setFormStatus('Failed to update field location.', true);
            return;
        }

        Object.assign(movedNode, node, {
            children: movedNode.children,
        });

        if (node.kind === 'group') {
            movedNode.name = node.name;
        }

        if (node.kind === 'field') {
            movedNode.id = node.id;
            movedNode.name = node.name;
            movedNode.type = node.type;
            movedNode.description = node.description;
            movedNode.required = node.required;
            movedNode.collapsible = node.collapsible;
            movedNode.title = node.title;
        }

        setFormStatus('Field updated.');
    } else {
        const success = addNode(preset.fields, parentUid, node);
        if (!success) {
            setFormStatus('Could not add field to the selected parent.', true);
            return;
        }
        setFormStatus('Field added.');
    }

    saveSettings();
    refreshUi();
}

function deleteField(uid) {
    const preset = getActivePreset();
    const removed = removeNode(preset.fields, uid);
    if (!removed) {
        return;
    }

    if (uiState.currentEditUid === uid) {
        resetForm();
    }

    saveSettings();
    refreshUi();
    setFormStatus('Field removed.');
}

function createPreset() {
    const name = window.prompt('Preset name:', 'New Preset');
    if (!name) {
        return;
    }

    const settings = getSettings();
    const key = createPresetKey(name);
    const activePreset = getActivePreset(settings);

    settings.schemaPresets[key] = {
        name: name.trim() || 'New Preset',
        prompt: activePreset.prompt,
        fields: activePreset.fields.map(cloneTrackerNode),
    };

    settings.schemaPreset = key;
    saveSettings();
    resetForm();
    refreshUi();
}

function renamePreset() {
    const settings = getSettings();
    const preset = getActivePreset(settings);
    const name = window.prompt('New preset name:', preset.name || settings.schemaPreset);
    if (!name) {
        return;
    }

    preset.name = name.trim() || preset.name;
    saveSettings();
    refreshUi();
}

function deletePreset() {
    const settings = getSettings();
    const keys = Object.keys(settings.schemaPresets);

    if (keys.length <= 1) {
        showToast('warning', 'At least one preset must remain.');
        return;
    }

    const preset = getActivePreset(settings);
    const confirmed = window.confirm(`Delete preset "${preset.name}"?`);
    if (!confirmed) {
        return;
    }

    delete settings.schemaPresets[settings.schemaPreset];
    settings.schemaPreset = Object.keys(settings.schemaPresets)[0];
    saveSettings();
    resetForm();
    refreshUi();
}

async function showPreviewModal(title, text) {
    const context = getContext();

    // Prefer SillyTavern's native popup system so colors match the active theme.
    if (typeof context?.callGenericPopup === 'function') {
        const popupContent = `
            <div style="display:flex;flex-direction:column;gap:8px;">
                <textarea class="text_pole settings_input" style="width:100%;min-height:60vh;resize:vertical;font-family:monospace;" readonly>${escapeHtml(text)}</textarea>
            </div>
        `;

        await context.callGenericPopup(popupContent, POPUP_TYPE.DISPLAY, title, {
            wider: true,
            leftAlign: true,
            allowHorizontalScrolling: true,
            allowVerticalScrolling: true,
            animation: 'fast',
        });
        return;
    }

    // Fallback (older builds / custom forks): lightweight overlay.
    const overlay = document.createElement('div');
    overlay.className = 'dynamic-tracker-modal';
    overlay.innerHTML = `
        <div class="dynamic-tracker-modal__card">
            <div class="dynamic-tracker-modal__header">
                <b>${escapeHtml(title)}</b>
                <button type="button" class="menu_button" data-dt-close-modal>Close</button>
            </div>
            <div class="dynamic-tracker-modal__body">
                <pre>${escapeHtml(text)}</pre>
            </div>
        </div>
    `;

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay || event.target?.dataset?.dtCloseModal !== undefined) {
            overlay.remove();
        }
    });

    document.body.append(overlay);
}

function captureTrackerDetailsState(messageId) {
    const messageElement = document.querySelector(`.mes[mesid="${messageId}"]`);
    return Array.from(messageElement?.querySelectorAll('.mes_dynamic_tracker details') || []).map((details) => details.open);
}

function restoreTrackerDetailsState(messageId, states = []) {
    if (!states.length) {
        return;
    }

    const messageElement = document.querySelector(`.mes[mesid="${messageId}"]`);
    const detailsList = messageElement?.querySelectorAll('.mes_dynamic_tracker details') || [];
    detailsList.forEach((details, index) => {
        if (typeof states[index] === 'boolean') {
            details.open = states[index];
        }
    });
}

async function openTrackerEditor(messageId) {
    const context = getContext();
    const message = context.chat?.[messageId];
    const trackerStore = getTrackerStore(message);

    if (!trackerStore?.data) {
        showToast('warning', 'No tracker found on this message.');
        return;
    }

    // Prefer SillyTavern's native popup system so it matches the theme.
    if (typeof context?.callGenericPopup === 'function') {
        const popupContent = `
            <div style="display:flex;flex-direction:column;gap:8px;">
                <textarea id="dt-edit-textarea" class="text_pole settings_input" style="width:100%;min-height:55vh;resize:vertical;font-family:monospace;">${escapeHtml(JSON.stringify(trackerStore.data, null, 2))}</textarea>
            </div>
        `;

        await context.callGenericPopup(popupContent, POPUP_TYPE.CONFIRM, 'Edit Tracker', {
            okButton: 'Save',
            cancelButton: 'Cancel',
            wider: true,
            leftAlign: true,
            allowHorizontalScrolling: true,
            allowVerticalScrolling: true,
            animation: 'fast',
            onClose: async (popup) => {
                if (popup.result !== POPUP_RESULT.AFFIRMATIVE) {
                    return;
                }

                const textarea = popup.content?.querySelector?.('#dt-edit-textarea');
                if (!textarea) {
                    return;
                }

                try {
                    const parsed = JSON.parse(textarea.value);
                    const validation = validateTrackerData(trackerStore.fields || [], parsed);
                    if (!validation.valid) {
                        throw new Error(validation.errors.join('\n'));
                    }

                    await saveTrackerToMessage(messageId, parsed, trackerStore.fields || []);
                    showToast('success', 'Tracker updated.');
                } catch (error) {
                    console.error(`[${EXTENSION_TITLE}] Failed to update tracker`, error);
                    showToast('error', `Invalid tracker JSON: ${error.message || String(error)}`);
                }
            },
        });

        return;
    }

    // Fallback modal.
    const overlay = document.createElement('div');
    overlay.className = 'dynamic-tracker-modal';
    overlay.innerHTML = `
        <div class="dynamic-tracker-modal__card">
            <div class="dynamic-tracker-modal__header">
                <b>Edit Tracker</b>
                <button type="button" class="menu_button" data-dt-close-modal>Close</button>
            </div>
            <div class="dynamic-tracker-modal__body">
                <textarea class="text_pole settings_input dynamic-tracker-modal__textarea">${escapeHtml(JSON.stringify(trackerStore.data, null, 2))}</textarea>
            </div>
            <div class="dynamic-tracker-modal__footer">
                <button type="button" class="menu_button" data-dt-close-modal>Cancel</button>
                <button type="button" class="menu_button" data-dt-save-tracker>Save</button>
            </div>
        </div>
    `;

    overlay.addEventListener('click', async (event) => {
        if (event.target === overlay || event.target?.dataset?.dtCloseModal !== undefined) {
            overlay.remove();
            return;
        }

        if (event.target?.dataset?.dtSaveTracker === undefined) {
            return;
        }

        const textarea = overlay.querySelector('textarea');
        if (!textarea) {
            return;
        }

        try {
            const parsed = JSON.parse(textarea.value);
            const validation = validateTrackerData(trackerStore.fields || [], parsed);
            if (!validation.valid) {
                throw new Error(validation.errors.join('\n'));
            }

            await saveTrackerToMessage(messageId, parsed, trackerStore.fields || []);
            overlay.remove();
            showToast('success', 'Tracker updated.');
        } catch (error) {
            console.error(`[${EXTENSION_TITLE}] Failed to update tracker`, error);
            showToast('error', `Invalid tracker JSON: ${error.message || String(error)}`);
        }
    });

    document.body.append(overlay);
}

function getRootFieldIds(fieldTree = []) {
    return flattenSchemaLevel(fieldTree)
        .map((node) => node?.id)
        .filter(Boolean);
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function extractCodeBlock(text) {
    if (typeof text !== 'string') {
        return '';
    }

    const fencedJsonMatch = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    if (fencedJsonMatch?.[1]) {
        return fencedJsonMatch[1].trim();
    }

    const genericFenceMatch = text.match(/```\s*([\s\S]*?)```/);
    if (genericFenceMatch?.[1]) {
        return genericFenceMatch[1].trim();
    }

    return '';
}

function extractBalancedObject(text) {
    if (typeof text !== 'string') {
        return '';
    }

    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];

        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }

            if (char === '\\') {
                escaped = true;
                continue;
            }

            if (char === '"') {
                inString = false;
            }

            continue;
        }

        if (char === '"') {
            inString = true;
            continue;
        }

        if (char === '{') {
            if (depth === 0) {
                start = index;
            }
            depth += 1;
            continue;
        }

        if (char === '}' && depth > 0) {
            depth -= 1;
            if (depth === 0 && start !== -1) {
                return text.slice(start, index + 1).trim();
            }
        }
    }

    return '';
}

function extractResponseContent(payload) {
    if (payload == null) {
        return '';
    }

    if (typeof payload === 'string') {
        return payload.trim();
    }

    if (Array.isArray(payload)) {
        return payload.map((entry) => extractResponseContent(entry)).filter(Boolean).join('\n').trim();
    }

    if (Array.isArray(payload?.content)) {
        return payload.content.map((entry) => extractResponseContent(entry)).filter(Boolean).join('\n').trim();
    }

    if (typeof payload?.content === 'string') {
        return payload.content.trim();
    }

    if (isPlainObject(payload?.content)) {
        return extractResponseContent(payload.content);
    }

    if (Array.isArray(payload?.message?.content)) {
        return payload.message.content.map((entry) => extractResponseContent(entry)).filter(Boolean).join('\n').trim();
    }

    if (typeof payload?.message?.content === 'string') {
        return payload.message.content.trim();
    }

    if (typeof payload?.message === 'string') {
        return payload.message.trim();
    }

    if (isPlainObject(payload?.message)) {
        return extractResponseContent(payload.message);
    }

    if (typeof payload?.text === 'string') {
        return payload.text.trim();
    }

    if (payload?.choices?.length) {
        const choice = payload.choices[0];
        return extractResponseContent(
            choice?.message?.content
            || choice?.message
            || choice?.content
            || choice?.text
            || '',
        );
    }

    if (typeof payload === 'object') {
        return JSON.stringify(payload);
    }

    return String(payload);
}

function collectObjectCandidates(value, output, seen, depth = 0) {
    if (depth > 10 || value == null) {
        return;
    }

    if (typeof value === 'string') {
        const text = value.trim();
        if (!text) {
            return;
        }

        const stringCandidates = [
            text,
            extractCodeBlock(text),
            extractBalancedObject(text),
        ].filter(Boolean);

        for (const candidate of stringCandidates) {
            try {
                const parsed = JSON.parse(candidate);
                collectObjectCandidates(parsed, output, seen, depth + 1);
            } catch {
                // Keep trying other candidates
            }
        }

        return;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectObjectCandidates(item, output, seen, depth + 1);
        }
        return;
    }

    if (typeof value !== 'object') {
        return;
    }

    if (seen.has(value)) {
        return;
    }
    seen.add(value);

    if (isPlainObject(value)) {
        output.push(value);
    }

    const preferredKeys = [
        'parsed',
        'json',
        'data',
        'result',
        'response',
        'output',
        'value',
        'content',
        'message',
        'text',
    ];

    for (const key of preferredKeys) {
        if (key in value) {
            collectObjectCandidates(value[key], output, seen, depth + 1);
        }
    }

    for (const nestedValue of Object.values(value)) {
        collectObjectCandidates(nestedValue, output, seen, depth + 1);
    }
}

function selectBestObjectCandidate(candidates, expectedIds = []) {
    const objects = candidates.filter((candidate) => isPlainObject(candidate));
    if (!objects.length) {
        return null;
    }

    let bestCandidate = null;
    let bestScore = -1;

    for (const candidate of objects) {
        const score = expectedIds.length
            ? expectedIds.reduce(
                (total, key) => total + (Object.prototype.hasOwnProperty.call(candidate, key) ? 1 : 0),
                0,
            )
            : Object.keys(candidate).length;

        if (
            score > bestScore
            || (score === bestScore && bestCandidate && Object.keys(candidate).length < Object.keys(bestCandidate).length)
        ) {
            bestCandidate = candidate;
            bestScore = score;
        }
    }

    return bestCandidate || objects[0] || null;
}

function tryParseTrackerPayload(payload, fieldTree = []) {
    const candidates = [];
    collectObjectCandidates(payload, candidates, new WeakSet());

    const bestCandidate = selectBestObjectCandidate(candidates, getRootFieldIds(fieldTree));
    if (bestCandidate) {
        return bestCandidate;
    }

    const text = extractResponseContent(payload);
    if (!text) {
        return null;
    }

    const textCandidates = [
        text,
        extractCodeBlock(text),
        extractBalancedObject(text),
    ].filter(Boolean);

    for (const candidate of textCandidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (isPlainObject(parsed)) {
                return parsed;
            }
        } catch {
            // Keep trying
        }
    }

    return null;
}

async function saveTrackerToMessage(messageId, data, fields) {
    const context = getContext();
    const message = context.chat?.[messageId];
    if (!message) {
        throw new Error(`Message ${messageId} was not found.`);
    }

    const detailsState = captureTrackerDetailsState(messageId);

    setTrackerStore(message, {
        title: EXTENSION_TITLE,
        createdAt: Date.now(),
        presetKey: getSettings().schemaPreset,
        fields: (fields || []).map(cloneTrackerNode),
        data,
    });

    await context.saveChat();
    renderTrackerForMessage(messageId, getTrackerStore(message));
    restoreTrackerDetailsState(messageId, detailsState);
    scheduleInjectionRefresh(true);
}

async function clearTrackerFromMessage(messageId) {
    const context = getContext();
    const message = context.chat?.[messageId];
    if (!message) {
        return;
    }

    clearTrackerStore(message);
    await context.saveChat();
    renderTrackerForMessage(messageId, null);
    scheduleInjectionRefresh(true);
}

async function deleteTrackerFromMessage(messageId) {
    const context = getContext();
    const message = context.chat?.[messageId];
    if (!getTrackerStore(message)?.data) {
        showToast('warning', 'No tracker found on this message.');
        return;
    }

    if (!window.confirm('Delete this tracker? This cannot be undone.')) {
        return;
    }

    await clearTrackerFromMessage(messageId);
    showToast('success', 'Tracker deleted.');
}

function buildSyntheticTrackerMessage(trackerStore, options = {}) {
    return createSyntheticTrackerMessage(trackerStore, options);
}

function applyQuietTrackerGenerationWindow(chatMessages, plan) {
    if (!Array.isArray(chatMessages) || !plan) {
        return;
    }

    const context = getContext();
    const sourceMessages = Array.isArray(context.chat) ? context.chat : [];
    if (!sourceMessages.length) {
        chatMessages.length = 0;
        return;
    }

    // NOTE:
    // `chatMessages` is the *already pre-processed* message list that SillyTavern is about to send.
    // When the user hides messages from context, SillyTavern filters them out before calling the interceptor.
    // Therefore, we must apply the "Include last X messages" window relative to `chatMessages`,
    // not relative to `context.chat` indexes, otherwise we can accidentally splice away the whole array.

    const safeTargetIndex = Math.max(0, Math.min(Number(plan.targetIndex) || 0, sourceMessages.length - 1));
    const includeLastXMessages = Math.max(0, Number(plan.includeLastXMessages) || 0);
    // Semantics:
    //  - -1 => none
    //  - 0  => all
    //  - N  => last N
    let includeLastXTrackerMessages = Number(plan.includeLastXTrackerMessages);
    if (!Number.isFinite(includeLastXTrackerMessages)) {
        includeLastXTrackerMessages = 0;
    }

    // Remove any previously injected synthetic tracker messages.
    // Quiet generation should always inject trackers deterministically.
    for (let i = chatMessages.length - 1; i >= 0; i -= 1) {
        if (chatMessages[i]?.extra?.__dynamicTrackerSynthetic) {
            chatMessages.splice(i, 1);
        }
    }

    const targetMessage = sourceMessages[safeTargetIndex];

    const findMessageIndex = (messages, needle) => {
        if (!needle) return -1;
        const direct = messages.indexOf(needle);
        if (direct !== -1) return direct;

        // Fallback matching when SillyTavern clones objects.
        const needleDate = String(needle.send_date ?? '');
        const needleMes = String(needle.mes ?? '');
        const needleName = String(needle.name ?? '');
        const needleUser = !!needle.is_user;
        const needleSystem = !!needle.is_system;

        return messages.findIndex((m) =>
            m
            && String(m.send_date ?? '') === needleDate
            && String(m.mes ?? '') === needleMes
            && String(m.name ?? '') === needleName
            && !!m.is_user === needleUser
            && !!m.is_system === needleSystem,
        );
    };

    let targetPos = findMessageIndex(chatMessages, targetMessage);
    // If for some reason we cannot locate the target message (edge cases),
    // treat the last message in the prompt as the target.
    if (targetPos < 0) {
        targetPos = Math.max(0, chatMessages.length - 1);
    }

    // Trim after the target message so manual generation on older messages behaves like "target is last".
    if (chatMessages.length > targetPos + 1) {
        chatMessages.splice(targetPos + 1);
    }

    // Apply "Include last X messages" window relative to the remaining prompt.
    const startPos = includeLastXMessages === 0
        ? 0
        : Math.max(0, targetPos - Math.max(1, includeLastXMessages) + 1);
    if (startPos > 0) {
        chatMessages.splice(0, startPos);
    }

    // Inject previous trackers (JSON) between the messages in the final window.
    // -1 means none; 0 means all.
    if (includeLastXTrackerMessages >= 0) {
        buildTrackerInjectionMessages(chatMessages, includeLastXTrackerMessages, {
            format: 'json',
            role: getSettings().trackerMessageRole,
        });
    }
}

async function generateTracker(messageId) {
    const context = getContext();
    const message = context.chat?.[messageId];
    if (!message) {
        showToast('error', `Message ${messageId} not found.`);
        return;
    }

    if (pendingControllers.has(messageId)) {
        pendingControllers.get(messageId).cancelled = true;
        stopGeneration();
        showToast('info', 'Tracker generation cancelled.');
        return;
    }

    if (activeQuietGenerationPlan && activeQuietGenerationPlan.messageId !== messageId) {
        showToast('warning', 'Another tracker is already being generated.');
        return;
    }

    const settings = getSettings();
    const preset = getActivePreset(settings);
    const schema = buildJsonSchema(preset.fields || []);
    const finalPrompt = (preset.prompt || '').replace(
        /{{json_fields}}/g,
        JSON.stringify(schema, null, 2),
    );

    const pendingToken = {
        cancelled: false,
    };

    // Keep the message button alive during quiet generation.
    // In some cases (especially on the last message) ST re-renders the toolbar while generating,
    // which temporarily removes extraMesButtons and makes cancellation impossible.
    pendingToken.keepAlive = window.setInterval(() => {
        scheduleButtonRefresh();
    }, 250);

    pendingControllers.set(messageId, pendingToken);
    activeQuietGenerationPlan = {
        messageId,
        targetIndex: messageId,
        includeLastXMessages: settings.includeLastXMessages,
        includeLastXTrackerMessages: settings.onlyShow ? -1 : settings.includeLastXTrackerMessages,
    };
    setButtonPendingState(messageId, true);

    try {
        const responsePayload = await generateQuietPrompt({
            quietPrompt: finalPrompt,
            quietToLoud: false,
            skipWIAN: false,
            responseLength: Number(settings.maxResponseTokens) || 600,
            removeReasoning: false,
            trimToSentence: false,
        });

        const parsed = tryParseTrackerPayload(responsePayload, preset.fields || []);
        if (!parsed) {
            throw new Error('The model response could not be parsed as JSON.');
        }

        const validation = validateTrackerData(preset.fields || [], parsed);
        if (!validation.valid) {
            throw new Error(validation.errors.join('\n'));
        }

        await saveTrackerToMessage(messageId, parsed, preset.fields || []);
    } catch (error) {
        const wasCancelled = pendingControllers.get(messageId)?.cancelled;
        if (wasCancelled || error?.name === 'AbortError' || String(error?.message || error).includes('aborted')) {
            return;
        }

        console.error(`[${EXTENSION_TITLE}] Failed to generate tracker`, error);
        showToast('error', `Tracker generation failed: ${error.message || String(error)}`);
        await clearTrackerFromMessage(messageId);
    } finally {
        activeQuietGenerationPlan = null;
        const token = pendingControllers.get(messageId);
        if (token?.keepAlive) {
            window.clearInterval(token.keepAlive);
        }
        pendingControllers.delete(messageId);
        setButtonPendingState(messageId, false);
    }
}

function shouldAutoGenerate(autoMode, isUserMessage) {
    if (!getSettings().enabled) {
        return false;
    }
    switch (autoMode) {
        case AUTO_MODE.BOTH:
            return true;
        case AUTO_MODE.INPUTS:
            return isUserMessage;
        case AUTO_MODE.RESPONSES:
            return !isUserMessage;
        default:
            return false;
    }
}

function registerChatEvents() {
    const context = getContext();
    const events = context.eventTypes || {};

    document.addEventListener('click', async (event) => {
        const trackerAction = event.target.closest('.mes_dynamic_tracker [data-dt-tracker-action]');
        if (trackerAction) {
            event.preventDefault();
            event.stopPropagation();

            const messageElement = trackerAction.closest('.mes');
            const messageId = Number(messageElement?.getAttribute('mesid'));
            if (Number.isNaN(messageId)) {
                return;
            }

            const action = trackerAction.dataset.dtTrackerAction;
            if (action === 'edit') {
                await openTrackerEditor(messageId);
                return;
            }

            if (action === 'delete') {
                await deleteTrackerFromMessage(messageId);
                return;
            }
        }

        // When the user changes a swipe (alternate reply), SillyTavern often updates only the `.mes_text`.
        // Our MutationObserver *usually* catches it, but some themes/DOM paths won't trigger relevant nodes.
        // We also hook swipe control clicks as a reliable signal and re-render the tracker for that message.
        const swipeControl = event.target.closest(
            '.swipe_left, .swipe_right, .mes_swipe_left, .mes_swipe_right, .mes_swipe, .swipe-button, .mes_swipe_button'
        );
        if (swipeControl) {
            const messageElement = swipeControl.closest('.mes');
            const messageId = Number(messageElement?.getAttribute('mesid'));
            if (!Number.isNaN(messageId)) {
                setTimeout(() => queueTrackerRefresh(messageId), 0);
                setTimeout(() => scheduleInjectionRefresh(true), 0);
            }
        }

        const button = event.target.closest('.mes_dynamic_tracker_button');
        if (!button) {
            return;
        }

        const messageElement = button.closest('.mes');
        if (!messageElement) {
            return;
        }

        const messageId = Number(messageElement.getAttribute('mesid'));
        if (Number.isNaN(messageId)) {
            return;
        }

        generateTracker(messageId);
    });

    if (events.CHARACTER_MESSAGE_RENDERED) {
        context.eventSource.on(events.CHARACTER_MESSAGE_RENDERED, (messageId) => {
            if (shouldAutoGenerate(getSettings().autoMode, false)) {
                generateTracker(Number(messageId));
            }
        });
    }

    if (events.USER_MESSAGE_RENDERED) {
        context.eventSource.on(events.USER_MESSAGE_RENDERED, (messageId) => {
            if (shouldAutoGenerate(getSettings().autoMode, true)) {
                generateTracker(Number(messageId));
            }
        });
    }

    const refresh = () => {
        scheduleButtonRefresh();
        renderVisibleTrackers(context.chat || []);
        syncEnabledUi();
        scheduleInjectionRefresh();
    };

    if (events.CHAT_CHANGED) {
        context.eventSource.on(events.CHAT_CHANGED, refresh);
    }

    if (events.MORE_MESSAGES_LOADED) {
        context.eventSource.on(events.MORE_MESSAGES_LOADED, refresh);
    }

    // Keep injection fresh right before generation (if supported by current ST build).
    if (eventSource && event_types && 'GENERATE_AFTER_COMBINE_PROMPTS' in event_types) {
        eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, () => {
            scheduleInjectionRefresh();
        });
    }
}

function bindSettingsEvents() {
    const settings = getSettings();

    uiState.elements.enabled.addEventListener('input', () => {
        if (uiState.suppressEvents) {
            return;
        }
        settings.enabled = !!uiState.elements.enabled.checked;
        saveSettings();
        syncEnabledUi();
        // When toggling enabled, also update prompt injection.
        scheduleInjectionRefresh(true);
        // Re-render visible trackers when enabled.
        if (settings.enabled) {
            renderVisibleTrackers(getContext().chat || []);
            installMessageButtons();
        }
    });

    uiState.elements.onlyShow.addEventListener('input', () => {
        if (uiState.suppressEvents) {
            return;
        }
        settings.onlyShow = !!uiState.elements.onlyShow.checked;
        saveSettings();
        scheduleInjectionRefresh(true);
    });

    uiState.elements.includeWIScan.addEventListener('input', () => {
        if (uiState.suppressEvents) {
            return;
        }
        settings.includeInWorldInfoScanning = !!uiState.elements.includeWIScan.checked;
        saveSettings();
        scheduleInjectionRefresh(true);
    });

    uiState.elements.autoMode.addEventListener('change', () => {
        if (uiState.suppressEvents) {
            return;
        }
        settings.autoMode = uiState.elements.autoMode.value;
        saveSettings();
    });

    uiState.elements.schemaPreset.addEventListener('change', () => {
        if (uiState.suppressEvents) {
            return;
        }
        settings.schemaPreset = uiState.elements.schemaPreset.value;
        saveSettings();
        resetForm();
        refreshUi();
    });

    uiState.elements.prompt.addEventListener('input', () => {
        if (uiState.suppressEvents) {
            return;
        }
        getActivePreset(settings).prompt = uiState.elements.prompt.value;
        saveSettings();
    });

    uiState.elements.maxTokens.addEventListener('input', () => {
        if (uiState.suppressEvents) {
            return;
        }
        settings.maxResponseTokens = Math.max(1, Number(uiState.elements.maxTokens.value) || 1);
        saveSettings();
    });

    uiState.elements.includeMessages.addEventListener('input', () => {
        if (uiState.suppressEvents) {
            return;
        }
        settings.includeLastXMessages = Math.max(0, Number(uiState.elements.includeMessages.value) || 0);
        saveSettings();
    });

    uiState.elements.includeTrackers.addEventListener('input', () => {
        if (uiState.suppressEvents) {
            return;
        }
        settings.includeLastXTrackerMessages = Math.max(0, Number(uiState.elements.includeTrackers.value) || 0);
        saveSettings();
        scheduleInjectionRefresh(true);
    });

    uiState.elements.trackerRole.addEventListener('change', () => {
        if (uiState.suppressEvents) {
            return;
        }
        settings.trackerMessageRole = uiState.elements.trackerRole.value;
        saveSettings();
        scheduleInjectionRefresh(true);
    });

    uiState.elements.entryKind.addEventListener('change', () => {
        if (uiState.suppressEvents) {
            return;
        }
        syncFormVisibility();
    });

    uiState.elements.fieldType.addEventListener('change', () => {
        if (uiState.suppressEvents) {
            return;
        }
        syncFormVisibility();
    });

    uiState.elements.parentSelect.addEventListener('change', () => {
        if (uiState.suppressEvents) {
            return;
        }
        uiState.elements.parentSelect.dataset.selectedParent = uiState.elements.parentSelect.value;
        syncFormVisibility();
    });

    uiState.elements.saveField.addEventListener('click', upsertFieldFromForm);
    uiState.elements.clearForm.addEventListener('click', resetForm);
    uiState.elements.preview.addEventListener('click', () => {
        showPreviewModal('JSON Schema Preview', schemaToPrettyString(getActivePreset().fields || []))
            .catch((error) => console.error(`[${EXTENSION_TITLE}] Preview popup failed`, error));
    });

    uiState.elements.presetCreate.addEventListener('click', createPreset);
    uiState.elements.presetRename.addEventListener('click', renamePreset);
    uiState.elements.presetDelete.addEventListener('click', deletePreset);

    uiState.elements.fieldTree.addEventListener('click', (event) => {
        const target = event.target?.closest?.('[data-dt-action][data-dt-uid]');
        const action = target?.dataset?.dtAction;
        const uid = target?.dataset?.dtUid;

        if (!action || !uid) {
            return;
        }

        if (action === 'delete') {
            deleteField(uid);
            return;
        }

        if (action === 'move-up' || action === 'move-down') {
            const preset = getActivePreset();
            const moved = moveNodeWithinParent(preset.fields, uid, action === 'move-up' ? -1 : 1);
            if (!moved) {
                return;
            }

            saveSettings();
            refreshUi();
            return;
        }

        if (action === 'edit') {
            const preset = getActivePreset();
            const location = findNodeLocationWithParent(preset.fields, uid);
            if (!location) {
                return;
            }

            populateFormFromNode(location.node, location.parentUid);
        }
    });
}

async function mountSettings() {
    if (uiState.mounted) {
        refreshUi();
        return;
    }

    const settingsUrl = new URL('./settings.html', import.meta.url);
    const root = document.createElement('div');
    root.innerHTML = await fetch(settingsUrl).then((response) => response.text());

    uiState.settingsRoot = root.firstElementChild;
    document.querySelector('#extensions_settings')?.append(uiState.settingsRoot);

    uiState.elements = {
        enabled: uiState.settingsRoot.querySelector('#dt_enabled'),
        onlyShow: uiState.settingsRoot.querySelector('#dt_only_show'),
        includeWIScan: uiState.settingsRoot.querySelector('#dt_include_wi_scan'),
        autoMode: uiState.settingsRoot.querySelector('#dt_auto_mode'),
        schemaPreset: uiState.settingsRoot.querySelector('#dt_schema_preset'),
        prompt: uiState.settingsRoot.querySelector('#dt_prompt'),
        maxTokens: uiState.settingsRoot.querySelector('#dt_max_tokens'),
        includeMessages: uiState.settingsRoot.querySelector('#dt_include_messages'),
        includeTrackers: uiState.settingsRoot.querySelector('#dt_include_trackers'),
        trackerRole: uiState.settingsRoot.querySelector('#dt_tracker_role'),
        parentSelect: uiState.settingsRoot.querySelector('#dt_parent_select'),
        entryKind: uiState.settingsRoot.querySelector('#dt_entry_kind'),
        fieldId: uiState.settingsRoot.querySelector('#dt_field_id'),
        fieldName: uiState.settingsRoot.querySelector('#dt_field_name'),
        fieldType: uiState.settingsRoot.querySelector('#dt_field_type'),
        fieldDescription: uiState.settingsRoot.querySelector('#dt_field_description'),
        fieldRequired: uiState.settingsRoot.querySelector('#dt_field_required'),
        fieldCollapsible: uiState.settingsRoot.querySelector('#dt_field_collapsible'),
        fieldTitle: uiState.settingsRoot.querySelector('#dt_field_title'),
        saveField: uiState.settingsRoot.querySelector('#dt_save_field'),
        clearForm: uiState.settingsRoot.querySelector('#dt_clear_form'),
        formStatus: uiState.settingsRoot.querySelector('#dt_form_status'),
        fieldTree: uiState.settingsRoot.querySelector('#dt_field_tree'),
        preview: uiState.settingsRoot.querySelector('#dt_show_preview'),
        presetCreate: uiState.settingsRoot.querySelector('#dt_preset_create'),
        presetRename: uiState.settingsRoot.querySelector('#dt_preset_rename'),
        presetDelete: uiState.settingsRoot.querySelector('#dt_preset_delete'),
    };

    bindSettingsEvents();
    uiState.mounted = true;
    resetForm();
    refreshUi();
}

async function loadTrackerTemplate() {
    const templateUrl = new URL('./tracker.html', import.meta.url);
    const text = await fetch(templateUrl).then((response) => response.text());
    setTrackerWrapperTemplate(text);
}

async function initialize() {
    getSettings();
    await loadTrackerTemplate();
    await mountSettings();
    installMessageButtons();
    ensureMessageButtonObserver();
    renderVisibleTrackers(getContext().chat || []);
    syncEnabledUi();
    applyTrackerPromptInjection(true);
    registerChatEvents();
    showToast('success', 'Dynamic Tracker loaded.');
}

globalThis.dynamicTrackerGenerateInterceptor = async function dynamicTrackerGenerateInterceptor(chat, _contextSize, _abort, type) {
    if (!Array.isArray(chat)) {
        return;
    }

    if (type === 'quiet') {
        // Most extensions use `generateQuietPrompt()` to generate assistant text.
        // We still want tracker injections to be present there (so the model sees Status),
        // *except* when this quiet request is our own tracker-generation run.
        if (activeQuietGenerationPlan) {
            applyQuietTrackerGenerationWindow(chat, activeQuietGenerationPlan);
            return;
        }
        // For other quiet generations, the tracker is injected through `setExtensionPrompt`.
    }

    // Best-effort: keep the extension prompt injection up to date for any generation.
    // (The interceptor itself no longer mutates `chat`, so it won't affect WI scan depth.)
    scheduleInjectionRefresh();
};

jQuery(async () => {
    try {
        await initialize();
    } catch (error) {
        console.error(`[${EXTENSION_TITLE}] Initialization failed`, error);
        showToast('error', `Dynamic Tracker failed to initialize: ${error.message || String(error)}`);
    }
});
