import SwiftUI
import AppKit
import Foundation
import Security

struct AppSettings: Codable {
    var port = 3426
    var apiKey = ""
    var sessionReuse = true
}

struct QuickAccount: Decodable, Identifiable {
    let id: String
    let label: String
    let provider: String
}

enum AppPage: String, CaseIterable, Identifiable {
    case overview = "服务概览"
    case accounts = "账号管理"
    case settings = "代理设置"
    case logs = "运行日志"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .overview: return "square.grid.2x2"
        case .accounts: return "person.2"
        case .settings: return "slider.horizontal.3"
        case .logs: return "terminal"
        }
    }
    var detail: String {
        switch self {
        case .overview: return "本地 API 服务状态与调用地址"
        case .accounts: return "通过浏览器登录 Amazon Quick"
        case .settings: return "监听端口、访问密钥和会话管理"
        case .logs: return "服务进程的最近输出"
        }
    }
}

@MainActor
final class QuickManager: ObservableObject {
    @Published var settings = AppSettings()
    @Published var accounts: [QuickAccount] = []
    @Published var running = false
    @Published var loggingIn = false
    @Published var message = ""
    @Published var error = ""
    @Published var logs = ""

    private var server: Process?
    private var loginProcess: Process?
    private var managerProcesses: [Process] = []
    private var serverPipe: Pipe?

    let dataDir: URL = {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return root.appendingPathComponent("MagpieQuick", isDirectory: true)
    }()
    private var configURL: URL { dataDir.appendingPathComponent("config.json") }
    private var nodePath: URL {
        Bundle.main.resourceURL!.appendingPathComponent("runtime/node")
    }
    private var scriptDir: URL {
        Bundle.main.resourceURL!.appendingPathComponent("app", isDirectory: true)
    }
    var baseURL: String { "http://127.0.0.1:\(settings.port)/v1" }
    var rootURL: String { "http://127.0.0.1:\(settings.port)" }

    init() {
        try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: configURL),
           let current = try? JSONDecoder().decode(AppSettings.self, from: data) {
            settings = current
        }
        if settings.apiKey.isEmpty {
            settings.apiKey = Self.generateKey()
            saveSettings(settings, restart: false)
        }
        refreshAccounts()
    }

    static func generateKey() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if status != errSecSuccess {
            return "sk-mq-" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
                + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        }
        return "sk-mq-" + bytes.map { String(format: "%02x", $0) }.joined()
    }

    func saveSettings(_ next: AppSettings, restart: Bool) {
        guard (1...65535).contains(next.port) else {
            error = "监听端口必须在 1–65535 范围内"
            return
        }
        guard !next.apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              next.apiKey == next.apiKey.trimmingCharacters(in: .whitespacesAndNewlines) else {
            error = "API Key 不能为空，也不能包含首尾空白字符"
            return
        }
        do {
            let data = try JSONEncoder().encode(next)
            try FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
            try data.write(to: configURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configURL.path)
            settings = next
            error = ""
            message = restart && running ? "已保存配置，正在重启服务" : "配置已保存"
            if restart && running { stopServer(); startServer() }
        } catch {
            self.error = "无法保存配置：\(error.localizedDescription)"
        }
    }

    private func launch(_ script: String, arguments: [String]) -> Process {
        let process = Process()
        process.executableURL = nodePath
        process.arguments = [scriptDir.appendingPathComponent(script).path] + arguments
        process.currentDirectoryURL = scriptDir
        var env = ProcessInfo.processInfo.environment
        env["MAGPIE_QUICK_DATA_DIR"] = dataDir.path
        env["HOST"] = "127.0.0.1"
        env["PORT"] = String(settings.port)
        env["PROXY_TOKEN"] = settings.apiKey
        env["QUICK_SESSION_REUSE"] = settings.sessionReuse ? "1" : "0"
        process.environment = env
        return process
    }

    private func appendLog(_ content: String) {
        let cleaned = content.replacingOccurrences(of: settings.apiKey, with: "[API KEY]")
        logs += cleaned
        if logs.count > 50000 { logs = String(logs.suffix(40000)) }
    }

    func startServer() {
        guard !running else { return }
        guard FileManager.default.isExecutableFile(atPath: nodePath.path) else {
            error = "内置 Node.js 运行时丢失，请重新安装应用"
            return
        }
        let process = launch("bin/serve.mjs", arguments: [])
        let output = Pipe()
        serverPipe = output
        process.standardOutput = output
        process.standardError = output
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            let str = String(decoding: data, as: UTF8.self)
            DispatchQueue.main.async { self?.appendLog(str) }
        }
        process.terminationHandler = { [weak self] done in
            DispatchQueue.main.async {
                self?.running = false
                self?.server = nil
                self?.serverPipe?.fileHandleForReading.readabilityHandler = nil
                self?.appendLog("\n服务进程退出（代码 \(done.terminationStatus)）\n")
                if done.terminationStatus != 0 {
                    self?.error = "服务已退出，详见运行日志。请确认端口未被其他程序占用。"
                }
            }
        }
        do {
            try process.run()
            server = process
            running = true
            message = "代理正在启动"
            error = ""
        } catch {
            self.error = "无法启动代理：\(error.localizedDescription)"
        }
    }

    func stopServer() {
        guard let server, server.isRunning else { running = false; return }
        server.terminate()
        running = false
        message = "代理已停止"
    }

    private func executeManager(_ arguments: [String], onEvent: @escaping ([String: Any]) -> Void,
                                onExit: (() -> Void)? = nil) {
        let process = launch("bin/manage.mjs", arguments: arguments)
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        managerProcesses.append(process)
        var pending = Data()
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            DispatchQueue.main.async {
                pending.append(chunk)
                let newline = Data([0x0a])
                while let range = pending.range(of: newline) {
                    let line = pending.subdata(in: pending.startIndex..<range.lowerBound)
                    pending.removeSubrange(pending.startIndex..<range.upperBound)
                    guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                    onEvent(obj)
                }
                _ = self
            }
        }
        process.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async {
                self?.managerProcesses.removeAll { $0 === finished }
                onExit?()
            }
        }
        do { try process.run() }
        catch {
            self.error = "无法运行账号管理程序：\(error.localizedDescription)"
            managerProcesses.removeAll { $0 === process }
            onExit?()
        }
    }

    func refreshAccounts() {
        executeManager(["list"], onEvent: { [weak self] event in
            guard event["type"] as? String == "accounts",
                  let entries = event["accounts"],
                  let raw = try? JSONSerialization.data(withJSONObject: entries),
                  let decoded = try? JSONDecoder().decode([QuickAccount].self, from: raw)
            else { return }
            self?.accounts = decoded
        })
    }

    func login() {
        guard !loggingIn else { return }
        loggingIn = true
        message = "正在打开浏览器登录"
        executeManager(["login"], onEvent: { [weak self] event in
            switch event["type"] as? String {
            case "login_url":
                if let url = event["url"] as? String,
                   let parsed = URL(string: url), parsed.scheme == "https" {
                    NSWorkspace.shared.open(parsed)
                    self?.message = "请在浏览器中完成 Amazon Quick 登录"
                }
            case "login_ok":
                self?.error = ""
                self?.message = "账号登录成功"
                self?.refreshAccounts()
            case "error":
                self?.error = event["message"] as? String ?? "账号登录失败"
            default: break
            }
        }, onExit: { [weak self] in self?.loggingIn = false })
    }

    func removeAccount(_ id: String) {
        executeManager(["remove", id], onEvent: { [weak self] event in
            if event["type"] as? String == "removed" {
                self?.message = "账号已移除"
                self?.refreshAccounts()
            } else if event["type"] as? String == "error" {
                self?.error = event["message"] as? String ?? "移除失败"
            }
        })
    }

    func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        message = "已复制到剪贴板"
    }

    func revealDataDirectory() { NSWorkspace.shared.open(dataDir) }

    func shutdown() {
        stopServer()
        if let loginProcess, loginProcess.isRunning { loginProcess.terminate() }
        for process in managerProcesses where process.isRunning { process.terminate() }
    }
}

private enum Palette {
    static let bg = Color(red: 0.963, green: 0.973, blue: 0.981)
    static let ink = Color(red: 0.115, green: 0.160, blue: 0.216)
    static let secondary = Color(red: 0.415, green: 0.475, blue: 0.540)
    static let accent = Color(red: 0.071, green: 0.395, blue: 0.610)
    static let line = Color(red: 0.855, green: 0.887, blue: 0.915)
    static let sidebar = Color(red: 0.095, green: 0.149, blue: 0.202)
    static let good = Color(red: 0.105, green: 0.530, blue: 0.355)
}

private struct Panel<Content: View>: View {
    let content: Content
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(22)
            .background(.white, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.line, lineWidth: 1))
    }
}
private struct PanelHeading: View {
    let heading: String
    let subheading: String
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(heading).font(.system(size: 16, weight: .semibold)).foregroundStyle(Palette.ink)
            Text(subheading).font(.system(size: 12)).foregroundStyle(Palette.secondary)
        }
    }
}
private struct ValueCard: View {
    let title: String, value: String, icon: String
    var body: some View {
        Panel {
            VStack(alignment: .leading, spacing: 12) {
                Label(title, systemImage: icon)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Palette.secondary)
                Text(value)
                    .font(.system(size: 22, weight: .semibold, design: .rounded))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity, minHeight: 64, alignment: .leading)
        }
    }
}
private struct Overview: View {
    @ObservedObject var manager: QuickManager
    var body: some View {
        VStack(spacing: 15) {
            Panel {
                HStack(spacing: 15) {
                    Image(systemName: "network")
                        .font(.system(size: 27))
                        .foregroundStyle(Palette.accent)
                        .frame(width: 55, height: 55)
                        .background(Palette.bg, in: RoundedRectangle(cornerRadius: 12))
                    VStack(alignment: .leading, spacing: 6) {
                        Text(manager.running ? "代理服务运行中" : "代理服务已停止")
                            .font(.system(size: 20, weight: .semibold)).foregroundStyle(Palette.ink)
                        Text("Amazon Quick · OpenAI / Anthropic API")
                            .font(.system(size: 12)).foregroundStyle(Palette.secondary)
                    }
                    Spacer(minLength: 20)
                    Button(manager.running ? "停止代理" : "启动代理") {
                        manager.running ? manager.stopServer() : manager.startServer()
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .tint(Palette.accent)
                }
            }
            HStack(spacing: 14) {
                ValueCard(title: "监听端口", value: String(manager.settings.port), icon: "network")
                ValueCard(title: "登录账号", value: "\(manager.accounts.count)", icon: "person.2")
                ValueCard(title: "服务状态", value: manager.running ? "运行中" : "已停止", icon: "circle.dotted")
            }
            Panel {
                VStack(alignment: .leading, spacing: 16) {
                    PanelHeading(heading: "本地 API 接入", subheading: "仅监听 127.0.0.1，不对局域网开放")
                    Divider()
                    Text("BASE URL").font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.secondary)
                    HStack(spacing: 12) {
                        Text(manager.baseURL).font(.system(size: 14, design: .monospaced))
                            .foregroundStyle(Palette.ink).textSelection(.enabled)
                        Spacer()
                        Button { manager.copy(manager.baseURL) } label: {
                            Label("复制地址", systemImage: "doc.on.doc")
                        }
                    }
                    .padding(12)
                    .background(Palette.bg, in: RoundedRectangle(cornerRadius: 9))
                    Text("OpenAI：/v1/chat/completions    Anthropic：/v1/messages")
                        .font(.system(size: 12, design: .monospaced)).foregroundStyle(Palette.secondary)
                    Text("模型档位：fast · balanced · smart · advanced")
                        .font(.system(size: 12)).foregroundStyle(Palette.secondary)
                }
            }
            Panel {
                VStack(alignment: .leading, spacing: 9) {
                    PanelHeading(heading: "本地工具调用", subheading: "Claude Code 通过客户端提供的工具访问本机")
                    Text("代理会把客户端的工具声明传给 Quick 模型，并将生成的调用交回 Claude Code。请在 Claude Code 内测试文件读取和终端执行。")
                        .font(.system(size: 12)).foregroundStyle(Palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}
private struct AccountsPage: View {
    @ObservedObject var manager: QuickManager
    @State private var removeID: String?
    var body: some View {
        Panel {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    PanelHeading(heading: "Amazon Quick 账号", subheading: "浏览器 OAuth 登录；令牌保存在本机用户目录")
                    Spacer(minLength: 15)
                    Button { manager.refreshAccounts() } label: {
                        Label("刷新", systemImage: "arrow.clockwise")
                    }
                    Button { manager.login() } label: {
                        Label(manager.loggingIn ? "等待登录" : "添加账号", systemImage: "plus")
                    }
                    .disabled(manager.loggingIn)
                    .buttonStyle(.borderedProminent)
                    .tint(Palette.accent)
                }
                Divider()
                if manager.accounts.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "person.crop.circle.badge.plus")
                            .font(.system(size: 30)).foregroundStyle(Palette.accent)
                        Text("尚未登录账号").font(.system(size: 14, weight: .medium))
                        Text("点击“添加账号”，在浏览器完成 Amazon Quick 授权。")
                            .font(.system(size: 12)).foregroundStyle(Palette.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 38)
                } else {
                    ForEach(manager.accounts) { account in
                        HStack(spacing: 14) {
                            Image(systemName: "person.crop.circle.fill")
                                .font(.system(size: 23)).foregroundStyle(Palette.accent)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(account.label).font(.system(size: 13, weight: .semibold))
                                Text(account.provider).font(.system(size: 11)).foregroundStyle(Palette.secondary)
                            }
                            Spacer()
                            Button("移除") { removeID = account.id }
                        }.padding(.vertical, 10)
                        Divider()
                    }
                }
            }
        }
        .confirmationDialog("确定移除该账号？", isPresented: Binding(
            get: { removeID != nil },
            set: { if !$0 { removeID = nil } }
        )) {
            Button("移除账号", role: .destructive) {
                if let id = removeID { manager.removeAccount(id) }
                removeID = nil
            }
        } message: { Text("删除本地 OAuth 登录记录。") }
    }
}

private struct SettingsPage: View {
    @ObservedObject var manager: QuickManager
    @State private var port = ""
    @State private var key = ""
    @State private var reuse = true
    @State private var revealKey = false

    var body: some View {
        VStack(spacing: 15) {
            Panel {
                VStack(alignment: .leading, spacing: 18) {
                    PanelHeading(heading: "监听设置", subheading: "本机 HTTP 服务的监听端口")
                    Divider()
                    HStack {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("监听主机").font(.system(size: 12, weight: .medium))
                            Text("127.0.0.1").foregroundStyle(Palette.secondary)
                                .frame(width: 170, height: 26, alignment: .leading)
                        }
                        VStack(alignment: .leading, spacing: 8) {
                            Text("端口").font(.system(size: 12, weight: .medium))
                            TextField("3426", text: $port)
                                .textFieldStyle(.roundedBorder).frame(width: 145)
                        }
                        Spacer()
                    }
                }
            }
            Panel {
                VStack(alignment: .leading, spacing: 18) {
                    PanelHeading(heading: "API Key", subheading: "客户端使用 Bearer 或 x-api-key 进行本地鉴权")
                    Divider()
                    HStack(spacing: 12) {
                        Group {
                            if revealKey {
                                TextField("API Key", text: $key)
                            } else {
                                SecureField("API Key", text: $key)
                            }
                        }.textFieldStyle(.roundedBorder)
                        Button(revealKey ? "隐藏" : "显示") { revealKey.toggle() }
                        Button("生成") { key = QuickManager.generateKey() }
                        Button("复制") { manager.copy(key) }.disabled(key.isEmpty)
                    }
                    Toggle("复用上游会话", isOn: $reuse).toggleStyle(.switch)
                }
            }
            Panel {
                HStack(spacing: 13) {
                    Text(manager.running ? "保存后可重新启动代理，使新设置生效。" : "设置在下次启动代理时生效。")
                        .font(.system(size: 12)).foregroundStyle(Palette.secondary)
                    Spacer()
                    Button("保存配置") { save(restart: false) }
                    if manager.running {
                        Button("保存并重启") { save(restart: true) }
                            .buttonStyle(.borderedProminent).tint(Palette.accent)
                    }
                }
            }
            Panel {
                HStack {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("数据目录").font(.system(size: 13, weight: .semibold))
                        Text(manager.dataDir.path).font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Palette.secondary).textSelection(.enabled)
                    }
                    Spacer()
                    Button("打开目录") { manager.revealDataDirectory() }
                }
            }
        }.onAppear {
            port = String(manager.settings.port)
            key = manager.settings.apiKey
            reuse = manager.settings.sessionReuse
        }
    }
    private func save(restart: Bool) {
        guard let value = Int(port) else { manager.error = "请输入有效端口"; return }
        manager.saveSettings(AppSettings(port: value, apiKey: key, sessionReuse: reuse), restart: restart)
    }
}

private struct LogsPage: View {
    @ObservedObject var manager: QuickManager
    var body: some View {
        Panel {
            VStack(alignment: .leading, spacing: 15) {
                HStack {
                    PanelHeading(heading: "运行日志", subheading: "代理的标准输出与错误信息")
                    Spacer()
                    Button { manager.copy(manager.logs) } label: {
                        Label("复制日志", systemImage: "doc.on.doc")
                    }.disabled(manager.logs.isEmpty)
                }
                Divider()
                ScrollView {
                    Text(manager.logs.isEmpty ? "启动代理后，日志显示在这里。" : manager.logs)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Palette.ink)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                }
                .frame(minHeight: 400)
                .background(Palette.bg, in: RoundedRectangle(cornerRadius: 10))
            }
        }
    }
}

struct MainWindow: View {
    @ObservedObject var manager: QuickManager
    @State private var selection: AppPage = .overview
    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 10) {
                    Image(systemName: "network")
                        .font(.system(size: 21)).frame(width: 37, height: 37)
                        .background(Palette.accent, in: RoundedRectangle(cornerRadius: 10))
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Magpie Quick").font(.system(size: 15, weight: .bold))
                        Text("代理管理").font(.system(size: 11)).opacity(0.68)
                    }
                }.padding(.bottom, 30).padding(.top, 5)
                ForEach(AppPage.allCases) { page in
                    Button { selection = page } label: {
                        HStack(spacing: 11) {
                            Image(systemName: page.icon).frame(width: 19)
                            Text(page.rawValue)
                            Spacer(minLength: 0)
                        }
                        .font(.system(size: 13, weight: selection == page ? .semibold : .medium))
                        .foregroundStyle(selection == page ? Color.white : Color.white.opacity(0.72))
                        .padding(.horizontal, 12).padding(.vertical, 11)
                        .background(selection == page ? Color.white.opacity(0.15) : Color.clear,
                                    in: RoundedRectangle(cornerRadius: 9))
                    }.buttonStyle(.plain)
                }
                Spacer()
                Label(manager.running ? "服务运行中" : "服务已停止",
                      systemImage: manager.running ? "circle.fill" : "circle")
                    .font(.system(size: 11)).opacity(0.78).padding(10)
            }
            .foregroundStyle(.white)
            .padding(18)
            .frame(width: 212)
            .background(Palette.sidebar)
            VStack(spacing: 0) {
                HStack {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(selection.rawValue).font(.system(size: 22, weight: .bold))
                            .foregroundStyle(Palette.ink)
                        Text(selection.detail).font(.system(size: 12))
                            .foregroundStyle(Palette.secondary)
                    }
                    Spacer()
                }
                .padding(.horizontal, 26).padding(.vertical, 21)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.white)
                Rectangle().fill(Palette.line).frame(height: 1)
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if !manager.error.isEmpty {
                            Label(manager.error, systemImage: "exclamationmark.triangle")
                                .foregroundStyle(Color.red).font(.system(size: 12))
                                .padding(13).frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color.red.opacity(0.07), in: RoundedRectangle(cornerRadius: 9))
                        }
                        if !manager.message.isEmpty {
                            Label(manager.message, systemImage: "info.circle")
                                .foregroundStyle(Palette.accent).font(.system(size: 12))
                                .padding(13).frame(maxWidth: .infinity, alignment: .leading)
                                .background(Palette.accent.opacity(0.06), in: RoundedRectangle(cornerRadius: 9))
                        }
                        Group {
                            switch selection {
                            case .overview: Overview(manager: manager)
                            case .accounts: AccountsPage(manager: manager)
                            case .settings: SettingsPage(manager: manager)
                            case .logs: LogsPage(manager: manager)
                            }
                        }
                    }
                    .frame(maxWidth: 950, alignment: .leading)
                    .padding(25)
                    .frame(maxWidth: .infinity, alignment: .top)
                }
                .background(Palette.bg)
            }
        }
        .frame(minWidth: 920, minHeight: 650)
    }
}

@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var manager: QuickManager?
    func applicationWillTerminate(_ notification: Notification) { manager?.shutdown() }
}

@main
struct MagpieQuickApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var manager = QuickManager()
    var body: some Scene {
        WindowGroup("Magpie Quick", id: "main") {
            MainWindow(manager: manager)
                .preferredColorScheme(.light)
                .onAppear { delegate.manager = manager }
        }
        .defaultSize(width: 1080, height: 730)
        MenuBarExtra("Magpie Quick", systemImage: "network") {
            Text(manager.running ? "代理服务运行中" : "代理服务已停止")
            Text(manager.baseURL)
            Divider()
            Button(manager.running ? "停止代理" : "启动代理") {
                manager.running ? manager.stopServer() : manager.startServer()
            }
            Button("退出") { NSApplication.shared.terminate(nil) }
        }
    }
}
