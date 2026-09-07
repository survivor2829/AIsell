// Keep the administrator endpoint private; this process owns the SSH tunnel.
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const ssh = path.join(process.env.WINDIR || "C:/Windows", "System32", "OpenSSH", "ssh.exe");
const { cloudConfig } = require("../src/main/cloud-config.cjs");
const host = new URL(cloudConfig({ developmentEdition: true }).origin).hostname;
const child = spawn(ssh, ["-N", "-i", path.join(os.homedir(), ".ssh", "ai-release-server_ed25519"),
  "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
  "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
  "-L", "127.0.0.1:18081:127.0.0.1:8081", `ubuntu@${host}`], { stdio: "inherit", windowsHide: true });
console.log("后台地址：http://127.0.0.1:18081；保持此窗口运行，Ctrl+C 关闭隧道。已有隧道时可直接打开该地址。");
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code || 0; });
process.on("SIGINT", () => child.kill());
