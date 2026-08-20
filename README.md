# ChordBridge

🎸 一座连接简谱、五线谱、六线谱的桥

## 为什么做这个？

我在自学吉他的时候，发现网上很多歌曲只有简谱，有和弦的没指法，有指法的要付费。我只是想弹个歌，为什么要被这些格式和门槛拦住？

所以我在workbuddy的帮助下用 Rust 写了这个工具。它只有 10MB，打开就能用。

## 功能

- 📊 简谱 → 五线谱 → 六线谱 一键转换（含六线和弦谱）
- 🎹 MIDI 演奏与多音轨支持
- 🎼 乐理完整：15 大调 + 14 小调、附点、三连音、延音、半音/八度记号、调号感知变音记号
- 🎸 和弦百科：60+ 和弦类型（含九/十一/十三/变化音/slash 转位）指法速查
- 📚 曲谱库：曲谱保存在系统应用数据目录（跨 macOS / Windows / Linux），关闭前自动提醒保存
- 🌐 局域网分享：开启内置服务器，同网设备浏览器即可查看当前谱面（只读，默认端口 8848）
- 🎲 随机生成音乐片段
- 🎨 五套主题：拉丝金属 / 亚麻纸 / Win 经典 / Windows 10 / KDE
- 💾 导出/导入 JSON 曲谱，曲谱自动入库
- 📥 MIDI 文件导入

## 下载

前往 [Releases](https://github.com/Ricer2008/ChordBridge/releases) 下载对应平台的安装包。

- macOS: ChordBridge_0.2.0-beta_aarch64\ChordBridge_0.2.0-beta_x64
- Windows: 待补充
- Linux: 待补充

## 技术栈

- Rust + Tauri v2
- HTML + CSS + JavaScript（无框架、无构建步骤）

## 开源协议

MIT License
