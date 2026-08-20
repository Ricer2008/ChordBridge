#!/usr/bin/env bash
# macOS 打包脚本：在 `tauri build`（仅产出 .app）之后，用系统 hdiutil
# 生成可分发的 .dmg。
#
# 为什么不用 Tauri 内置的 dmg bundler？
#   Tauri 2.x 的 create-dmg 脚本会把临时镜像写进打包源目录（bundle/macos），
#   导致下次打包时该残留被当作源文件塞进镜像、容量估算不足而 ENOSPC，陷入死循环。
#   系统自带的 hdiutil 只读源目录、不会污染，稳定可靠。
#
# 用法：package-macos.sh [架构标签] [target子目录]
#   package-macos.sh aarch64 release                    # 本机 arm 构建
#   package-macos.sh x64 x86_64-apple-darwin/release     # x86_64 交叉构建
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ARCH_LABEL="${1:-aarch64}"
TARGET_SUBDIR="${2:-release}"

# 读取版本号（来自 package.json）
VER="$(node -p "require('./package.json').version")"
PRODUCT="ChordBridge"
MACOS_DIR="src-tauri/target/${TARGET_SUBDIR}/bundle/macos"
APP="$MACOS_DIR/$PRODUCT.app"
DMG_DIR="src-tauri/target/${TARGET_SUBDIR}/bundle/dmg"
DMG="$DMG_DIR/${PRODUCT}_${VER}-beta_${ARCH_LABEL}.dmg"

if [ ! -d "$APP" ]; then
  echo "未找到 $APP，请先运行 'npm run tauri build'" >&2
  exit 1
fi

# 清理上一次可能残留的临时 dmg（避免污染打包源目录）
find "$MACOS_DIR" -name 'rw.*.dmg' -delete 2>/dev/null || true
rm -rf "$DMG_DIR"
mkdir -p "$DMG_DIR"

echo "==> 生成 $DMG"
hdiutil create -volname "$PRODUCT" -srcfolder "$MACOS_DIR" -ov -format UDZO "$DMG"

echo "==> 完成："
ls -la "$DMG"
