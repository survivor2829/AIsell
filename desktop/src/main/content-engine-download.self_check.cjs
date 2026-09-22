const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  registerContentEngineIpc
} = require("./content-engine-ipc.cjs");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoxi-content-download-"));
  const source = path.join(root, "candidate.mp4");
  const target = path.join(root, "saved.mp4");
  const cover = path.join(root, "cover.jpg");
  let saveTarget = target;
  fs.writeFileSync(source, "candidate-video");
  fs.writeFileSync(cover, "candidate-cover");

  try {
    const handlers = new Map();
    const calls = [];
    const ipcMain = {
      handle: (channel, handler) => handlers.set(channel, handler)
    };
    const controller = {
      status: () => ({ state: "ready", available: true, version: "test", capabilities: {}, code: "" }),
      resolveGeneratedVideoPath: async (candidateId, variant) => {
        calls.push(["resolveGeneratedVideoPath", candidateId, variant]);
        return {
          generated_video_id: candidateId,
          absolute_path: variant === "thumbnail" ? cover : source,
          available: true
        };
      },
      resolveFinishedPath: async (finishedVideoId) => {
        calls.push(["resolveFinishedPath", finishedVideoId]);
        return {
          finished_video_id: finishedVideoId,
          absolute_path: source,
          available: true
        };
      },
      onUpdate: () => () => undefined
    };
    const electron = {
      app: {
        getPath: (name) => {
          assert.equal(name, "downloads");
          return root;
        }
      },
      dialog: {
        showSaveDialog: async (...args) => {
          const options = args.at(-1);
          calls.push(["showSaveDialog", options]);
          return { canceled: false, filePath: saveTarget };
        }
      },
      shell: {
        showItemInFolder: () => undefined,
        openPath: async () => ""
      }
    };

    registerContentEngineIpc({
      controller,
      electron,
      app: electron.app,
      dialog: electron.dialog,
      shell: electron.shell,
      getMainWindow: () => null,
      ipcMain
    });

    const channel = "content-engine:download-candidate";
    assert.equal(handlers.has(channel), true, "download must have a dedicated IPC handler");
    const result = await handlers.get(channel)(null, {
      candidateId: "generated_video_99999999999999999999999999999999"
    });
    assert.deepEqual(result, {
      ok: true,
      data: {
        candidateId: "generated_video_99999999999999999999999999999999",
        canceled: false,
        filename: "saved.mp4"
      }
    });
    assert.equal(fs.readFileSync(target, "utf8"), "candidate-video");

    const finishedVideoId = "finished_88888888888888888888888888888888";
    const finishedChannel = "content-engine:download-finished";
    assert.equal(handlers.has(finishedChannel), true, "finished videos must support Save As");
    const finishedResult = await handlers.get(finishedChannel)(null, { finishedVideoId });
    assert.deepEqual(finishedResult, {
      ok: true,
      data: {
        finishedVideoId,
        canceled: false,
        filename: "saved.mp4"
      }
    });
    assert.equal(fs.readFileSync(target, "utf8"), "candidate-video");
    assert.deepEqual(
      calls.map((call) => call[0]),
      [
        "resolveGeneratedVideoPath",
        "showSaveDialog",
        "resolveFinishedPath",
        "showSaveDialog"
      ]
    );
    saveTarget = path.join(root, "我的封面");
    const coverResult = await handlers.get(channel)(null, {
      candidateId: "generated_video_99999999999999999999999999999999", variant: "thumbnail"
    });
    assert.equal(coverResult.ok, true);
    assert.equal(coverResult.data.filename, "我的封面.jpg");
    assert.equal(fs.readFileSync(`${saveTarget}.jpg`, "utf8"), "candidate-cover");
    assert.deepEqual(calls.at(-1)[1].filters, [{ name: "封面图片", extensions: ["jpg"] }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().then(
  () => console.log("content-engine-download self-check passed"),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  }
);
