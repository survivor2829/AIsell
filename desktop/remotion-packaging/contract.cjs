const path = require("node:path");
const effectRegistryData = require("./effect-registry.json");
const layoutGrid = require("./layout-grid.json");

const STYLE_IDS = Object.freeze(["social_pop", "neo_editorial", "tech_motion"]);
const SEMANTIC_PRESET_IDS = Object.freeze(Object.keys(effectRegistryData.semanticPresets || {}));
const LAYOUT_ZONES = Object.freeze(["top_banner", "upper_left", "upper_right", "middle_left", "middle_right"]);
const MOTION_EVENT_SIZES = Object.freeze(["hero", "card", "chip"]);
const EFFECT_RENDERER_IDS = Object.freeze([
  "elasticHeading",
  "keywordSticker",
  "svgCallout",
  "numericStepCard",
  "chapterBar",
  "focusFrame",
  "zoomTransition"
]);
const MOTION_EVENT_TYPES = new Set([
  "hook",
  "keyword",
  "emphasis",
  "step",
  "scene",
  "result",
  "warning",
  "quote"
]);
const SOURCE_EXTENSION_PATTERN = /\.(?:mp4|mov|m4v|webm)$/iu;
const ZONE_RECTS = Object.freeze(layoutGrid);

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function cleanText(value, maximum = 80) {
  return String(value || "").replace(/\s+/gu, " ").trim().slice(0, maximum);
}

function cleanCaptionText(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function frameForMs(milliseconds, fps) {
  return Math.max(0, Math.ceil((finiteNumber(milliseconds, 0) * fps) / 1_000));
}

function publicFilenameForSource(sourcePath) {
  const extension = path.extname(String(sourcePath || "")).toLowerCase();
  if (!SOURCE_EXTENSION_PATTERN.test(extension)) {
    throw new Error("The Remotion source video type is unsupported.");
  }
  return `source${extension}`;
}

function normalizeTimedItem(item, durationMs, index, kind) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error(`Invalid ${kind} at index ${index}.`);
  }
  const startMs = clamp(Math.round(finiteNumber(item.startMs, -1)), 0, durationMs);
  const endMs = clamp(Math.round(finiteNumber(item.endMs, -1)), 0, durationMs);
  if (endMs <= startMs) throw new Error(`Invalid ${kind} timing at index ${index}.`);
  return { startMs, endMs };
}

function overlaps(left, right) {
  return left.startMs < right.endMs && right.startMs < left.endMs;
}

function automaticZone(type, index) {
  if (type === "hook" || type === "result") return "top_banner";
  return ["upper_right", "middle_right", "upper_left", "middle_left"][index % 4];
}

function rectanglesOverlap(left, right) {
  return left.x < right.x + right.width
    && right.x < left.x + left.width
    && left.y < right.y + right.height
    && right.y < left.y + left.height;
}

function zoneIsProtected(zone, event, protectedRects) {
  return protectedRects.some((rectangle) => overlaps(event, rectangle) && rectanglesOverlap(ZONE_RECTS[zone], rectangle));
}

function semanticKey(text) {
  return String(text || "").replace(/[\s，。！？、；：,.!?;:+＋/]/gu, "").toLocaleLowerCase();
}

function validateStringArray(value, allowedValues, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`The effect registry ${label} must be a non-empty array.`);
  }
  const unique = new Set(value);
  if (unique.size !== value.length || value.some((item) => !allowedValues.includes(item))) {
    throw new Error(`The effect registry ${label} is invalid.`);
  }
}

function validateEffectRegistry(registry, rendererIds = EFFECT_RENDERER_IDS) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry) || registry.version !== 1) {
    throw new Error("The effect registry version is invalid.");
  }
  const policy = registry.policy;
  for (const key of ["maxConcurrent", "recentWindow", "maxSameComponentInWindow", "maxSameVariantInWindow"]) {
    if (!Number.isInteger(policy?.[key]) || policy[key] < 1) {
      throw new Error(`The effect registry policy ${key} is invalid.`);
    }
  }
  if (!Array.isArray(registry.components) || registry.components.length === 0) {
    throw new Error("The effect registry components are missing.");
  }
  const componentIds = new Set();
  const variantIds = new Set();
  for (const component of registry.components) {
    if (!component || typeof component !== "object" || !/^[a-z][a-z0-9_]*$/u.test(component.id || "")) {
      throw new Error("The effect registry component id is invalid.");
    }
    if (componentIds.has(component.id)) throw new Error(`Duplicate effect component: ${component.id}.`);
    componentIds.add(component.id);
    if (!rendererIds.includes(component.renderer)) {
      throw new Error(`The effect registry renderer is missing: ${component.renderer || component.id}.`);
    }
    if (!new Set(["event", "focus"]).has(component.target)) {
      throw new Error(`The effect registry target is invalid: ${component.id}.`);
    }
    validateStringArray(component.eventTypes, [...MOTION_EVENT_TYPES], `${component.id} event types`, { allowEmpty: component.target === "focus" });
    validateStringArray(component.sizes, MOTION_EVENT_SIZES, `${component.id} sizes`, { allowEmpty: component.target === "focus" });
    validateStringArray(component.zones, LAYOUT_ZONES, `${component.id} zones`, { allowEmpty: component.target === "focus" });
    if (!Array.isArray(component.variants) || component.variants.length === 0) {
      throw new Error(`The effect registry component ${component.id} has no variant.`);
    }
    for (const variant of component.variants) {
      if (!variant || typeof variant !== "object" || !/^[a-z][a-z0-9_]*$/u.test(variant.id || "")) {
        throw new Error(`The effect registry variant is invalid: ${component.id}.`);
      }
      if (variantIds.has(variant.id)) throw new Error(`Duplicate effect variant: ${variant.id}.`);
      variantIds.add(variant.id);
      validateStringArray(variant.styles, STYLE_IDS, `${variant.id} styles`);
      if (!cleanText(variant.motion, 24) || !cleanText(variant.surface, 24)) {
        throw new Error(`The effect registry variant metadata is invalid: ${variant.id}.`);
      }
    }
    for (const styleId of STYLE_IDS) {
      if (component.variants.filter((variant) => variant.styles.includes(styleId)).length < 2) {
        throw new Error(`The effect registry needs multiple ${component.id} variants for ${styleId}.`);
      }
    }
  }
  if (!registry.semanticPresets || typeof registry.semanticPresets !== "object") {
    throw new Error("The effect registry semantic presets are missing.");
  }
  if (JSON.stringify(Object.keys(registry.semanticPresets)) !== JSON.stringify(SEMANTIC_PRESET_IDS)) {
    throw new Error("The effect registry semantic preset list is invalid.");
  }
  const componentsById = new Map(registry.components.map((component) => [component.id, component]));
  for (const presetId of SEMANTIC_PRESET_IDS) {
    const preset = registry.semanticPresets[presetId];
    for (const eventType of MOTION_EVENT_TYPES) {
      const allowedComponents = preset?.eventComponents?.[eventType];
      if (!Array.isArray(allowedComponents) || allowedComponents.length === 0) {
        throw new Error(`The effect registry preset ${presetId} is missing ${eventType}.`);
      }
      for (const componentId of allowedComponents) {
        const component = componentsById.get(componentId);
        if (!component || component.target !== "event" || !component.eventTypes.includes(eventType)) {
          throw new Error(`The effect registry preset ${presetId} references an incompatible component.`);
        }
      }
    }
    if (!Array.isArray(preset?.focusComponents) || preset.focusComponents.length === 0) {
      throw new Error(`The effect registry preset ${presetId} has no focus component.`);
    }
    if (preset.focusComponents.some((componentId) => componentsById.get(componentId)?.target !== "focus")) {
      throw new Error(`The effect registry preset ${presetId} references an incompatible focus component.`);
    }
  }
  return registry;
}

const EFFECT_REGISTRY = validateEffectRegistry(effectRegistryData);
const EFFECT_REGISTRY_VERSION = EFFECT_REGISTRY.version;

function deterministicHash(value) {
  let hash = 2_166_136_261;
  for (const character of String(value || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function selectEffectVariant({
  styleId,
  semanticPresetId,
  target = "event",
  event = null,
  seed,
  recentEffects = [],
  index = 0,
  registry = EFFECT_REGISTRY
}) {
  validateEffectRegistry(registry);
  const preset = registry.semanticPresets[semanticPresetId];
  if (!preset || !STYLE_IDS.includes(styleId)) return null;
  const allowedComponentIds = target === "focus"
    ? preset.focusComponents
    : preset.eventComponents[event?.type] || [];
  const compatible = registry.components.flatMap((component) => {
    if (!allowedComponentIds.includes(component.id) || component.target !== target) return [];
    if (target === "event" && (
      !component.eventTypes.includes(event.type)
      || !component.sizes.includes(event.size)
      || !component.zones.includes(event.zone)
    )) return [];
    return component.variants
      .filter((variant) => variant.styles.includes(styleId))
      .map((variant) => ({
        registryVersion: registry.version,
        componentId: component.id,
        variantId: variant.id,
        renderer: component.renderer,
        motion: variant.motion,
        surface: variant.surface
      }));
  });
  const recent = recentEffects.slice(-registry.policy.recentWindow);
  const eligible = compatible.filter((candidate) => (
    recent.filter((effect) => effect.componentId === candidate.componentId).length < registry.policy.maxSameComponentInWindow
    && recent.filter((effect) => effect.variantId === candidate.variantId).length < registry.policy.maxSameVariantInWindow
  ));
  if (!eligible.length) return null;
  eligible.sort((left, right) => (
    left.componentId.localeCompare(right.componentId) || left.variantId.localeCompare(right.variantId)
  ));
  const signature = target === "focus"
    ? `${seed}|focus|${index}`
    : `${seed}|${event.type}|${event.text}|${event.startMs}|${event.endMs}|${event.zone}|${event.size}|${index}`;
  return eligible[deterministicHash(signature) % eligible.length];
}

function resolveEventLayout(events, protectedRects) {
  const accepted = [];
  const preference = ["upper_right", "upper_left", "middle_right", "middle_left", "top_banner"];
  for (const event of events) {
    const simultaneous = accepted.filter((current) => overlaps(current, event));
    const eventKey = semanticKey(event.text);
    if (eventKey && simultaneous.some((current) => {
      const currentKey = semanticKey(current.text);
      return current.priority >= event.priority
        && (currentKey.includes(eventKey) || eventKey.includes(currentKey));
    })) continue;
    if (simultaneous.length >= EFFECT_REGISTRY.policy.maxConcurrent) continue;
    const occupied = new Set(simultaneous.map((current) => current.zone));
    let zone = event.preferredZone;
    if (occupied.has(zone) || zoneIsProtected(zone, event, protectedRects)) {
      const safeZone = preference.find((candidate) => (
        !occupied.has(candidate) && !zoneIsProtected(candidate, event, protectedRects)
      ));
      if (!safeZone) continue;
      zone = safeZone;
    }
    accepted.push({ ...event, zone });
  }
  return accepted.sort((left, right) => left.startMs - right.startMs || right.priority - left.priority);
}

function normalizeMotionManifest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("The Remotion manifest must be an object.");
  }
  const styleId = cleanText(input.styleId, 40);
  if (!STYLE_IDS.includes(styleId)) throw new Error("The Remotion style is invalid.");
  const suppliedSemanticPresetId = cleanText(input.semanticPresetId, 40);
  const semanticPresetId = suppliedSemanticPresetId || "knowledge_focus";
  if (!SEMANTIC_PRESET_IDS.includes(semanticPresetId)) {
    throw new Error("The Remotion semantic preset is invalid.");
  }
  const durationMs = Math.round(finiteNumber(input.durationMs, 0));
  if (durationMs < 1_000 || durationMs > 180_000) {
    throw new Error("The Remotion duration is invalid.");
  }
  const sourceFile = cleanText(input.sourceFile, 120);
  if (
    !sourceFile
    || sourceFile !== path.basename(sourceFile)
    || /[:\\/]/u.test(sourceFile)
    || !SOURCE_EXTENSION_PATTERN.test(sourceFile)
  ) {
    throw new Error("The Remotion source must be an opaque public filename.");
  }
  const deterministicSeed = cleanText(input.deterministicSeed, 80) || `${sourceFile}:${cleanText(input.title, 60)}`;
  const fps = 30;
  const captions = (Array.isArray(input.captions) ? input.captions : []).map((caption, index) => {
    const timing = normalizeTimedItem(caption, durationMs, index, "caption");
    const text = cleanCaptionText(caption.text);
    if (!text) throw new Error(`Invalid caption text at index ${index}.`);
    return { ...timing, text };
  }).sort((left, right) => left.startMs - right.startMs);
  const normalizeRectangle = (rectangle, index, kind) => {
    const timing = normalizeTimedItem(rectangle, durationMs, index, kind);
    const x = clamp(finiteNumber(rectangle.x, -1), 0, 0.95);
    const y = clamp(finiteNumber(rectangle.y, -1), 0, 0.95);
    const width = clamp(finiteNumber(rectangle.width, 0), 0.05, 1 - x);
    const height = clamp(finiteNumber(rectangle.height, 0), 0.05, 1 - y);
    return { ...timing, x, y, width, height };
  };
  const focusRects = (Array.isArray(input.focusRects) ? input.focusRects : []).map((focus, index) => {
    const normalized = normalizeRectangle(focus, index, "focus rectangle");
    const effect = selectEffectVariant({
      styleId,
      semanticPresetId,
      target: "focus",
      seed: deterministicSeed,
      index
    });
    if (!effect) throw new Error(`No registered focus effect is compatible at index ${index}.`);
    return { ...normalized, effect };
  });
  const protectedRects = (Array.isArray(input.protectedRects) ? input.protectedRects : []).map((rectangle, index) => ({
    ...normalizeRectangle(rectangle, index, "protected rectangle"),
    role: cleanText(rectangle.role, 24) || "subject"
  }));
  const events = resolveEventLayout((Array.isArray(input.events) ? input.events : []).map((event, index) => {
    const timing = normalizeTimedItem(event, durationMs, index, "event");
    const type = cleanText(event.type, 24);
    if (!MOTION_EVENT_TYPES.has(type)) throw new Error(`Invalid motion event type at index ${index}.`);
    const text = cleanText(event.text, 48);
    if (!text) throw new Error(`Invalid motion event text at index ${index}.`);
    const suppliedZone = cleanText(event.preferredZone || event.zone, 24);
    if (suppliedZone && !LAYOUT_ZONES.includes(suppliedZone)) {
      throw new Error(`Invalid motion event zone at index ${index}.`);
    }
    const suppliedSize = cleanText(event.size, 16);
    if (suppliedSize && !MOTION_EVENT_SIZES.includes(suppliedSize)) {
      throw new Error(`Invalid motion event size at index ${index}.`);
    }
    return {
      ...timing,
      type,
      text,
      icon: cleanText(event.icon, 24) || null,
      ordinal: Math.max(0, Math.round(finiteNumber(event.ordinal, index + 1))),
      preferredZone: suppliedZone || automaticZone(type, index),
      size: suppliedSize || (type === "hook" ? "hero" : type === "result" ? "card" : "chip"),
      priority: clamp(Math.round(finiteNumber(event.priority, type === "hook" || type === "result" ? 3 : 2)), 1, 3),
      reason: cleanText(event.reason, 80) || null
    };
  }).sort((left, right) => (
    right.priority - left.priority
      || semanticKey(right.text).length - semanticKey(left.text).length
      || left.startMs - right.startMs
  )), [...focusRects, ...protectedRects]);
  const recentEffects = [];
  const registeredEvents = [];
  for (const [index, event] of events.entries()) {
    const effect = selectEffectVariant({
      styleId,
      semanticPresetId,
      event,
      seed: deterministicSeed,
      recentEffects,
      index
    });
    if (!effect) continue;
    recentEffects.push(effect);
    registeredEvents.push({ ...event, effect });
  }
  return {
    version: 1,
    semanticPresetId,
    styleId,
    effectRegistryVersion: EFFECT_REGISTRY_VERSION,
    layoutGridVersion: 1,
    deterministicSeed,
    width: 1080,
    height: 1920,
    fps,
    durationMs,
    durationInFrames: frameForMs(durationMs, fps),
    title: cleanText(input.title, 60),
    sourceFile,
    director: {
      version: Math.max(1, Math.round(finiteNumber(input.director?.version, 1))),
      provider: cleanText(input.director?.provider, 24) || "local",
      model: cleanText(input.director?.model, 64) || null
    },
    captions,
    ...(input.captionPresentation === "reference_narration" ? { captionPresentation: "reference_narration" } : {}),
    events: registeredEvents,
    focusRects,
    protectedRects
  };
}

module.exports = {
  EFFECT_REGISTRY,
  EFFECT_REGISTRY_VERSION,
  EFFECT_RENDERER_IDS,
  LAYOUT_ZONES,
  MOTION_EVENT_TYPES,
  MOTION_EVENT_SIZES,
  SEMANTIC_PRESET_IDS,
  STYLE_IDS,
  frameForMs,
  normalizeMotionManifest,
  publicFilenameForSource,
  selectEffectVariant,
  validateEffectRegistry
};
