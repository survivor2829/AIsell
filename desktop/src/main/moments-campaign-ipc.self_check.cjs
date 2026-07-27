const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createMomentsCampaignController } = require("./moments-campaign-ipc.cjs");

async function waitFor(read, predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("moments campaign self-check timed out");
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-"));
  const observations = ["a".repeat(64), "b".repeat(64)];
  let observationIndex = 0;
  let scrolls = 0;
  let releases = 0;
  const events = [];
  const controller = createMomentsCampaignController({
    baseDir: root,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "test-owner" } }),
      release: () => { releases += 1; }
    },
    logger: { event: (module, event) => events.push(`${module}:${event}`) },
    openMoments: async () => ({ ok: true }),
    scrollMoments: async () => {
      scrolls += 1;
      return { ok: true };
    },
    runStep: async (args) => {
      if (args[0] === "moments-dry-run") {
        const fingerprint = observations[Math.min(observationIndex, observations.length - 1)];
        observationIndex += 1;
        return {
          ok: true,
          post_snapshot: {
            observation_id: fingerprint,
            post_fingerprint: fingerprint
          },
          plan: { visible_post_count: 1 }
        };
      }
      return {
        ok: true,
        status: "verified",
        no_op: observationIndex === 1,
        real_action_attempted: observationIndex !== 1
      };
    }
  });

  assert.equal(controller.start({ maxPosts: 2 }).ok, true);
  const completed = await waitFor(
    () => controller.status().state,
    (state) => state.status === "completed"
  );
  assert.equal(completed.processed_count, 2);
  assert.equal(completed.liked_count, 1);
  assert.equal(completed.already_liked_count, 1);
  assert.equal(completed.scroll_count, 1);
  assert.equal(scrolls, 1);
  assert.equal(releases, 1);
  assert.equal(events.includes("moments:campaign.completed"), true);

  const persisted = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"));
  assert.equal(persisted.moments_campaign.status, "completed");

  const duplicateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moments-campaign-duplicate-"));
  const duplicateController = createMomentsCampaignController({
    baseDir: duplicateRoot,
    coordinator: {
      acquire: () => ({ ok: true, lock: { owner: "duplicate-owner" } }),
      release: () => undefined
    },
    logger: { event: () => undefined },
    openMoments: async () => ({ ok: true }),
    scrollMoments: async () => ({ ok: true }),
    runStep: async (args) => args[0] === "moments-dry-run"
      ? {
          ok: true,
          post_snapshot: {
            observation_id: "c".repeat(64),
            post_fingerprint: "c".repeat(64)
          }
        }
      : {
          ok: false,
          status: "blocked",
          blocked_reason: "moments_attempt_already_recorded",
          previous_status: "verified",
          real_action_attempted: false
        }
  });
  assert.equal(duplicateController.start({ maxPosts: 1 }).ok, true);
  const duplicateCompleted = await waitFor(
    () => duplicateController.status().state,
    (state) => state.status === "completed"
  );
  assert.equal(duplicateCompleted.processed_count, 1);
  assert.equal(duplicateCompleted.skipped_count, 1);

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(duplicateRoot, { recursive: true, force: true });
  console.log("moments campaign IPC self-check passed");
}

void main();
