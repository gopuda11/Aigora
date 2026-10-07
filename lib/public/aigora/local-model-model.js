// local-model-model.js - pure helper for the local-model status (GET api/local-model). No DOM, no network.

import { t } from "./i18n.js";

export function modelLabel(model) {
  if (typeof model === "string") return model;
  if (model.displayNameKey) return t(model.displayNameKey, model.displayNameParams);
  var label = model.displayName || model.label || model.value || "";
  // Older servers only sent the primary model's Korean role suffix.
  var legacyRoles = { "대화": "aiPicker.modelChat", "코드 초안": "aiPicker.modelCode", "수동 선택": "aiPicker.modelManual" };
  if (model.value && label.indexOf(model.value + " · ") === 0) {
    var key = legacyRoles[label.slice(model.value.length + 3)];
    if (typeof key === "string") return t(key, { model: model.value });
  }
  return label;
}

export function modelDescription(model) {
  if (model.descriptionKey) return t(model.descriptionKey, model.descriptionParams);
  return model.description || "";
}

// Offered only when enabled and the probe succeeded.
export function usable(status) {
  return !!(status && status.enabled === true && status.ready === true);
}
