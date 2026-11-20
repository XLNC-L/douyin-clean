/* 扩展设置：读取 / 归一化 / 广播
 *
 * 设置保存在 chrome.storage.sync，popup 与内容脚本共用同一份 schema。
 * 默认值 = 1.6.0 的行为（导航整条隐藏、所有功能开启），升级后不改变老用户观感。
 *
 * 载入时机：document_start，排在所有功能模块之前，模块在 IIFE 里就能读到 D.settings；
 * 异步读取完成后调用 apply()，把变化实时广播给各模块，无需刷新页面。
 */
(() => {
  'use strict';
  const D = window.__DYC;
  if (!D) return;

  const DEFAULTS = window.__DYC_DEFAULTS;
  const normalize = window.__DYC_NORMALIZE;
  if (!DEFAULTS || !normalize) {
    D.log('settings: defaults.js 未加载');
    return;
  }

  D.DEFAULT_SETTINGS = DEFAULTS;
  D.normalizeSettings = normalize;
  D.settings = normalize(DEFAULTS);

  const html = document.documentElement;

  // 先用默认值挂上「整条隐藏」，document_start 时导航还没解析出来，不会闪。
  // 全站生效（不只是刷视频页面），否则切到「我的 / 收藏」会先看到完整侧栏再消失。
  // 读取到用户设置后若为 custom / off，再把这个 class 摘掉。
  html.classList.add('dyc-nav-hidden');

  // 有些项要隐藏的是"带背景 / 边框的那一层容器"，纯 CSS 上溯会漏（类名是哈希、
  // 层级也会变），所以运行时向上找到真正有皮肤的一层，打 data-dyc-wrap 交给 CSS。
  function wrapOf(el, maxUp, maxW, maxH) {
    let node = el;
    let best = null;
    for (let i = 0; i < maxUp && node && node !== document.body; i++, node = node.parentElement) {
      const r = node.getBoundingClientRect();
      if (r.width > maxW || r.height > maxH) break;
      const cs = getComputedStyle(node);
      const skin = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
        parseFloat(cs.borderTopWidth) > 0 ||
        parseFloat(cs.borderRadius) > 0;
      if (skin) best = node;
    }
    return best;
  }

  function syncWraps() {
    const uh = D.settings.uiHide || {};
    for (const el of document.querySelectorAll('[data-dyc-wrap]')) {
      el.removeAttribute('data-dyc-wrap');
    }
    if (uh.search) {
      const inp = document.querySelector('[data-e2e="searchbar-input"]');
      const box = inp && wrapOf(inp, 5, 900, 90);
      if (box) box.setAttribute('data-dyc-wrap', 'search');
    }
    if (uh.arrows) {
      const a = document.querySelector('[data-e2e="video-switch-next-arrow"]');
      const box = a && wrapOf(a, 4, 240, 240);
      if (box) box.setAttribute('data-dyc-wrap', 'arrows');
    }
    // 「听抖音」没有 data-e2e，是「更多」前面那个兄弟节点（文案固定）。
    // 页面里同时有好几张卡片、每张各有一份互动栏，必须逐个 rail 标；
    // 只取第一个 querySelector 会把标记打到视口外的卡片上，当前视频就一直露着。
    if (uh.music) {
      document.querySelectorAll('[data-e2e="video-play-more"]').forEach(more => {
        const rail = more.parentElement;
        if (!rail) return;
        for (const child of rail.children) {
          if (String(child.textContent || '').trim() === '听抖音') {
            child.setAttribute('data-dyc-wrap', 'music');
            break;
          }
        }
      });
    }
  }
  D.syncWraps = syncWraps;

  // 互动栏是"贴底"布局：隐藏哪一项，剩余项就自然重排、整条向下贴底。
  // 不再用 min-height 顶住原高度 —— 那样隐藏越多，上方空得越多，整条会停在半空。
  const RAIL_ITEMS = [
    ['digg', '[data-e2e="video-player-digg"]'],
    ['comment', '[data-e2e="feed-comment-icon"]'],
    ['collect', '[data-e2e="video-player-collect"]'],
    ['share', '[data-e2e="video-player-share"]'],
    ['more', '[data-e2e="video-play-more"]']
  ];

  // 每一项要隐藏的层级不一样：多数版本按钮外面还包一层无 class 的 div（那才是
  // 真正的 flex 子项），但收藏 / 更多 / 听抖音有时直接挂在整条互动栏下。
  // 所以向上找一层，只有它不是 rail 时才连包装一起标记 —— 否则会把整栏藏掉。
  function markRailItems(rail, uh) {
    for (const [key, sel] of RAIL_ITEMS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      let box = el;
      const p = el.parentElement;
      if (p && p !== rail) box = p;
      if (uh[key] === true) box.setAttribute('data-dyc-rail-hide', '');
      else box.removeAttribute('data-dyc-rail-hide');
    }
    if (uh.music === true) {
      const m = rail.querySelector('[data-dyc-wrap="music"]');
      if (m) m.setAttribute('data-dyc-rail-hide', '');
    } else {
      rail.querySelectorAll('[data-dyc-wrap="music"]').forEach(m => m.removeAttribute('data-dyc-rail-hide'));
    }
  }

  // 评论区顶部的七个元素：tab 的文案会变（AI 那个只有图标），按文案打标记，
  // CSS 再按开关隐藏。只有七项全部隐藏时，才给 html 挂 dyc-cm-allhidden ——
  // 那条规则负责把整条顶部摘出文档流，让评论列表上移贴顶。
  const CM_TABS = [
    ['cmworks', 'TA的作品'],
    ['cmcomment', '评论'],
    ['cmmix', '合集'],
    ['cmrec', '相关推荐'],
    ['cmhot', '热点']
  ];
  const CM_KEYS = ['cmai', 'cmworks', 'cmcomment', 'cmmix', 'cmrec', 'cmhot', 'cmsearch'];

  function syncCommentTop() {
    const uh = D.settings.uiHide || {};
    const bar = document.querySelector('[role="tablist"]');
    if (bar) {
      for (const tab of bar.querySelectorAll('[role="tab"]')) {
        const t = String(tab.textContent || '').trim();
        let key = '';
        if (!t || t === 'AI') key = 'cmai';
        else {
          for (const [k, text] of CM_TABS) {
            if (t === text) { key = k; break; }
          }
        }
        if (key) tab.setAttribute('data-dyc-cm-tab', key);
      }
    }
    html.classList.toggle('dyc-cm-allhidden', CM_KEYS.every(k => uh[k] === true));
  }
  D.syncCommentTop = syncCommentTop;

  function syncRailHeight() {
    const rail = document.querySelector('div:has(> div > [data-e2e="video-player-digg"])');
    if (!rail) return;
    const uh = D.settings.uiHide || {};
    markRailItems(rail, uh);
    // 隐藏哪一项，剩余项就自然重排、整条向下贴底（抖音原生布局就是这样）。
    // 之前用 min-height 顶住原高度 + 垂直居中，隐藏越多上面空得越多，看起来
    // 整条停在半空；现在把这两条内联一起清掉，让容器跟着内容收缩。
    if (rail.style.minHeight) rail.style.minHeight = '';
    if (rail.style.justifyContent) rail.style.justifyContent = '';
    if (rail.dataset.dycBaseH) delete rail.dataset.dycBaseH;
    shiftRail(rail);
  }
  D.syncRailHeight = syncRailHeight;

  // 关闭控制条后，右侧互动栏跟着左下文案一起下沉 48px（原控制条高度），
  // 填上腾出来的底部空间。互动栏本身是 static，真正贴底的是它外面那层
  // absolute（实测 bottom: 60px），所以改定位层的 bottom，并记住原值以便还原。
  function shiftRail(rail) {
    const on = !!(D.settings.uiHide && D.settings.uiHide.controls === true);
    let host = null;
    let p = rail;
    for (let i = 0; i < 6 && p && p !== document.body; i++, p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.position === 'absolute' || cs.position === 'fixed') { host = p; break; }
    }
    // 抖音换视频会重建节点：把不属于当前这条的旧偏移还原
    document.querySelectorAll('[data-dyc-base-bottom]').forEach(el => {
      if (el !== host || !on) {
        el.style.bottom = '';
        delete el.dataset.dycBaseBottom;
      }
    });
    if (!host) return;
    if (!on) return;
    if (!host.dataset.dycBaseBottom) {
      const cur = getComputedStyle(host).bottom;
      if (!cur || cur === 'auto' || isNaN(parseFloat(cur))) return;
      host.dataset.dycBaseBottom = cur;
    }
    const b = parseFloat(host.dataset.dycBaseBottom);
    if (!isNaN(b)) host.style.bottom = Math.max(0, Math.round(b - 48)) + 'px';
  }

  function apply() {
    // 页面元素开关：只在 html 上挂 dyc-h-<key>，具体隐藏规则全在 content.css 里。
    // 不碰 DOM 结构、不拦事件，所以播放 / 切条 / 评论等能力不受影响。
    const uh = D.settings.uiHide || {};
    for (const k of Object.keys(uh)) {
      html.classList.toggle('dyc-h-' + k, uh[k] === true);
    }
    syncWraps();
    syncCommentTop();
    syncRailHeight();
    const keep = D.settings.nav.keep || [];
    const navHidden = D.settings.nav.mode === 'hide' ||
      (D.settings.nav.mode === 'custom' && !keep.length);
    html.classList.toggle('dyc-nav-hidden', navHidden);
    // 自定义保留 / 保持原样保持抖音原生宽度：向右补满会把互动栏推到视口右缘、
    // 压住原生的上下切换箭头，所以不再加宽。
    // 模块可能还没加载（脚本按顺序注入，storage 回调是异步的），逐个判空
    if (D.nav) D.nav.apply();
    if (D.header) D.header.applySettings();
    if (D.overlay) D.overlay.applySettings();
    if (D.progress) D.progress.applySettings();
    if (D.quality) D.quality.applySettings();
    if (D.filter) D.filter.applySettings();
    if (D.live) D.live.apply();
  }
  D.applySettings = apply;

  function load(raw) {
    D.settings = normalize(raw);
    D.settingsReady = true;
    apply();
    D.log('settings: 已应用', D.settings);
  }

  try {
    if (chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.get({ settings: DEFAULTS }, res => {
        if (chrome.runtime.lastError) {
          D.log('settings: 读取失败，使用默认值', chrome.runtime.lastError.message);
          load(DEFAULTS);
          return;
        }
        load(res && res.settings);
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync' || !changes.settings) return;
        load(changes.settings.newValue);
      });
    } else {
      load(DEFAULTS);
    }
  } catch (e) {
    D.log('settings: storage 不可用，使用默认值', e && e.message);
    load(DEFAULTS);
  }

  // popup 通过 tabs.sendMessage 查询当前页面状态 / 取走判定诊断日志
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return;
      if (msg.type === 'dyc:get-diag') {
        sendResponse({
          version: D.VER,
          diag: D.filter && D.filter.diag ? D.filter.diag() : []
        });
        return;
      }
      if (msg.type === 'dyc:clear-noskip') {
        const cleared = (D.filter && D.filter.clearNoSkip) ? D.filter.clearNoSkip() : 0;
        sendResponse({ cleared });
        return;
      }
      if (msg.type !== 'dyc:get-state') return;
      sendResponse({
        version: D.VER,
        settings: D.settings,
        navItems: D.nav ? D.nav.labels() : [],
        headerItems: D.header ? D.header.labels() : [],
        noSkip: (D.filter && D.filter.noSkipCount) ? D.filter.noSkipCount() : 0,
        page: location.pathname
      });
    });
  } catch (e) { /* 扩展上下文失效时忽略 */ }
})();
