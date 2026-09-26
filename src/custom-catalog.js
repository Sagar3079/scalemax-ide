/** Validation and normalization for user-created experts and skills. */

const MAX_NAME = 64;
const MAX_PROMPT = 8000;
const MAX_DESCRIPTION = 500;
const MAX_ROLE = 64;
const AVATAR_ACCESSORIES = [
  'headphones', 'beret', 'glasses', 'megaphone', 'hardhat', 'pencil', 'shield', 'clipboard', null,
];

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedText(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function validId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)
    && !['__proto__', 'prototype', 'constructor'].includes(value);
}

function makeId(prefix) {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${suffix}`;
}

/**
 * Validates and normalizes a custom expert record.
 * Returns { ok: true, value } or { ok: false, error }.
 */
export function validateCustomExpert(input, { existingId } = {}) {
  if (!isRecord(input)) return { ok: false, error: 'Expert data must be an object.' };
  const name = boundedText(input.name, MAX_NAME);
  if (!name) return { ok: false, error: 'Name is required.' };
  if (typeof input.name === 'string' && input.name.trim().length > MAX_NAME) {
    return { ok: false, error: `Name must be ${MAX_NAME} characters or fewer.` };
  }
  const prompt = boundedText(input.prompt, MAX_PROMPT);
  if (!prompt) return { ok: false, error: 'Prompt is required.' };
  if (typeof input.prompt === 'string' && input.prompt.trim().length > MAX_PROMPT) {
    return { ok: false, error: `Prompt must be ${MAX_PROMPT} characters or fewer.` };
  }
  const role = boundedText(input.role, MAX_ROLE) || 'Custom';
  const description = boundedText(input.description, MAX_DESCRIPTION);
  const category = boundedText(input.category, MAX_ROLE) || 'Custom';
  const avatarColor = typeof input.avatarColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(input.avatarColor)
    ? input.avatarColor : null;
  const avatarAccessory = AVATAR_ACCESSORIES.includes(input.avatarAccessory) ? input.avatarAccessory : null;
  const id = existingId && validId(existingId) ? existingId
    : validId(input.id) ? input.id : makeId('custom-expert');
  return {
    ok: true,
    value: {
      id, name, role, description, category, prompt,
      avatarColor, avatarAccessory, custom: true,
    },
  };
}

/**
 * Validates and normalizes a custom skill record.
 * Returns { ok: true, value } or { ok: false, error }.
 */
export function validateCustomSkill(input, { existingId } = {}) {
  if (!isRecord(input)) return { ok: false, error: 'Skill data must be an object.' };
  const name = boundedText(input.name, MAX_NAME);
  if (!name) return { ok: false, error: 'Name is required.' };
  if (typeof input.name === 'string' && input.name.trim().length > MAX_NAME) {
    return { ok: false, error: `Name must be ${MAX_NAME} characters or fewer.` };
  }
  const prompt = boundedText(input.prompt, MAX_PROMPT);
  if (!prompt) return { ok: false, error: 'Prompt is required.' };
  if (typeof input.prompt === 'string' && input.prompt.trim().length > MAX_PROMPT) {
    return { ok: false, error: `Prompt must be ${MAX_PROMPT} characters or fewer.` };
  }
  const category = boundedText(input.category, MAX_ROLE) || 'Custom';
  const description = boundedText(input.description, MAX_DESCRIPTION);
  const id = existingId && validId(existingId) ? existingId
    : validId(input.id) ? input.id : makeId('custom-skill');
  return {
    ok: true,
    value: { id, name, category, description, prompt, custom: true },
  };
}

export function normalizeCustomList(value, validator) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const ids = new Set();
  for (const item of value) {
    const validated = validator(item, { existingId: item?.id });
    if (!validated.ok || ids.has(validated.value.id)) continue;
    ids.add(validated.value.id);
    result.push(validated.value);
    if (result.length === 200) break;
  }
  return result;
}

export { MAX_NAME, MAX_PROMPT, MAX_DESCRIPTION, AVATAR_ACCESSORIES };
