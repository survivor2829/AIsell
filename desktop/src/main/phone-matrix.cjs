// 手机矩阵 (user project of 2026-10-30): 30–50 Android phones on a USB hub, managed from this app.
// Part 1: find ADB, watch which phones are plugged in, read each phone's model, Android version,
// battery and screen, and keep the user's name, number, note and group for each phone on this
// computer. Everything goes through Google's ADB; nothing from other group-control products is used.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { writeJsonAtomic } = require("./atomic-file.cjs");

const POLL_MS = 3000;
const DETAIL_REFRESH_MS = 30000;
const DETAIL_CONCURRENCY = 6;

// Where adb may be: one shipped with the app, one the user pointed to, the Android SDK, PATH.
function adbCandidates({ resourcesPath = process.resourcesPath || "", env = process.env } = {}) {
  return [
    env.XIAOXI_ADB_PATH,
    resourcesPath && path.join(resourcesPath, "platform-tools", "adb.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Android", "Sdk", "platform-tools", "adb.exe"),
    env.ANDROID_HOME && path.join(env.ANDROID_HOME, "platform-tools", "adb.exe"),
    "D:\\Laixi\\tools\\platform-tools\\adb.exe",
    "C:\\Laixi\\tools\\platform-tools\\adb.exe"
  ].filter(Boolean);
}

function findAdb(options = {}, exists = fs.existsSync) {
  return adbCandidates(options).find((candidate) => exists(candidate)) || "";
}

// `adb devices -l`: one line per phone, "<serial> <state> key:value ...".
function parseDevices(text) {
  const devices = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(device|unauthorized|offline|authorizing|no permissions|recovery|sideload|bootloader)\b(.*)$/);
    if (!match) continue;
    const fields = Object.fromEntries([...match[3].matchAll(/(\w+):(\S+)/g)].map((pair) => [pair[1], pair[2]]));
    devices.push({ serial: match[1], state: match[2], model: (fields.model || "").replace(/_/g, " "), transport: fields.transport_id || "", usb: fields.usb || "" });
  }
  return devices;
}

function parseBattery(text) {
  const level = String(text || "").match(/^\s*level:\s*(\d+)/m);
  const status = String(text || "").match(/^\s*status:\s*(\d+)/m);
  return { battery: level ? Math.max(0, Math.min(100, Number(level[1]))) : null, charging: status ? ["2", "5"].includes(status[1]) : null };
}

function parseSize(text) {
  const sizes = [...String(text || "").matchAll(/(Physical|Override) size:\s*(\d+)x(\d+)/g)].map((m) => ({ kind: m[1], width: Number(m[2]), height: Number(m[3]) }));
  const size = sizes.find((s) => s.kind === "Override") || sizes[0];
  return size ? { width: size.width, height: size.height } : null;
}

function createPhoneMatrix({ dataDir, onChange = () => {}, adbPath = findAdb(), run = runFile, isLaixiRunning = laixiRunning, now = Date.now,
  setTimer = setInterval, clearTimer = clearInterval }) {
  const file = path.join(dataDir, "devices.json");
  let saved = { version: 1, devices: {}, groups: [] };
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value?.version === 1 && value.devices && typeof value.devices === "object") saved = { version: 1, devices: value.devices, groups: Array.isArray(value.groups) ? value.groups : [] };
  } catch { /* First run: nothing saved yet. */ }
  const save = () => { try { fs.mkdirSync(dataDir, { recursive: true }); writeJsonAtomic(file, saved); } catch { /* Names are kept in memory until the next save works. */ } };
  const live = new Map(); // serial -> { state, model, detail, detailAt }
  let error = "", laixi = false, timer = null, polling = false;

  const adb = (args, timeout = 8000) => run(adbPath, args, timeout);
  const emit = () => { try { onChange(snapshot()); } catch { /* The page reads the state again when it opens. */ } };

  function remember(serial, model) {
    if (saved.devices[serial]) return false;
    const numbers = Object.values(saved.devices).map((device) => Number(device.number) || 0);
    saved.devices[serial] = { number: (numbers.length ? Math.max(...numbers) : 0) + 1, name: model || "", note: "", group: "", firstSeenAt: new Date(now()).toISOString() };
    return true;
  }

  async function readDetail(serial) {
    const shell = (command) => adb(["-s", serial, "shell", command]).catch(() => "");
    const [props, battery, size] = await Promise.all([
      shell("getprop ro.product.brand; getprop ro.product.model; getprop ro.build.version.release"),
      shell("dumpsys battery"),
      shell("wm size")
    ]);
    const [brand = "", model = "", android = ""] = String(props).split(/\r?\n/).map((value) => value.trim());
    return { brand, model, android, ...parseBattery(battery), screen: parseSize(size) };
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      laixi = await Promise.resolve(isLaixiRunning()).catch(() => false);
      if (!adbPath) { error = "没找到 ADB 工具，暂时连不上手机。"; live.clear(); emit(); return; }
      const devices = parseDevices(await adb(["devices", "-l"]));
      error = "";
      let changed = false;
      const seen = new Set();
      for (const device of devices) {
        seen.add(device.serial);
        const current = live.get(device.serial) || {};
        live.set(device.serial, { ...current, state: device.state, model: device.model || current.model || "" });
        if (device.state === "device") changed = remember(device.serial, device.model) || changed;
      }
      for (const serial of [...live.keys()]) if (!seen.has(serial)) live.delete(serial);
      // Details for online phones, a few at a time, refreshed now and then for the battery.
      const due = [...live.entries()].filter(([, item]) => item.state === "device" && (!item.detailAt || now() - item.detailAt > DETAIL_REFRESH_MS)).map(([serial]) => serial);
      for (let i = 0; i < due.length; i += DETAIL_CONCURRENCY) {
        await Promise.all(due.slice(i, i + DETAIL_CONCURRENCY).map(async (serial) => {
          const detail = await readDetail(serial);
          const item = live.get(serial);
          if (item) live.set(serial, { ...item, detail, detailAt: now() });
          const record = saved.devices[serial];
          if (record && !record.name && detail.model) { record.name = detail.model; changed = true; }
        }));
      }
      if (changed) save();
    } catch (failure) {
      error = failure?.code === "ENOENT" ? "ADB 工具打不开，请重新安装软件。" : "读取手机列表失败，稍后会自动重试。";
    } finally {
      polling = false;
      emit();
    }
  }

  function snapshot() {
    const devices = [...new Set([...live.keys(), ...Object.keys(saved.devices)])].map((serial) => {
      const item = live.get(serial), record = saved.devices[serial] || {};
      return {
        serial, state: item?.state || "disconnected", number: record.number || null, name: record.name || item?.detail?.model || item?.model || serial,
        note: record.note || "", group: record.group || "", brand: item?.detail?.brand || "", model: item?.detail?.model || item?.model || "",
        android: item?.detail?.android || "", battery: item?.detail?.battery ?? null, charging: item?.detail?.charging ?? null, screen: item?.detail?.screen || null
      };
    }).sort((a, b) => (a.number || 9999) - (b.number || 9999) || a.serial.localeCompare(b.serial));
    // Only groups some phone is in; an emptied group drops out of the filter.
    return { adb: Boolean(adbPath), error, laixiRunning: laixi, groups: [...new Set(devices.map((device) => device.group).filter(Boolean))], devices };
  }

  function update(serial, fields = {}) {
    const record = saved.devices[String(serial)];
    if (!record) throw Object.assign(new Error("没有找到这部手机。"), { code: "PHONE_NOT_FOUND" });
    if (fields.name !== undefined) record.name = String(fields.name).trim().slice(0, 30);
    if (fields.note !== undefined) record.note = String(fields.note).trim().slice(0, 100);
    if (fields.number !== undefined) {
      const number = Math.round(Number(fields.number));
      if (!Number.isInteger(number) || number < 1 || number > 9999) throw Object.assign(new Error("编号要是 1–9999 的数字。"), { code: "PHONE_NUMBER_INVALID" });
      record.number = number;
    }
    if (fields.group !== undefined) {
      const group = String(fields.group).trim().slice(0, 20);
      record.group = group;
    }
    save(); emit();
    return snapshot();
  }

  // A phone that is no longer plugged in can be taken off the list.
  function forget(serial) {
    if (live.get(String(serial))?.state === "device") throw Object.assign(new Error("这部手机还连着，拔掉后才能移除。"), { code: "PHONE_STILL_CONNECTED" });
    delete saved.devices[String(serial)];
    save(); emit();
    return snapshot();
  }

  return {
    snapshot, update, forget, poll,
    start() { if (!timer) { void poll(); timer = setTimer(() => void poll(), POLL_MS); timer?.unref?.(); } },
    stop() { clearTimer(timer); timer = null; }
  };
}

function runFile(file, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error && !stdout) reject(error); else resolve(String(stdout || ""));
    });
  });
}

// 来喜 and this app both drive the phones through ADB; running both makes phones drop off.
function laixiRunning() {
  if (os.platform() !== "win32") return Promise.resolve(false);
  return runFile("tasklist.exe", ["/FI", "IMAGENAME eq Laixi.exe", "/NH"], 5000).then((out) => /Laixi\.exe/i.test(out)).catch(() => false);
}

module.exports = { createPhoneMatrix, findAdb, adbCandidates, parseDevices, parseBattery, parseSize };
