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

  function apply() {
    const keep = D.settings.nav.keep || [];
    const navHidden = D.settings.nav.mode === 'hide' ||
      (D.settings.nav.mode === 'custom' && !keep.length);
    html.classList.toggle('dyc-nav-hidden', navHidden);
    // 模块可能还没加载（脚本按顺序注入，storage 回调是异步的），逐个判空
    if (D.nav) D.nav.apply();
    if (D.header) D.header.applySettings();
    if (D.overlay) D.overlay.applySettings();
    if (D.progress) D.progress.applySettings();
    if (D.quality) D.quality.applySettings();
    if (D.filter) D.filter.applySettings();
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

  // popup 通过 tabs.sendMessage 查询当前页面状态
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== 'dyc:get-state') return;
      sendResponse({
        version: D.VER,
        settings: D.settings,
        navItems: D.nav ? D.nav.labels() : [],
        headerItems: D.header ? D.header.labels() : [],
        page: location.pathname
      });
    });
  } catch (e) { /* 扩展上下文失效时忽略 */ }
})();
