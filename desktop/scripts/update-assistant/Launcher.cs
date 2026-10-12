// Windows Framework 4.x / C# 5. No NuGet, runtime install or customer script.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class Failure : Exception { internal Failure(string code) : base(code) {} }
public sealed class FileDigest { public string path; public string sha256; public long size; }
public sealed class Descriptor {
    public int schema; public string channel; public string appId; public string entry;
    public string mode; public List<FileDigest> files;
}
public sealed class RuntimeProfile {
    public string id; public string electron;
    public List<FileDigest> files;
}
public sealed class RuntimeCatalog { public int schema; public List<RuntimeProfile> profiles; }
public sealed class Message { public string phase; public int percent; public string code; }

internal static class VerifiedFiles
{
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
    internal static bool HashText(string value) { return value != null && Regex.IsMatch(value, "^[a-f0-9]{64}$"); }
    internal static string Hash(Stream stream) {
        using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }
    internal static string Hash(byte[] bytes) { using (var stream = new MemoryStream(bytes, false)) return Hash(stream); }
    internal static void Match(byte[] bytes, string expected) {
        if (!HashText(expected) || Hash(bytes) != expected) throw new Failure("trust_invalid");
    }
    internal static string Plain(string path) {
        var full = Path.GetFullPath(path);
        if (full.StartsWith(@"\\", StringComparison.Ordinal)) throw new Failure("path_invalid");
        for (var cursor = full; !String.IsNullOrEmpty(cursor); cursor = Path.GetDirectoryName(cursor)) {
            if ((File.Exists(cursor) || Directory.Exists(cursor)) &&
                (File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0) throw new Failure("path_invalid");
            if (cursor == Path.GetPathRoot(cursor)) break;
        }
        return full;
    }
    internal static string Child(string root, string relative) {
        if (String.IsNullOrEmpty(relative) || relative.Length > 500 || relative.Contains("\\") ||
            Regex.IsMatch(relative, "[\\x00-\\x1f<>:\"|?*]") || relative.StartsWith("/")) throw new Failure("path_invalid");
        foreach (var part in relative.Split('/'))
            if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" ") ||
                Regex.IsMatch(part, "^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)", RegexOptions.IgnoreCase)) throw new Failure("path_invalid");
        var full = Plain(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
        if (!full.StartsWith(Plain(root).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)) throw new Failure("path_invalid");
        return full;
    }
    internal static void Check(string root, FileDigest item) {
        if (item == null || !HashText(item.sha256) || item.size < 0 || item.size > 512L * 1024 * 1024) throw new Failure("trust_invalid");
        var file = Child(root, item.path);
        using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            if (stream.Length != item.size || Hash(stream) != item.sha256) throw new Failure("file_changed");
        }
    }
    internal static byte[] Resource(string name, int limit) {
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name)) {
            if (stream == null || stream.Length > limit) throw new Failure("build_incomplete");
            using (var output = new MemoryStream()) { stream.CopyTo(output); return output.ToArray(); }
        }
    }
    internal static string CreateSession(string id) {
        var parent = Plain(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AI获客更新助手"));
        var target = Child(parent, id);
        if (Directory.Exists(target) || File.Exists(target)) throw new Failure("session_exists");
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        var flags = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        security.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User, FileSystemRights.FullControl, flags, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, flags, PropagationFlags.None, AccessControlType.Allow));
        Directory.CreateDirectory(parent);
        Directory.CreateDirectory(target, security);
        Plain(target);
        return target; // No automatic recursive deletion in this prototype.
    }
    internal static void Extract(byte[] archive, Descriptor descriptor, string root) {
        if (descriptor.files == null || descriptor.files.Count == 0 || descriptor.files.Count > 4096) throw new Failure("trust_invalid");
        var expected = new Dictionary<string, FileDigest>(StringComparer.OrdinalIgnoreCase);
        long total = 0;
        foreach (var item in descriptor.files) {
            Child(root, item.path);
            if (!HashText(item.sha256) || item.size < 0 || item.size > 8 * 1024 * 1024 || expected.ContainsKey(item.path)) throw new Failure("trust_invalid");
            total += item.size; if (total > 32 * 1024 * 1024) throw new Failure("trust_invalid");
            expected.Add(item.path, item);
        }
        using (var input = new MemoryStream(archive, false))
        using (var zip = new ZipArchive(input, ZipArchiveMode.Read)) {
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in zip.Entries) {
                FileDigest item;
                if (!expected.TryGetValue(entry.FullName, out item) || !seen.Add(entry.FullName) || entry.Length != item.size ||
                    ((entry.ExternalAttributes >> 16) & 0xF000) == 0xA000) throw new Failure("payload_invalid");
                var target = Child(root, item.path); Directory.CreateDirectory(Path.GetDirectoryName(target));
                Plain(target);
                using (var source = entry.Open())
                using (var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                    var buffer = new byte[65536]; long count = 0; int read;
                    while ((read = source.Read(buffer, 0, buffer.Length)) != 0) {
                        count += read; if (count > item.size) throw new Failure("payload_invalid");
                        output.Write(buffer, 0, read);
                    }
                    if (count != item.size) throw new Failure("payload_invalid");
                }
                Check(root, item);
            }
            if (seen.Count != expected.Count) throw new Failure("payload_invalid");
        }
    }
    internal static RuntimeProfile Runtime(string installed, RuntimeCatalog catalog) {
        if (catalog.schema != 1 || catalog.profiles == null || catalog.profiles.Count == 0 || catalog.profiles.Count > 32) throw new Failure("trust_invalid");
        string executableHash;
        using (var stream = File.OpenRead(Child(installed, TrustedBuild.ExecutableName))) executableHash = Hash(stream);
        foreach (var profile in catalog.profiles) {
            if (profile.electron != "32.3.3" || profile.files == null || profile.files.Count == 0 || profile.files.Count > 256) continue;
            if (!profile.files.Any(f => f.path == TrustedBuild.ExecutableName && f.sha256 == executableHash)) continue;
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var file in profile.files) {
                var allowed = file.path == TrustedBuild.ExecutableName || file.path == "crashpad_handler.exe" ||
                    Regex.IsMatch(file.path, "^[^/]+\\.(dll|pak|bin|dat)$", RegexOptions.IgnoreCase) ||
                    Regex.IsMatch(file.path, "^locales/[^/]+\\.pak$", RegexOptions.IgnoreCase);
                if (!allowed || !names.Add(file.path)) throw new Failure("trust_invalid");
                Check(installed, file);
            }
            // A neighboring DLL must not be loaded outside the reviewed runtime.
            foreach (var file in Directory.GetFiles(installed, "*.dll"))
                if (!names.Contains(Path.GetFileName(file))) throw new Failure("runtime_unrecognized");
            return profile;
        }
        throw new Failure("runtime_unrecognized");
    }
}

internal static class SignedLauncher
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct FileInfo { public uint size; [MarshalAs(UnmanagedType.LPWStr)] public string file; public IntPtr handle; public IntPtr subject; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct TrustData {
        public uint size; public IntPtr callback; public IntPtr sip; public uint ui; public uint revocation;
        public uint choice; public IntPtr file; public uint stateAction; public IntPtr state;
        public IntPtr url; public uint flags; public uint context;
    }
    [DllImport("wintrust.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern int WinVerifyTrust(IntPtr hwnd, ref Guid action, ref TrustData data);
    internal static void Verify() {
        if (!VerifiedFiles.HashText(TrustedBuild.DescriptorSha256) || !VerifiedFiles.HashText(TrustedBuild.PayloadSha256) ||
            !VerifiedFiles.HashText(TrustedBuild.RuntimeCatalogSha256)) throw new Failure("build_incomplete");
        // Internal delivery retains the existing official-channel/embedded-root
        // trust model. When a publisher is pinned, Authenticode is mandatory.
        // An absent Windows certificate never disables payload/update signatures.
        if (TrustedBuild.PublisherThumbprint.Length == 0) return;
        if (!Regex.IsMatch(TrustedBuild.PublisherThumbprint, "^[A-Fa-f0-9]{40}$")) throw new Failure("launcher_signature_invalid");
        var executable = Process.GetCurrentProcess().MainModule.FileName;
        var file = new FileInfo { size = (uint)Marshal.SizeOf(typeof(FileInfo)), file = executable };
        var pointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileInfo)));
        Marshal.StructureToPtr(file, pointer, false);
        var data = new TrustData { size = (uint)Marshal.SizeOf(typeof(TrustData)), ui = 2, choice = 1, file = pointer, stateAction = 1 };
        var action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
        try {
            if (WinVerifyTrust(new IntPtr(-1), ref action, ref data) != 0) throw new Failure("launcher_signature_invalid");
            using (var certificate = new X509Certificate2(X509Certificate.CreateFromSignedFile(executable)))
                if (!String.Equals(certificate.Thumbprint, TrustedBuild.PublisherThumbprint, StringComparison.OrdinalIgnoreCase)) throw new Failure("launcher_signature_invalid");
        } finally {
            data.stateAction = 2; WinVerifyTrust(new IntPtr(-1), ref action, ref data);
            Marshal.DestroyStructure(pointer, typeof(FileInfo)); Marshal.FreeHGlobal(pointer);
        }
    }
}

internal sealed class LauncherWindow : Form
{
    private readonly Label title = new Label { AutoSize = true, Text = "更新 AI获客", Font = new Font("Microsoft YaHei UI", 18, FontStyle.Bold) };
    private readonly TextBox detail = new TextBox { ReadOnly = true, Multiline = true, BorderStyle = BorderStyle.None, BackColor = Color.WhiteSmoke, Width = 465, Height = 66, Text = "自动识别当前安装，保留你的资料与制作记录。" };
    private readonly ProgressBar progress = new ProgressBar { Width = 465, Height = 14 };
    private readonly Button start = new Button { Text = "立即更新", Width = 130, Height = 42 };
    private readonly Button cancel = new Button { Text = "取消", Width = 100, Height = 42, Enabled = false };
    private Process coordinator; private bool running, handingOff; private volatile bool cancelled;
    private volatile string coordinatorFailure;
    private string session = Guid.NewGuid().ToString("D");
    internal LauncherWindow() {
        Text = "AI获客 · 官方更新助手"; ClientSize = new Size(530, 280); FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false; StartPosition = FormStartPosition.CenterScreen; AutoScaleMode = AutoScaleMode.Dpi;
        Font = new Font("Microsoft YaHei UI", 11); BackColor = Color.WhiteSmoke;
        title.Location = new Point(30, 25); detail.Location = new Point(30, 77); progress.Location = new Point(30, 153);
        start.Location = new Point(30, 200); cancel.Location = new Point(180, 200);
        Controls.AddRange(new Control[] { title, detail, progress, start, cancel });
        start.Click += async delegate { await StartUpdate(); };
        cancel.Click += delegate { Cancel(); };
        FormClosing += delegate(object sender, FormClosingEventArgs args) {
            if (running) { args.Cancel = true; if (!handingOff) Cancel(); }
        };
    }
    private void Post(Action action) { if (!IsDisposed) BeginInvoke(action); }
    private void Cancel() {
        if (handingOff || cancelled) return; cancelled = true; cancel.Enabled = false; detail.Text = "正在取消，请稍候。";
        try { if (coordinator != null && !coordinator.HasExited) coordinator.StandardInput.WriteLine("{\"command\":\"cancel\"}"); } catch { }
        // Never terminate an installer, coordinator, or business process.
    }
    private void Update(Message message) {
        if (message == null) return;
        if (message.phase == "error") {
            title.Text = "更新已安全停止";
            detail.Text = "原软件和资料已保留。故障编号：" + session.Substring(0, 8) + " / " + SafeCode(message.code);
            return;
        }
        var labels = new Dictionary<string, string> {
            {"detecting", "正在核对当前安装"}, {"downloading", "正在下载更新"},
            {"waiting", "等待软件关闭"}, {"preparing", "正在准备安全更新"},
            {"committing", "正在移交更新"}, {"handoff", "更新窗口已接管"},
            {"cancelled", "已取消更新"}, {"current", "当前已经是最新版本"}, {"review_stop", "检查完成，尚未安装"}
        };
        string label; if (!labels.TryGetValue(message.phase ?? "", out label)) return;
        title.Text = label; progress.Value = Math.Max(0, Math.Min(100, message.percent));
        if (message.phase == "waiting") detail.Text = "请完成当前操作后正常退出软件，退出后会继续更新。";
        if (message.phase == "committing" || message.phase == "handoff") { handingOff = true; cancel.Enabled = false; }
        if (message.phase == "handoff") detail.Text = "请查看软件更新窗口，成功启动新版本后才算更新完成。";
    }
    private async Task StartUpdate() {
        if (running) return; running = true; cancelled = false; handingOff = false; coordinatorFailure = null; session = Guid.NewGuid().ToString("D"); start.Enabled = false; cancel.Enabled = true;
        try { await Task.Run((Action)Launch); }
        catch (Exception error) {
            var code = error is Failure ? error.Message : "preparation_failed";
            title.Text = code == "build_incomplete" ? "更新助手文件不完整" : "暂时无法开始更新";
            detail.Text = "原软件和资料已保留。故障编号：" + session.Substring(0, 8) + " / " + code;
        } finally { running = false; coordinator = null; cancel.Enabled = false; start.Enabled = !handingOff; start.Text = "重试"; }
    }
    private void Launch() {
        SignedLauncher.Verify();
        if (cancelled) return;
        var descriptorBytes = VerifiedFiles.Resource("payload-manifest.json", 4 * 1024 * 1024);
        var payload = VerifiedFiles.Resource("payload.zip", 16 * 1024 * 1024);
        var runtimeBytes = VerifiedFiles.Resource("runtime-catalog.json", 4 * 1024 * 1024);
        VerifiedFiles.Match(descriptorBytes, TrustedBuild.DescriptorSha256);
        VerifiedFiles.Match(payload, TrustedBuild.PayloadSha256);
        VerifiedFiles.Match(runtimeBytes, TrustedBuild.RuntimeCatalogSha256);
        var descriptor = VerifiedFiles.Json.Deserialize<Descriptor>(Encoding.UTF8.GetString(descriptorBytes));
        var catalog = VerifiedFiles.Json.Deserialize<RuntimeCatalog>(Encoding.UTF8.GetString(runtimeBytes));
        if (descriptor.schema != 1 || descriptor.channel != "test" || descriptor.appId != TrustedBuild.ApplicationId || descriptor.entry != "coordinator.cjs" ||
            (descriptor.mode != "inspect" && descriptor.mode != "update")) throw new Failure("trust_invalid");
        var installed = VerifiedFiles.Plain(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\AI获客-测试版"));
        var profile = VerifiedFiles.Runtime(installed, catalog);
        if (cancelled) return;
        var root = VerifiedFiles.CreateSession(session);
        VerifiedFiles.Extract(payload, descriptor, root);
        File.WriteAllBytes(VerifiedFiles.Child(root, "verified-descriptor.json"), descriptorBytes);
        File.WriteAllBytes(VerifiedFiles.Child(root, "verified-runtime-catalog.json"), runtimeBytes);
        var context = new { schema = 1, session, runtimeId = profile.id, descriptorSha256 = TrustedBuild.DescriptorSha256,
            runtimeCatalogSha256 = TrustedBuild.RuntimeCatalogSha256, launcherPid = Process.GetCurrentProcess().Id };
        var contextFile = VerifiedFiles.Child(root, "launch-context.json");
        File.WriteAllText(contextFile, VerifiedFiles.Json.Serialize(context), new UTF8Encoding(false));
        if (cancelled) return;
        // Rehash immediately before executing the original runtime, after extraction.
        VerifiedFiles.Runtime(installed, catalog);
        var info = new ProcessStartInfo(VerifiedFiles.Child(installed, TrustedBuild.ExecutableName),
            Quote(VerifiedFiles.Child(root, descriptor.entry)) + " " + Quote(contextFile)) {
            UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = root,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        var keep = new[] { "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "COMSPEC" };
        info.EnvironmentVariables.Clear();
        foreach (var key in keep) { var value = Environment.GetEnvironmentVariable(key); if (value != null) info.EnvironmentVariables[key] = value; }
        var system = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32");
        info.EnvironmentVariables["PATH"] = system + ";" + Path.Combine(system, @"WindowsPowerShell\v1.0");
        info.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
        using (var child = new Process { StartInfo = info }) {
            coordinator = child;
            child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) {
                if (e.Data == null || e.Data.Length > 2048) return;
                try { var message = VerifiedFiles.Json.Deserialize<Message>(e.Data); if (message.phase == "error") coordinatorFailure = SafeCode(message.code); Post(delegate { Update(message); }); } catch { }
            };
            child.ErrorDataReceived += delegate { }; // Do not display raw paths, environment or stack traces.
            if (!child.Start()) throw new Failure("coordinator_start_failed");
            child.BeginOutputReadLine(); child.BeginErrorReadLine();
            if (cancelled) child.StandardInput.WriteLine("{\"command\":\"cancel\"}");
            child.WaitForExit();
            if (child.ExitCode != 0 && !cancelled) throw new Failure(coordinatorFailure ?? "coordinator_failed");
        }
    }
    private static string SafeCode(string value) {
        return value != null && Regex.IsMatch(value, "^[A-Za-z][A-Za-z0-9_]{0,95}$") ? value : "update_failed";
    }
    internal static string Quote(string value) {
        // Windows CreateProcess argument quoting, including trailing backslashes.
        if (value.IndexOf('\0') >= 0) throw new Failure("path_invalid");
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (var item in value) {
            if (item == '\\') { slashes++; continue; }
            result.Append('\\', item == '"' ? slashes * 2 + 1 : slashes);
            result.Append(item); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    [STAThread] private static void Main() {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new LauncherWindow());
    }
}
