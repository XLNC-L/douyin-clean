/* 主控：页面模式、启动、新视频检测、失焦暂停、调试
 *
 * 新视频检测有两路，互为兜底：
 * 1) loadedmetadata / play / playing 事件（捕获阶段，正常路径，零开销）；
 * 2) 2 秒一次的身份比对（只比 video 元素引用，不做 DOM 查询/样式读取），
 *    用于页面在事件之外切换视频的少数情况。这个开销可以忽略，但能保证功能不漏。
 */
(() => {
  const D = window.__DYC;
  if (!D) return;

  const html = document.documentElement;
  let bootTimer = 0;
  let retries = 0;
  let href = location.href;
  let lastVideo = null;
  let lastSrc = '';

  const srcOf = v => (v && (v.currentSrc || v.src)) || '';

  // 尽早挂上页面标记，避免左侧导航先闪一下再消失
  html.classList.toggle('dyc-feed', D.isShell());

  function teardown() {
    html.classList.remove('dyc-ui-on');
    D.overlay.reset();
    D.filter.reset();
    D.quality.reset();
    D.header.reset();
    lastVideo = null;
    lastSrc = '';
  }

  function boot() {
    clearTimeout(bootTimer);
    if (!html.classList.contains('dyc-feed')) {
      teardown();
      return;
    }
    D.header.apply();
    const v = D.playingVideo();
    if (v) {
      lastVideo = v;
      D.overlay.sync(v);
    }
    retries = 0;
  }

  function onRoute() {
    if (location.href === href) return;
    href = location.href;
    const shell = D.isShell();
    html.classList.toggle('dyc-feed', shell);
    retries = 0;
    lastVideo = null;
    if (!shell) {
      teardown();
      return;
    }
    bootTimer = setTimeout(boot, 350);
  }

  // ---------- 新视频 ----------
  // 关键：抖音复用同一个 <video> 元素播放所有视频，元素引用永远不变，
  // 所以不能靠"元素变了"判断换视频，必须靠媒体事件（每次换片/换清晰度都会重新触发）。
  function onNewVideo(v) {
    if (!v) return;
    lastVideo = v;
    lastSrc = srcOf(v);
    D.overlay.sync(v);
    D.filter.checkAd(v);
    D.quality.schedule(v);
  }

  document.addEventListener('loadedmetadata', e => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || !html.classList.contains('dyc-feed')) return;
    onNewVideo(v);
  }, true);

  document.addEventListener('playing', e => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || !html.classList.contains('dyc-feed')) return;
    onNewVideo(v);
  }, true);

  // 换片/换清晰度前 src 会被清空（emptied），此时先排一次清晰度判断
  document.addEventListener('emptied', e => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || !html.classList.contains('dyc-feed')) return;
    if (v !== lastVideo && v !== D.playingVideo()) return;
    D.quality.schedule(v);
  }, true);

  // 身份比对看门狗：只读 video 引用和 src，不查 DOM，兜住事件漏掉的少数情况
  setInterval(() => {
    if (document.hidden) return;
    if (!html.classList.contains('dyc-feed')) return;
    const v = D.playingVideo();
    if (v && (v !== lastVideo || srcOf(v) !== lastSrc)) onNewVideo(v);
    D.filter.closePopups(v);        // 顺手关掉头像旁的直播/推广小窗
  }, 2000);

  // ---------- 失焦自动暂停（不自动恢复） ----------
  function pauseActive() {
    if (!html.classList.contains('dyc-feed')) return;
    if (document.hasFocus()) return;          // 只有整个窗口真的失去焦点才暂停
    const v = D.playingVideo();
    if (!v || v.paused || v.ended) return;
    try {
      v.pause();
      D.log('pause: 页面失去焦点，已自动暂停');
    } catch (e) { /* 忽略 */ }
  }
  window.addEventListener('blur', pauseActive);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseActive();
  });

  // ---------- 路由（SPA 跳转） ----------
  window.addEventListener('popstate', onRoute);
  window.addEventListener('hashchange', onRoute);
  document.addEventListener('click', () => setTimeout(onRoute, 80), { passive: true });

  // ---------- 调试：Ctrl+Shift+D ----------
  window.addEventListener('keydown', e => {
    if (!e.ctrlKey || !e.shiftKey || e.key.toLowerCase() !== 'd') return;
    e.preventDefault();
    D.debug = true;
    boot();
    const v = D.playingVideo();
    const info = {
      版本: D.VER,
      页面: location.href,
      播放视频: v ? {
        w: Math.round(v.getBoundingClientRect().width),
        h: Math.round(v.getBoundingClientRect().height),
        src: (v.currentSrc || '').slice(0, 60)
      } : null,
      导航已隐藏: !!document.getElementById('douyin-navigation') &&
        getComputedStyle(document.getElementById('douyin-navigation')).display === 'none',
      浮层已标记: document.querySelectorAll('[data-dyc-ui]').length,
      清晰度: D.quality.probe(),
      广告判定: D.filter.probe(),
      顶栏隐藏项: document.querySelectorAll('[data-dyc-hide]').length
    };
    console.log('[抖音净播] 状态', info);
    setTimeout(() => {
      document.querySelectorAll('[data-dyc-hide], [data-dyc-ui]').forEach(el => {
        el.style.outline = '1px solid #25f4ee';
        setTimeout(() => { el.style.outline = ''; }, 2500);
      });
    }, 300);
  }, { passive: false });

  // ---------- 启动 ----------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
  window.addEventListener('load', () => {
    retries = 0;
    boot();
  }, { once: true });
})();
