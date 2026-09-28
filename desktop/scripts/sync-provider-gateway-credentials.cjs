const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { app, safeStorage } = require("electron");
const { cloudConfig } = require("../src/main/cloud-config.cjs");
const { createDeepSeekKeyStore } = require("../src/main/deepseek-api.cjs");
const { createLicenseStore } = require("../src/main/license-auth-ipc.cjs");
const { createProviderGatewayClient } = require("../src/main/provider-gateway-client.cjs");
const {
  createVolcengineAsrStore,
  createVolcengineTtsKeyStore
} = require("../src/main/volcengine-tts-settings.cjs");

const TARGETS = Object.freeze({
  XIAOXI_GATEWAY_DEEPSEEK_API_KEY: "deepseek",
  XIAOXI_GATEWAY_VOLCENGINE_ARK_API_KEY: "volcengineArk",
  XIAOXI_GATEWAY_VOLCENGINE_TTS_API_KEY: "volcengineTts",
  XIAOXI_GATEWAY_VOLCENGINE_ASR_APP_ID: "volcengineAsrAppId",
  XIAOXI_GATEWAY_VOLCENGINE_ASR_ACCESS_TOKEN: "volcengineAsrAccessToken",
  XIAOXI_GATEWAY_APIMART_API_KEY: "apimart"
});

function encoded(value) {
  const normalized = String(value || "").trim();
  if (!normalized || /[\r\n\0]/u.test(normalized)) throw new Error("A required local provider credential is unavailable");
  return Buffer.from(normalized, "utf8").toString("base64");
}

function readCredential(label, operation) {
  try {
    return operation();
  } catch {
    throw new Error(`${label} credential could not be decrypted for the current Windows user`);
  }
}

function optionalCredential(operation) {
  try { return operation(); } catch { return null; }
}

function writeVerificationReceipt(summary) {
  const file = path.join(__dirname, "..", ".build", "provider-gateway-verification.json");
  const temporary = `${file}.new`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify({ at: new Date().toISOString(), ...summary }, null, 2));
  fs.renameSync(temporary, file);
}

function remoteProgram(payload) {
  const data = JSON.stringify(payload);
  return `import base64,datetime,json,os,pwd,grp,shutil,stat,subprocess,tempfile\n`
    + `payload=json.loads(${JSON.stringify(data)})\n`
    + `allowed=set(${JSON.stringify(Object.keys(TARGETS))})\n`
    + `required={'XIAOXI_GATEWAY_VOLCENGINE_TTS_API_KEY'}\n`
    + `if not required.issubset(payload) or not set(payload).issubset(allowed): raise SystemExit('credential set mismatch')\n`
    + `values={k:base64.b64decode(v,validate=True).decode('utf-8') for k,v in payload.items()}\n`
    + `if any((not v) or ('\\n' in v) or ('\\r' in v) or ('\\0' in v) for v in values.values()): raise SystemExit('invalid credential')\n`
    + `target='/etc/ai-maintenance/provider-gateway.env'\n`
    + `stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')\n`
    + `backup=target+'.bak-'+stamp\n`
    + `shutil.copy2(target,backup)\n`
    + `lines=open(target,encoding='utf-8').read().splitlines()\n`
    + `seen=set(); out=[]\n`
    + `for line in lines:\n`
    + ` key=line.split('=',1)[0].strip() if '=' in line and not line.lstrip().startswith('#') else ''\n`
    + ` if key in values: out.append(key+'='+values[key]); seen.add(key)\n`
    + ` else: out.append(line)\n`
    + `for key in payload:\n`
    + ` if key not in seen: out.append(key+'='+values[key])\n`
    + `directory=os.path.dirname(target)\n`
    + `fd,temp=tempfile.mkstemp(prefix='.provider-gateway.',dir=directory,text=True)\n`
    + `try:\n`
    + ` with os.fdopen(fd,'w',encoding='utf-8',newline='\\n') as stream: stream.write('\\n'.join(out)+'\\n'); stream.flush(); os.fsync(stream.fileno())\n`
    + ` os.chown(temp,pwd.getpwnam('root').pw_uid,grp.getgrnam('ai-gateway').gr_gid); os.chmod(temp,0o640); os.replace(temp,target)\n`
    + `finally:\n`
    + ` if os.path.exists(temp): os.unlink(temp)\n`
    + `subprocess.run(['systemctl','restart','ai-provider-gateway'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\n`
    + `active=subprocess.run(['systemctl','is-active','--quiet','ai-provider-gateway']).returncode==0\n`
    + `print(json.dumps({'ok':active,'backup':backup,'mode':oct(stat.S_IMODE(os.stat(target).st_mode)),'owner':pwd.getpwuid(os.stat(target).st_uid).pw_name,'group':grp.getgrgid(os.stat(target).st_gid).gr_name},separators=(',',':')))\n`
    + `if not active: raise SystemExit(1)\n`;
}

function statusProgram() {
  return `import json\n`
    + `target='/etc/ai-maintenance/provider-gateway.env'\n`
    + `values={}\n`
    + `for raw in open(target,encoding='utf-8'):\n`
    + ` line=raw.strip()\n`
    + ` if '=' in line and not line.startswith('#'):\n`
    + `  key,value=line.split('=',1); values[key.strip()]=value.strip()\n`
    + `result={'deepseek':bool(values.get('XIAOXI_GATEWAY_DEEPSEEK_API_KEY')),'bailian':bool(values.get('XIAOXI_GATEWAY_BAILIAN_API_KEY')),'volcengine_ark':bool(values.get('XIAOXI_GATEWAY_VOLCENGINE_ARK_API_KEY') or values.get('XIAOXI_GATEWAY_VOLCENGINE_API_KEY')),'volcengine_tts':bool(values.get('XIAOXI_GATEWAY_VOLCENGINE_TTS_API_KEY')),'volcengine_asr':bool(values.get('XIAOXI_GATEWAY_VOLCENGINE_ASR_API_KEY') or (values.get('XIAOXI_GATEWAY_VOLCENGINE_ASR_APP_ID') and values.get('XIAOXI_GATEWAY_VOLCENGINE_ASR_ACCESS_TOKEN'))),'apimart':bool(values.get('XIAOXI_GATEWAY_APIMART_API_KEY'))}\n`
    + `print(json.dumps(result,separators=(',',':')))\n`;
}

function runRemote(program) {
  const config = cloudConfig({ developmentEdition: true });
  const sshDir = path.join(process.env.WINDIR || "C:/Windows", "System32", "OpenSSH");
  const sshKey = path.join(os.homedir(), ".ssh", "ai-release-server_ed25519");
  const host = `ubuntu@${new URL(config.origin).hostname}`;
  return spawnSync(path.join(sshDir, "ssh.exe"), [
    "-i", sshKey,
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    host,
    "sudo -n python3 -"
  ], {
    input: program,
    encoding: "utf8",
    windowsHide: true,
    timeout: 90_000,
    maxBuffer: 64 * 1024
  });
}

function silentWav() {
  const samples = 16_000;
  const dataBytes = samples * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + dataBytes, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(32_000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

async function verifyProviders(client, { onlyApimart = false } = {}) {
  const headers = (extra = {}) => ({ ...client.requestHeaders(), ...extra });
  const post = async (name, route, body, extraHeaders = {}, validate = async () => true) => {
    const operationId = randomUUID();
    let response;
    try {
      response = await client.fetch(client.url(route), {
        method: "POST",
        timeoutMs: 270_000,
        headers: headers({ "Content-Type": "application/json", "X-Xiaoxi-Operation-Id": operationId, ...extraHeaders }),
        body: JSON.stringify(body)
      });
    } catch {
      return { ok: false, code: `${name}_outcome_unknown`, retryable: false };
    }
    if (!response.ok) return { ok: false, code: `${name}_http_${response.status}`, retryable: response.status === 429 || response.status >= 500 };
    try {
      if (!await validate(response)) return { ok: false, code: `${name}_response_invalid`, retryable: false };
    } catch {
      return { ok: false, code: `${name}_response_invalid`, retryable: false };
    }
    return { ok: true, status: response.status };
  };
  const results = {};
  if (!onlyApimart) {
    results.deepseek = await post("deepseek", "/deepseek/chat/completions", {
      model: "deepseek-v4-flash", messages: [{ role: "user", content: "只回复：服务正常" }], max_tokens: 16, temperature: 0
    }, {}, async (response) => Array.isArray((await response.json())?.choices));
    results.volcengine_ark = await post("volcengine_ark", "/volcengine/ark/chat/completions", {
      model: "doubao-seed-2-1-pro-260628", messages: [{ role: "user", content: "只回复：服务正常" }], max_tokens: 16, temperature: 0
    }, {}, async (response) => Array.isArray((await response.json())?.choices));
    results.volcengine_asr = await post("volcengine_asr", "/volcengine/asr/recognize/flash", {
      user: { uid: "xiaoxi-provider-verification" },
      audio: { data: silentWav().toString("base64") },
      request: { model_name: "bigmodel", show_utterances: true }
    }, {
      "X-Api-Resource-Id": "volc.bigasr.auc_turbo",
      "X-Api-Request-Id": randomUUID(),
      "X-Api-Sequence": "-1"
    }, async (response) => Boolean(await response.json()));
    results.volcengine_tts = await post("volcengine_tts", "/volcengine/tts/sse", {
      user: { uid: "xiaoxi-provider-verification" },
      req_params: {
        text: "服务正常。", speaker: "zh_female_xiaohe_uranus_bigtts", sample_rate: 24_000,
        audio_params: { format: "pcm", sample_rate: 24_000, speech_rate: 0, loudness_rate: 0 },
        additions: JSON.stringify({ disable_markdown_filter: true })
      }
    }, {
      Accept: "text/event-stream",
      "X-Api-Resource-Id": "seed-tts-2.0",
      "X-Api-Request-Id": randomUUID(),
      "X-Control-Require-Usage-Tokens-Return": "text_words"
    }, async (response) => /"code"\s*:\s*20000000/u.test(await response.text()));
  }
  results.apimart = await post("apimart", "/apimart/images/generations", {
    model: "gpt-image-2", prompt: "A plain white square with a small gray circle, no text, verification image.", n: 1, size: "1:1", resolution: "1k"
  }, {}, async (response) => {
    const payload = await response.json();
    const nodes = Array.isArray(payload?.data) ? payload.data : [payload?.data];
    return nodes.some((node) => node && typeof node === "object" && (node.task_id || node.id));
  });
  return results;
}

async function main() {
  app.setPath("userData", path.join(app.getPath("appData"), "xiaoxi-active-touch-test"));
  await app.whenReady();
  if (process.argv.includes("--status")) {
    const status = runRemote(statusProgram());
    if (status.status !== 0) throw new Error(`Provider gateway status failed (${status.status ?? "no status"})`);
    console.log(String(status.stdout || "").trim());
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows secure storage is unavailable");
  const userData = app.getPath("userData");
  if (process.argv.includes("--capabilities") || process.argv.includes("--verify-providers") || process.argv.includes("--verify-apimart")) {
    const config = cloudConfig({ developmentEdition: true });
    const client = createProviderGatewayClient({
      config,
      licenseStore: createLicenseStore({ rootDir: path.join(userData, "data"), safeStorage }),
      appId: config.appId,
      channel: config.channel,
      version: require("../package.json").version,
      buildId: "provider-gateway-verification",
      installId: randomUUID()
    });
    try {
      await client.initialize({ force: true, verify: true });
      const state = client.status();
      const summary = { ready: state.ready, code: state.code, capabilities: state.capabilities };
      if (!state.ready) throw new Error(`Provider gateway session is unavailable (${state.code || "unknown"})`);
      if (process.argv.includes("--verify-providers")) summary.providers = await verifyProviders(client);
      if (process.argv.includes("--verify-apimart")) summary.providers = await verifyProviders(client, { onlyApimart: true });
      if (summary.providers) writeVerificationReceipt(summary);
      console.log(JSON.stringify(summary));
      if (summary.providers && Object.values(summary.providers).some((result) => !result.ok)) {
        throw new Error("One or more provider verification calls failed; no call was retried");
      }
    } finally {
      client.close();
    }
    return;
  }
  const contentDir = path.join(userData, "content-engine");
  const asr = optionalCredential(() => createVolcengineAsrStore({ rootDir: contentDir, safeStorage }).read());
  const secrets = {
    deepseek: optionalCredential(() => createDeepSeekKeyStore({ rootDir: path.join(userData, "data"), safeStorage }).read()),
    volcengineArk: optionalCredential(() => createVolcengineTtsKeyStore({ rootDir: contentDir, safeStorage, filename: "volcengine-ark-api-key.bin" }).read()),
    volcengineTts: readCredential("Volcengine TTS", () => createVolcengineTtsKeyStore({ rootDir: contentDir, safeStorage }).read()),
    volcengineAsrAppId: asr?.appId,
    volcengineAsrAccessToken: asr?.accessToken,
    apimart: optionalCredential(() => safeStorage.decryptString(require("node:fs").readFileSync(path.join(userData, "product-detail", "product-detail-apimart-key.bin"))))
  };
  const payload = Object.fromEntries(Object.entries(TARGETS)
    .filter(([, local]) => secrets[local])
    .map(([remote, local]) => [remote, encoded(secrets[local])]));
  const result = runRemote(remoteProgram(payload));
  if (result.status !== 0) throw new Error(`Provider gateway credential sync failed (${result.status ?? "no status"})`);
  const receipt = JSON.parse(String(result.stdout || "").trim());
  if (!receipt.ok || receipt.mode !== "0o640" || receipt.owner !== "root" || receipt.group !== "ai-gateway") {
    throw new Error("Provider gateway credential receipt failed validation");
  }
  console.log(JSON.stringify(receipt));
}

main().then(
  () => app.quit(),
  (error) => {
    console.error(String(error?.message || error));
    app.exit(1);
  }
);
