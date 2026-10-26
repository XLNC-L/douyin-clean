# 抖音净播 · Douyin Clean

![version](https://img.shields.io/github/v/release/XLNC-L/douyin-clean?label=version)
![license](https://img.shields.io/github/license/XLNC-L/douyin-clean)
![manifest](https://img.shields.io/badge/Manifest-V3-4285F4)
![platform](https://img.shields.io/badge/Chrome-Desktop-34A853)

![界面示意：左为默认界面，右为启用扩展后](docs/preview.svg)

一个针对**网页版抖音**（`www.douyin.com`）的 Chrome 扩展：**自动最高清晰度**、**带货广告自动跳过**、**失焦暂停**、**纯净布局**。

不轮询、不全站监听、不删 DOM 节点 —— 刷视频不卡。

## 它解决什么问题

网页版抖音默认把体验做得很"满"：清晰度默认「智能」不会自己升到 4K、推荐流里混着带货视频、左侧导航和顶栏图标占地方、切到后台还在响。

这个扩展把这些一次性处理掉，并且**只在你刷视频时工作**，其他页面完全静默。

## 功能

| 功能 | 说明 |
| --- | --- |
| 自动最高清晰度 | 每条视频独立判定，自动选到该视频可用的最高档（有 4K 就上 4K），切换结果用 `videoWidth/videoHeight` 实测复验，不以菜单文字为准 |
| 带货 / 广告跳过 | 识别商品卡（含无「购物」字样的新型卡）、店铺账号、推广视频并自动切下一条；**直播不跳过** |
| 失焦自动暂停 | 窗口失焦或切到后台时暂停，回到页面**不会**自动恢复，不跟你抢播放控制 |
| 浮层自动隐藏 | 标题文案、右侧互动栏：鼠标在画面内或移动时显示，静止 2 秒或移出 2 秒后淡出 |
| 左侧导航隐藏 | 隐藏左侧导航，视频区域占比更大 |
| 顶栏精简 | 右上角只留头像、通知、消息，其余图标隐藏（私信抽屉不受影响） |
| 评论区 | 保持手动开关，打开 / 收起照旧 |

## 安装

### 方式一：下载 Release（推荐）

1. 打开 [Releases](https://github.com/XLNC-L/douyin-clean/releases/latest)，下载最新的 `douyin-clean-v*.zip`；
2. 解压到一个**固定目录**（之后不要删，Chrome 会一直从这里加载）；
3. 打开 `chrome://extensions`，右上角开启「开发者模式」；
4. 点「加载已解压的扩展程序」，选择解压后含 `manifest.json` 的那一层目录；
5. 打开 `https://www.douyin.com/` 即可生效。

升级：下载新 Release 覆盖原目录 → 扩展管理页点「刷新」→ 刷新抖音页面。

### 方式二：克隆仓库

```bash
git clone https://github.com/XLNC-L/douyin-clean.git
```

用「加载已解压的扩展程序」直接选择仓库目录。

## 为什么不会卡

刷抖音卡顿通常不是抖音本身，而是插件：全站 `MutationObserver(subtree)`、`setInterval` 轮询 `querySelectorAll`、运行时反复改样式触发重排。

本扩展的硬约束：

- **视觉改动全部写在静态 CSS**（[css/content.css](css/content.css)），页面加载后运行时零样式计算；
- **换视频靠媒体事件驱动**（`loadedmetadata` / `playing` / `emptied`），另有一个 2 秒一次、只比对 `<video>` 引用与**卡片文案指纹**的轻量看门狗兜底；
- **不删 DOM 节点**：过滤只负责切到下一条，绝不动列表结构，虚拟列表与滚动吸附逻辑不受影响；
- **不轮询选择器**，需要等待时用事件或有限次 `await sleep`。

## 调试

在抖音页面按 **`Alt + Shift + D`**（`Ctrl + Shift + D` 被 Chrome 的「收藏所有标签页」占用，按键到不了页面）：

- 控制台打印当前状态：版本、播放器尺寸、清晰度档位、实测分辨率、广告判定、被隐藏的顶栏项；
- 给被隐藏 / 被标记的浮层加 2.5 秒青色描边，方便确认定位是否正确。

日志前缀为 `quality:` 与 `filter:`，例如：

```
[抖音净播] quality: 档位节点 6 个
[抖音净播] quality: 当前=智能 实测=1920p 最高档=超清 4K
[抖音净播] quality: 点档位 超清 4K
[抖音净播] quality: 实测已到 4K(3840)，本条视频不再调整
[抖音净播] filter: 识别到 购物卡片，跳过该视频
```

## 结构

```
manifest.json      MV3 声明：内容脚本、图标、匹配规则
css/content.css    全部视觉改动（静态 CSS）
js/core.js         公共命名空间、选择器、工具函数、视频代次
js/quality.js      自动最高清晰度
js/overlay.js      视频浮层显隐
js/filter.js       广告 / 带货过滤、直播小窗关闭
js/header.js       顶栏图标精简
js/main.js         启动、新视频检测、失焦暂停、调试
docs/preview.svg   README 顶部的界面示意
CHANGELOG.md       逐版本改动记录
```

## 已知限制

- 只适配 `www.douyin.com` 桌面网页版，不支持手机网页版与抖音客户端；
- 抖音前端类名是哈希动态生成的，扩展只依赖 **ID / `data-e2e` / 几何特征 / 语义文本** 定位元素，大改版后可能需要跟进；
- 清晰度受视频源限制：源本身没有 4K 时，抖音会把 4K 顺延到可用最高档，扩展接受这个结果，不会反复重试；
- 网页端播放器把同一条视频的多个清晰度当作「同一条视频」复用同一个 `<video>` 元素，因此扩展用「代次 + 文案指纹」而不是 `duration` / `src` 来判断换片。

## 更新日志

每个版本的详细改动见 [CHANGELOG.md](CHANGELOG.md)；可下载的安装包见 [Releases](https://github.com/XLNC-L/douyin-clean/releases)。

## License

[MIT](LICENSE)
