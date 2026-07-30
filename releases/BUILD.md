# ChordBridge 编译指南（macOS / Windows / Linux）

> 本文件说明如何自行编译 ChordBridge 的桌面安装包。
> 项目基于 **Tauri v2**（Rust 后端 + 原生 HTML/CSS/JS 前端）。

---

## 0. 重要前提：为什么不能在 macOS 上一键出 Windows / Linux 包

Tauri 应用依赖**各操作系统的系统 WebView 库**来渲染界面：

| 平台 | 依赖的系统库 |
|------|--------------|
| macOS | 系统自带 WebKit（无需额外安装） |
| Windows | WebView2（来自 Windows SDK / Edge Runtime） |
| Linux | `webkit2gtk-4.1` + GTK 开发库 |

这些库**只有在本平台上才有**。所以在 macOS 上无法链接出 Windows 的 WebView2 或 Linux 的 webkit2gtk——交叉编译会卡在系统库这一步。

**结论**：
- ✅ macOS 包 → 在你这台 Mac 上直接编译（已为你准备好，见 `releases/macos/`）
- ✅ Windows / Linux 包 → 两种可靠方式：
  1. **用 GitHub Actions CI**（推荐，无需三台电脑，push 代码即自动出三平台包）
  2. 在对应的 Windows / Linux 机器上本机编译（步骤见下）

---

## 1. 通用环境（三个平台都要）

| 工具 | 版本 | 安装 |
|------|------|------|
| Node.js | ≥ 18（推荐 22） | https://nodejs.org |
| Rust | stable | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Tauri CLI | v2 | 装好 Node 后：`npm install`（项目已包含 `@tauri-apps/cli`） |

装完后进项目目录先执行一次：
```bash
npm install
```

---

## 2. macOS（你本机，最省事）

前置：Xcode 命令行工具
```bash
xcode-select --install
```

编译并打包（出 `.app` + 手动生成 `.dmg`，绕开 Tauri 内置 dmg 脚本的污染 bug）：
```bash
npm run build
```

产物位置：
- `src-tauri/target/release/bundle/macos/ChordBridge.app`
- `src-tauri/target/release/bundle/dmg/ChordBridge_0.1.0_aarch64.dmg`

本项目已把编译好的包归拢到 `releases/macos/`：
- `ChordBridge_0.1.0_aarch64.dmg`（Apple 芯片 Mac）
- `ChordBridge_0.1.0_x64.app.zip` / `ChordBridge_0.1.0_x64.dmg`（Intel Mac）

> 只出 Apple 芯片版：`npm run tauri build`
> 想出 Intel 版：在编译前 `rustup target add x86_64-apple-darwin`，见下方「macOS 双架构」。

### macOS 双架构（Apple + Intel 通吃）
```bash
source "$HOME/.cargo/env"
rustup target add x86_64-apple-darwin
# 分别编译两个架构，再用脚本各自出 dmg / 压缩 app
cd src-tauri && cargo build --release --target aarch64-apple-darwin && cargo build --release --target x86_64-apple-darwin
```
然后用 `scripts/package-macos.sh` 的逻辑对各自 target 目录手动 `hdiutil create`。

---

## 3. Windows（需在 Windows 机器上，或用 CI）

### 本机编译前置
1. **Visual Studio 2022 Build Tools**（或 Visual Studio Community）
   - 工作负载勾选：「使用 C++ 的桌面开发」
   - 含 MSVC v143 + Windows 10/11 SDK
2. **WebView2 Runtime**：Windows 11 自带；Windows 10 去微软官网装「WebView2 Evergreen Standalone Installer」
3. （可选）LLVM/Clang —— 用 MSVC 工具链时**不需要**

### 编译
```bash
npm install
npm run tauri build -- --bundles nsis msi
```
产物：`src-tauri/target/release/bundle/nsis/*.exe`（安装包）、`src-tauri/target/release/bundle/msi/*.msi`

---

## 4. Linux（需在 Linux 机器上，或用 CI）

### 本机编译前置（Ubuntu / Debian 示例）
```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential \
  curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf
```
（Fedora / Arch 对应包名不同，见 Tauri 官方文档「Linux 依赖」）

### 编译
```bash
npm install
npm run tauri build -- --bundles deb appimage
```
产物：`src-tauri/target/release/bundle/deb/*.deb`、`src-tauri/target/release/bundle/appimage/*.AppImage`

---

## 5. 推荐：GitHub Actions 一键出三平台（无需三台电脑）

项目已内置 `.github/workflows/build.yml`。用法：

1. 把代码推到 GitHub 仓库（已含 `.github/workflows/build.yml`）
2. 在仓库 **Actions** 标签页点 **build** 工作流 → **Run workflow**（或 push 到 main 自动触发）
3. 跑完后在 **Artifacts** 里下载：
   - `ChordBridge-ubuntu-22.04` → `.deb` + `.AppImage`
   - `ChordBridge-windows-latest` → `.exe`(nsis) + `.msi`
   - `ChordBridge-macos-latest` → `.app` + `.dmg`

> CI 在 macOS runner 上用 `npm run build`（含手动 dmg 脚本），Windows/Linux runner 上用内置 bundle，规避了 dmg 脚本 bug。

---

## 6. 产物位置速查

| 平台 | 本机编译产物 | CI 产物名 |
|------|--------------|-----------|
| macOS | `bundle/macos/*.app`、`bundle/dmg/*.dmg` | `ChordBridge-macos-latest` |
| Windows | `bundle/nsis/*.exe`、`bundle/msi/*.msi` | `ChordBridge-windows-latest` |
| Linux | `bundle/deb/*.deb`、`bundle/appimage/*.AppImage` | `ChordBridge-ubuntu-22.04` |

---

## 7. 签名与分发提示

- 当前包是 **ad-hoc 签名**（无 Apple / 微软 / 代码签名证书）：
  - macOS：本机可双击打开；发给别人需右键「打开」或 `xattr -cr ChordBridge.app`
  - Windows：SmartScreen 会警告「未知发布者」，点「仍要运行」即可
  - Linux：`.AppImage` 需 `chmod +x`，`.deb` 直接装
- 正式分发建议配证书：
  - macOS：Apple Developer ID + `notarytool` 公证（在 `tauri.conf.json` 的 `bundle.macOS.signingIdentity` 填证书）
  - Windows：代码签名证书对 `.exe`/`.msi` 签名
  - Linux：一般不需要，或做 GPG 签名
