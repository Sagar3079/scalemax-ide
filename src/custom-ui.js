/** ScaleMax IDE: create, edit and delete custom experts and skills. */
import { renderAvatar, AVATAR_STYLES, AVATAR_COLORS } from './avatars.js';
import { validateCustomExpert, validateCustomSkill } from './custom-catalog.js';

const KINDS = {
  expert: {
    listKey: 'customExperts',
    validate: validateCustomExpert,
    eyebrow: 'Your own expert',
    promptLabel: 'Persona prompt applied to chat',
    promptHint: 'Describe how this expert thinks and answers. It is added to the system prompt of every chat request while the expert is selected.',
    placeholder: 'Act as a … Start from the user goal, ask for missing context, and …',
  },
  skill: {
    listKey: 'customSkills',
    validate: validateCustomSkill,
    eyebrow: 'Your own skill',
    promptLabel: 'Prompt template',
    promptHint: 'Write the instructions for this skill. Use {{input}} where the conversation material should go. Install the skill to apply it to chat, or Run it on the file open in the editor.',
    placeholder: 'Review {{input}} and produce …',
  },
};

const byId = (id) => document.getElementById(id);
let selectedColor = AVATAR_COLORS[0];

function option(value, label) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

function kindOf(value) {
  return value === 'skill' ? 'skill' : 'expert';
}

function setStatus(message) {
  const node = byId('custom-status');
  if (node) node.textContent = message;
}

function renderPreview() {
  const host = byId('custom-avatar-preview');
  if (!host) return;
  const kind = kindOf(byId('custom-kind')?.value);
  host.hidden = kind !== 'expert';
  if (kind !== 'expert') { host.replaceChildren(); return; }
  const seed = byId('custom-edit-id')?.value || byId('custom-name')?.value.trim() || 'new-expert';
  const accessory = byId('custom-accessory')?.value || null;
  host.replaceChildren(renderAvatar({ seed, base: selectedColor, accessory }, { size: 64 }));
}

function renderColors() {
  const host = byId('custom-colors');
  if (!host) return;
  host.replaceChildren(...AVATAR_COLORS.map((color, index) => {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'custom-color';
    swatch.dataset.color = color;
    swatch.setAttribute('role', 'radio');
    swatch.setAttribute('aria-label', `Colour ${index + 1}`);
    const checked = color === selectedColor;
    swatch.setAttribute('aria-checked', String(checked));
    swatch.tabIndex = checked ? 0 : -1;
    // CSSOM is CSP-safe; inline style attributes in markup are not.
    swatch.style.backgroundColor = color;
    return swatch;
  }));
}

function selectColor(color, focus = false) {
  if (!AVATAR_COLORS.includes(color)) return;
  selectedColor = color;
  renderColors();
  if (focus) byId('custom-colors')?.querySelector(`[data-color="${color}"]`)?.focus();
  renderPreview();
}

function fillForm(kind, record) {
  const set = (id, value) => { const node = byId(id); if (node) node.value = value; };
  const config = KINDS[kind];
  set('custom-kind', kind);
  set('custom-edit-id', record?.id || '');
  set('custom-name', record?.name || '');
  set('custom-role', kind === 'expert' ? (record?.role && record.role !== 'Custom' ? record.role : '') : '');
  set('custom-category', record?.category && record.category !== 'Custom' ? record.category : '');
  set('custom-description', record?.description || '');
  set('custom-prompt', record?.prompt || '');
  set('custom-accessory', kind === 'expert' ? (record?.avatarAccessory || '') : '');
  selectedColor = kind === 'expert' && AVATAR_COLORS.includes(record?.avatarColor) ? record.avatarColor : AVATAR_COLORS[0];
  const prompt = byId('custom-prompt');
  if (prompt) prompt.placeholder = config.placeholder;
  const label = byId('custom-prompt-label');
  if (label) label.textContent = config.promptLabel;
  const hint = byId('custom-prompt-hint');
  if (hint) hint.textContent = config.promptHint;
  const eyebrow = byId('custom-dialog-kind');
  if (eyebrow) eyebrow.textContent = config.eyebrow;
  const title = byId('custom-dialog-title');
  if (title) title.textContent = record ? `Edit ${record.name}` : (kind === 'expert' ? 'New expert' : 'New skill');
  const remove = byId('custom-delete');
  if (remove) remove.hidden = !record;
  for (const node of document.querySelectorAll('#custom-form [data-custom-field]')) {
    node.hidden = node.dataset.customField !== kind;
  }
  setStatus('');
  renderColors();
  renderPreview();
}

export function openCustomDialog(app, kind, id = null) {
  const resolved = kindOf(kind);
  const list = app[KINDS[resolved].listKey] || [];
  const record = id ? list.find((item) => item.id === id) : null;
  if (id && !record) { app.showToast('That item no longer exists'); return; }
  const dialog = byId('custom-dialog');
  if (!dialog) return;
  fillForm(resolved, record);
  if (!dialog.open) dialog.showModal();
  byId('custom-name')?.focus();
}

function readForm(kind) {
  const value = (id) => byId(id)?.value ?? '';
  const input = {
    name: value('custom-name'),
    category: value('custom-category').trim() || 'Custom',
    description: value('custom-description'),
    prompt: value('custom-prompt'),
  };
  if (kind === 'expert') {
    input.role = value('custom-role').trim() || 'Custom';
    input.avatarColor = selectedColor;
    input.avatarAccessory = value('custom-accessory') || null;
  }
  return input;
}

function saveCustom(app, event) {
  event.preventDefault();
  const kind = kindOf(byId('custom-kind')?.value);
  const config = KINDS[kind];
  const editId = byId('custom-edit-id')?.value || '';
  const list = app[config.listKey] || [];
  const existing = editId ? list.find((item) => item.id === editId) : null;
  if (editId && !existing) { setStatus('That item no longer exists.'); return; }
  const validated = config.validate(readForm(kind), existing ? { existingId: existing.id } : {});
  if (!validated.ok) {
    setStatus(validated.error);
    (validated.error.startsWith('Name') ? byId('custom-name') : byId('custom-prompt'))?.focus();
    return;
  }
  const record = validated.value;
  if (!existing && list.length >= 200) { setStatus('At most 200 custom items can be saved.'); return; }
  app[config.listKey] = existing
    ? list.map((item) => (item.id === existing.id ? record : item))
    : [...list, record];
  void app.persist(config.listKey);
  app.renderCustomCatalogs();
  byId('custom-dialog')?.close();
  app.showToast(existing ? `${record.name} updated` : `${record.name} created`);
}

export function deleteCustom(app, kind, id) {
  const resolved = kindOf(kind);
  const config = KINDS[resolved];
  const list = app[config.listKey] || [];
  const record = list.find((item) => item.id === id);
  if (!record) return false;
  if (!window.confirm(`Delete the custom ${resolved} "${record.name}"?`)) return false;
  app[config.listKey] = list.filter((item) => item.id !== id);
  void app.persist(config.listKey);
  // A deleted entry must not keep shaping chat requests.
  if (resolved === 'expert' && app.settings.expertId === id) app.settings.expertId = null;
  if (resolved === 'skill') {
    if (app.settings.skillId === id) app.settings.skillId = null;
    if (Object.hasOwn(app.skillStates, id)) {
      delete app.skillStates[id];
      void app.persist('skillStates');
    }
  }
  void app.persist('settings');
  app.renderCustomCatalogs();
  app.showToast(`${record.name} deleted`);
  return true;
}

export function bindCustomCatalogUi(app) {
  const dialog = byId('custom-dialog');
  if (!dialog) return;
  const accessory = byId('custom-accessory');
  if (accessory) {
    accessory.replaceChildren(...AVATAR_STYLES.map((style) => option(style.accessory || '', style.label)));
    accessory.addEventListener('change', renderPreview);
  }
  byId('custom-name')?.addEventListener('input', renderPreview);
  const colors = byId('custom-colors');
  colors?.addEventListener('click', (event) => {
    const swatch = event.target.closest('.custom-color[data-color]');
    if (swatch) selectColor(swatch.dataset.color, true);
  });
  // Radio-group keyboard model: arrows move the selection.
  colors?.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const index = AVATAR_COLORS.indexOf(selectedColor);
    selectColor(AVATAR_COLORS[(index + step + AVATAR_COLORS.length) % AVATAR_COLORS.length], true);
  });
  byId('custom-form')?.addEventListener('submit', (event) => saveCustom(app, event));
  const close = () => { if (dialog.open) dialog.close(); };
  byId('custom-close')?.addEventListener('click', close);
  byId('custom-cancel')?.addEventListener('click', close);
  byId('custom-delete')?.addEventListener('click', () => {
    const kind = kindOf(byId('custom-kind')?.value);
    const id = byId('custom-edit-id')?.value;
    if (id && deleteCustom(app, kind, id)) close();
  });
  byId('add-expert-btn')?.addEventListener('click', () => openCustomDialog(app, 'expert'));
  byId('add-skill-btn')?.addEventListener('click', () => openCustomDialog(app, 'skill'));
}
