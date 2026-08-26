const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const esbuild = require("esbuild");

const {
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
  validateEffectRegistry
} = require("../remotion-packaging/contract.cjs");

const desktopDir = path.resolve(__dirname, "..");
const stylePacks = JSON.parse(
  fs.readFileSync(path.join(desktopDir, "remotion-packaging", "style-packs.json"), "utf8")
);
const layoutGrid = JSON.parse(
  fs.readFileSync(path.join(desktopDir, "remotion-packaging", "layout-grid.json"), "utf8")
);
const effectRegistry = EFFECT_REGISTRY;
const bailianRunnerSource = fs.readFileSync(path.join(desktopDir, "scripts", "run-bailian-motion-director.cjs"), "utf8");
const remotionTemplateSource = fs.readFileSync(path.join(desktopDir, "remotion-packaging", "video-template.tsx"), "utf8");
const remotionWorkerSource = fs.readFileSync(path.join(desktopDir, "src", "main", "remotion-render-worker.mjs"), "utf8");
assert.match(bailianRunnerSource, /app\.exit\(0\)/u);
assert.match(bailianRunnerSource, /app\.exit\(1\)/u);
assert.match(bailianRunnerSource, /input: keyStore\.read\(\)/u);
assert.doesNotMatch(bailianRunnerSource, /DASHSCOPE_API_KEY/u, "the decrypted key must not be placed in the child environment");
assert.doesNotMatch(bailianRunnerSource, /process\.exitCode/u, "Electron must not turn provider failures into exit code zero");
assert.doesNotMatch(remotionTemplateSource, /border: `7px solid \$\{pack\.palette\.accent\}`/u, "social packaging must not add a meaningless empty ring");
for (const meaninglessDecoration of ["LIVE / AI PACK", "FIELD NOTE", "VISION / SEMANTIC EVENT STREAM"]) {
  assert.doesNotMatch(remotionTemplateSource, new RegExp(meaninglessDecoration, "u"));
}
assert.doesNotMatch(remotionTemplateSource, /if \(manifest\.styleId/u, "event rendering must not dispatch through fixed style templates");
assert.doesNotMatch(remotionTemplateSource, /SocialEvent|EditorialEvent|TechEvent/u, "the runtime must dispatch registered effect components");
assert.match(remotionTemplateSource, /const eventEffectRenderers/u);
assert.match(remotionTemplateSource, /const focusEffectRenderers/u);
assert.match(
  remotionWorkerSource,
  /connect-src 'self' http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\*/u,
  "Remotion must permit only its loopback media proxy"
);
assert.match(
  remotionWorkerSource,
  /pathname === `\/public\/\$\{sourceToken\}`/u,
  "Remotion must serve the token through staticFile's /public path"
);

assert.deepEqual(STYLE_IDS, ["social_pop", "neo_editorial", "tech_motion"]);
assert.deepEqual(SEMANTIC_PRESET_IDS, ["knowledge_focus", "slide_teacher", "classroom_value", "hook_impact", "process_rhythm", "result_close"]);
assert.deepEqual(LAYOUT_ZONES, ["top_banner", "upper_left", "upper_right", "middle_left", "middle_right"]);
assert.deepEqual(Object.keys(layoutGrid), LAYOUT_ZONES, "the resolver and renderer must consume one shared layout grid");
assert.deepEqual(MOTION_EVENT_SIZES, ["hero", "card", "chip"]);
assert.equal(EFFECT_REGISTRY_VERSION, 1);
assert.equal(effectRegistry.version, EFFECT_REGISTRY_VERSION);
assert.doesNotThrow(() => validateEffectRegistry(effectRegistry, EFFECT_RENDERER_IDS));
const invalidRegistry = JSON.parse(JSON.stringify(effectRegistry));
invalidRegistry.components[0].variants = [];
assert.throws(() => validateEffectRegistry(invalidRegistry, EFFECT_RENDERER_IDS), /variant/u);
const missingRendererRegistry = JSON.parse(JSON.stringify(effectRegistry));
missingRendererRegistry.components[0].renderer = "missingRenderer";
assert.throws(() => validateEffectRegistry(missingRendererRegistry, EFFECT_RENDERER_IDS), /renderer/u);
const missingPresetRegistry = JSON.parse(JSON.stringify(effectRegistry));
delete missingPresetRegistry.semanticPresets.knowledge_focus;
assert.throws(() => validateEffectRegistry(missingPresetRegistry, EFFECT_RENDERER_IDS), /preset/u);
assert.deepEqual(
  new Set(effectRegistry.components.map((component) => component.renderer)),
  new Set(EFFECT_RENDERER_IDS),
  "the registry must declare every renderer contract required by the component set"
);
assert.deepEqual(Object.keys(stylePacks), STYLE_IDS);
assert.equal(new Set(Object.values(stylePacks).map((pack) => pack.motionGrammar)).size, 3);
assert.equal(new Set(Object.values(stylePacks).map((pack) => pack.palette.accent)).size, 3);
for (const styleId of STYLE_IDS) {
  const pack = stylePacks[styleId];
  assert.equal(pack.id, styleId);
  assert.equal(pack.kind, "design_system", "styles are extensible design systems, not fixed templates");
  assert.equal(pack.version, 1);
  assert.ok(pack.displayName.length >= 4);
  assert.ok(pack.supportedEvents.includes("hook"));
  assert.ok(pack.supportedEvents.includes("keyword"));
  assert.ok(pack.supportedEvents.includes("scene"));
  assert.ok(pack.supportedEvents.includes("result"));
  assert.ok(pack.video.scale >= 1 && pack.video.scale < 1.1);
  assert.ok(pack.video.pulseDivisor > 0);
  assert.match(pack.video.overlay, /^linear-gradient\(/u);
  assert.ok(pack.caption.maxWordsPerPage >= 4 && pack.caption.maxWordsPerPage <= 12);
}

const manifest = normalizeMotionManifest({
  version: 1,
  semanticPresetId: "knowledge_focus",
  styleId: "social_pop",
  deterministicSeed: "course-clip-a",
  durationMs: 15_680,
  title: "扫洗一体，适合什么场景？",
  sourceFile: "source.mp4",
  director: { provider: "bailian", model: "qwen-plus", version: 1 },
  captions: [
    { text: "它", startMs: 0, endMs: 150 },
    { text: "是", startMs: 150, endMs: 590 },
    { text: "扫洗一体", startMs: 590, endMs: 1_380 }
  ],
  events: [
    { type: "hook", text: "扫洗一体适合什么场景？", startMs: 0, endMs: 2_300, zone: "top_banner", size: "hero", priority: 3, x: 0.91 },
    { type: "keyword", text: "扫洗一体", icon: "spark", startMs: 590, endMs: 2_400, zone: "top_banner", size: "chip", priority: 2 },
    { type: "step", text: "边刷收集垃圾", icon: "brush", startMs: 3_000, endMs: 4_500, zone: "middle_right", size: "chip", priority: 2 },
    { type: "scene", text: "办公场景", icon: "office", startMs: 12_500, endMs: 14_200, zone: "upper_right", size: "chip", priority: 2 },
    { type: "result", text: "办公＋商用", startMs: 14_200, endMs: 15_680, zone: "top_banner", size: "card", priority: 3 }
  ],
  focusRects: [{ startMs: 3_000, endMs: 6_000, x: 0.02, y: 0.3, width: 0.52, height: 0.26 }],
  protectedRects: [{ role: "teacher", startMs: 0, endMs: 15_680, x: 0.55, y: 0.32, width: 0.28, height: 0.42 }]
});

assert.equal(manifest.width, 1080);
assert.equal(manifest.height, 1920);
assert.equal(manifest.fps, 30);
assert.equal(manifest.durationInFrames, 471);
assert.equal(manifest.events.length, 4, "a lower-priority keyword repeated by the active hook must be removed");
assert.equal(manifest.director.provider, "bailian");
assert.equal(manifest.semanticPresetId, "knowledge_focus");
assert.equal(manifest.effectRegistryVersion, EFFECT_REGISTRY_VERSION);
assert.equal(manifest.events[0].zone, "top_banner");
assert.equal(manifest.events[0].preferredZone, "top_banner", "the AI preference must remain distinct from final local placement");
assert.equal(manifest.events.some((event) => event.type === "keyword" && event.text === "扫洗一体"), false);
assert.equal(Object.hasOwn(manifest.events[0], "x"), false, "the model must not control arbitrary pixel coordinates");
assert.ok(manifest.events.every((event) => LAYOUT_ZONES.includes(event.zone)));
assert.ok(manifest.events.every((event) => MOTION_EVENT_SIZES.includes(event.size)));
assert.ok(manifest.events.every((event) => EFFECT_RENDERER_IDS.includes(event.effect.renderer)));
const placedStep = manifest.events.find((event) => event.type === "step");
assert.equal(placedStep.preferredZone, "middle_right");
assert.notEqual(placedStep.zone, placedStep.preferredZone, "AI placement must move away from the visible teacher");
assert.equal(manifest.protectedRects[0].role, "teacher");
assert.equal(manifest.focusRects.length, 1);
assert.equal(frameForMs(1_000, 30), 30);
assert.equal(publicFilenameForSource("C:\\private\\input.WEBM"), "source.webm");
assert.throws(() => publicFilenameForSource("input.txt"), /unsupported/u);
assert.ok(MOTION_EVENT_TYPES.has("emphasis"));
assert.equal(JSON.stringify(manifest).includes(":\\"), false);
const completeCaptionText = "这是一条超过二十四个字但仍然必须完整保留的合法词级字幕内容";
assert.equal(
  normalizeMotionManifest({
    ...manifest,
    captions: [{ text: completeCaptionText, startMs: 0, endMs: 1_000 }]
  }).captions[0].text,
  completeCaptionText,
  "the public contract must validate caption text without silently truncating it"
);

const repeatedPlan = {
  ...manifest,
  semanticPresetId: "knowledge_focus",
  deterministicSeed: "repeatable-seed",
  focusRects: [],
  protectedRects: [],
  events: [
    { type: "keyword", text: "边刷", startMs: 1_000, endMs: 1_800, zone: "upper_left", size: "chip", priority: 2 },
    { type: "keyword", text: "吸水", startMs: 2_000, endMs: 2_800, zone: "upper_left", size: "chip", priority: 2 },
    { type: "keyword", text: "清洁", startMs: 3_000, endMs: 3_800, zone: "upper_left", size: "chip", priority: 2 }
  ]
};
const deterministicA = normalizeMotionManifest(repeatedPlan);
const deterministicB = normalizeMotionManifest(repeatedPlan);
assert.equal(deterministicA.events.length, repeatedPlan.events.length, "the repeat cap must select another variant instead of losing safe events");
assert.deepEqual(deterministicA.events.map((event) => event.effect), deterministicB.events.map((event) => event.effect));
for (let index = 1; index < deterministicA.events.length; index += 1) {
  assert.notEqual(deterministicA.events[index - 1].effect.variantId, deterministicA.events[index].effect.variantId, "recent variants must respect the repetition cap");
}
const editorialPlan = normalizeMotionManifest({ ...repeatedPlan, styleId: "neo_editorial" });
assert.deepEqual(
  deterministicA.events.map(({ type, text, startMs, endMs, priority, preferredZone, size }) => ({ type, text, startMs, endMs, priority, preferredZone, size })),
  editorialPlan.events.map(({ type, text, startMs, endMs, priority, preferredZone, size }) => ({ type, text, startMs, endMs, priority, preferredZone, size })),
  "one semantic plan must be reusable across visual design systems"
);
assert.notDeepEqual(
  deterministicA.events.map((event) => event.effect.variantId),
  editorialPlan.events.map((event) => event.effect.variantId),
  "the visual design system must decide how the semantic plan is rendered"
);

const legacyManifest = normalizeMotionManifest({
  version: 1,
  styleId: "social_pop",
  durationMs: 2_000,
  title: "旧版配方",
  sourceFile: "source.mp4",
  captions: [],
  events: [{ type: "hook", text: "旧版仍可渲染", startMs: 0, endMs: 1_200 }],
  focusRects: []
});
assert.equal(legacyManifest.semanticPresetId, "knowledge_focus");
assert.equal(legacyManifest.events.length, 1);
assert.ok(legacyManifest.events[0].effect.variantId);

const edgeFocus = normalizeMotionManifest({
  ...manifest,
  focusRects: [{ startMs: 100, endMs: 200, x: 1, y: 1, width: 1, height: 1 }]
}).focusRects[0];
assert.equal(edgeFocus.x, 0.95);
assert.equal(edgeFocus.y, 0.95);
assert.ok(Math.abs(edgeFocus.width - 0.05) < Number.EPSILON);
assert.ok(Math.abs(edgeFocus.height - 0.05) < Number.EPSILON);

assert.throws(
  () => normalizeMotionManifest({ ...manifest, styleId: "purple_rectangle" }),
  /style/u
);
assert.throws(
  () => normalizeMotionManifest({ ...manifest, events: [{ type: "confetti_forever", startMs: 0, endMs: 100 }] }),
  /event/u
);
assert.throws(
  () => normalizeMotionManifest({ ...manifest, sourceFile: "C:\\private\\source.mp4" }),
  /source/u
);
assert.throws(
  () => normalizeMotionManifest({ ...manifest, events: [{ ...manifest.events[0], preferredZone: "caption_bottom", zone: "caption_bottom" }] }),
  /zone/u
);
const fullyProtected = normalizeMotionManifest({
  ...manifest,
  events: [{ type: "keyword", text: "不应遮挡主体", startMs: 4_800, endMs: 5_600, zone: "middle_right" }],
  protectedRects: [{ role: "full_frame", startMs: 0, endMs: 15_680, x: 0, y: 0, width: 1, height: 0.75 }]
});
assert.equal(fullyProtected.events.length, 0, "an event must be dropped when every safe design zone is protected");
const priorityResolved = normalizeMotionManifest({
  ...manifest,
  focusRects: [],
  protectedRects: [],
  events: [
    { type: "keyword", text: "普通关键词", startMs: 0, endMs: 3_000, zone: "upper_left", priority: 1 },
    { type: "scene", text: "普通场景", startMs: 0, endMs: 3_000, zone: "upper_right", priority: 1 },
    { type: "warning", text: "关键提醒", startMs: 1_000, endMs: 2_000, zone: "top_banner", priority: 3 }
  ]
});
assert.equal(priorityResolved.events.some((event) => event.text === "关键提醒"), true, "higher-priority AI direction must win an overlap even when it starts later");
const equalPriorityDuplicate = normalizeMotionManifest({
  ...manifest,
  focusRects: [],
  protectedRects: [],
  events: [
    { type: "keyword", text: "办公/商用场景", startMs: 9_000, endMs: 11_000, zone: "upper_left", priority: 2 },
    { type: "scene", text: "商用场景", startMs: 9_100, endMs: 10_900, zone: "upper_right", priority: 2 }
  ]
});
assert.equal(equalPriorityDuplicate.events.length, 1, "equal-priority semantic duplicates must not stack in separate zones");

async function verifyCompositionBuild() {
  const { bundle } = await import("@remotion/bundler");
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-remotion-self-check-"));
  const publicDir = path.join(temporaryRoot, "public");
  fs.mkdirSync(publicDir);
  try {
    const serverBundle = path.join(temporaryRoot, "video-template.cjs");
    await esbuild.build({
      entryPoints: [path.join(desktopDir, "remotion-packaging", "video-template.tsx")],
      outfile: serverBundle,
      bundle: true,
      format: "cjs",
      platform: "node",
      logLevel: "silent"
    });
    const {
      findActiveCaptionIndex,
      REGISTERED_RENDERER_IDS,
      RegisteredEventEffect,
      resolveRegisteredEffect
    } = require(serverBundle);
    assert.equal(typeof RegisteredEventEffect, "function");
    const timedCaptions = [
      { text: "第一句", startMs: 100, endMs: 500 },
      { text: "第二句", startMs: 800, endMs: 1_100 }
    ];
    assert.equal(findActiveCaptionIndex(timedCaptions, 300), 0);
    assert.equal(findActiveCaptionIndex(timedCaptions, 650), -1, "caption gaps must not retain the preceding cue");
    assert.equal(findActiveCaptionIndex(timedCaptions, 1_200), -1, "the final caption must not remain after its end");
    assert.deepEqual(new Set(REGISTERED_RENDERER_IDS), new Set(EFFECT_RENDERER_IDS), "every registry renderer id must have a runtime implementation");
    const keywordComponent = effectRegistry.components.find((component) => component.id === "keyword_sticker");
    const sameStyleVariants = keywordComponent.variants.filter((variant) => variant.styles.includes("social_pop"));
    assert.ok(sameStyleVariants.length >= 2);
    const eventForVariant = (variant) => ({
      type: "keyword",
      text: "边刷收集垃圾",
      startMs: 1_000,
      endMs: 2_000,
      icon: "brush",
      ordinal: 1,
      preferredZone: "upper_left",
      zone: "upper_left",
      size: "chip",
      priority: 2,
      reason: "与讲解同步",
      effect: {
        registryVersion: effectRegistry.version,
        componentId: keywordComponent.id,
        variantId: variant.id,
        renderer: keywordComponent.renderer,
        motion: variant.motion,
        surface: variant.surface
      }
    });
    const renderVariant = (event, definition) => renderToStaticMarkup(React.createElement(RegisteredEventEffect, {
      event,
      pack: stylePacks.social_pop,
      progress: 0.75,
      definition
    }));
    const firstEvent = eventForVariant(sameStyleVariants[0]);
    const firstDefinition = resolveRegisteredEffect(
      firstEvent.effect,
      stylePacks.social_pop.id,
      "event",
      firstEvent
    );
    const firstMarkup = renderVariant(firstEvent);
    assert.equal(
      renderVariant(firstEvent, firstDefinition),
      firstMarkup,
      "pre-resolved registry definitions must preserve rendered DOM"
    );
    const secondMarkup = renderVariant(eventForVariant(sameStyleVariants[1]));
    assert.notEqual(firstMarkup, secondMarkup, "two compatible variants in one style must render distinguishable DOM and styles");
    assert.match(firstMarkup, new RegExp(`data-effect-variant="${sameStyleVariants[0].id}"`, "u"));
    assert.equal(renderVariant({
      ...eventForVariant(sameStyleVariants[0]),
      effect: { ...eventForVariant(sameStyleVariants[0]).effect, variantId: "unknown_variant" }
    }), "", "an unknown variant must be dropped by the runtime allowlist");
    assert.equal(renderVariant({
      ...eventForVariant(sameStyleVariants[0]),
      effect: { ...eventForVariant(sameStyleVariants[0]).effect, renderer: "unknownRenderer" }
    }), "", "an unknown renderer must be dropped by the runtime allowlist");
    await bundle({
      entryPoint: path.join(desktopDir, "remotion-packaging", "index.ts"),
      publicDir,
      outDir: path.join(temporaryRoot, "bundle"),
      enableCaching: false,
      onProgress: () => undefined
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

verifyCompositionBuild()
  .then(() => console.log("remotion packaging self-check passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
