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

  // 无条件打印版本横幅：排查"扩展已更新但页面还在跑旧代码"时，
  // 对照控制台这里的版本号与 chrome://extensions 显示的是否一致即可分辨。
  console.log('%c[抖音净播] v' + D.VER + ' 已注入', 'color:#25f4ee;font-weight:bold');
  let bootTimer = 0;
  let retries = 0;
  let href = location.href;
  let lastVideo = null;
  let lastSrc = '';
  let lastGenAt = 0;
  let lastSig = "";
  let lastCard = null;
  let lastPoster = '';

  const srcOf = v => (v && (v.currentSrc || v.src)) || '';

  // 尽早挂上页面标记，避免左侧导航先闪一下再消失
  html.classList.toggle('dyc-feed', D.isShell());

  function teardown() {
    html.classList.remove('dyc-ui-on');
    D.overlay.reset();
    D.progress.reset();
    D.filter.reset();
    D.quality.reset();
    D.header.reset();
    D.nav.reset();
    lastVideo = null;
    lastSrc = '';
    lastSig = '';
    lastCard = null;
    lastPoster = '';
  }

  function boot() {
    clearTimeout(bootTimer);
    if (!html.classList.contains('dyc-feed')) {
      teardown();
      return;
    }
    D.nav.apply();
    D.header.apply();
    const v = D.playingVideo();
    if (v) {
      lastVideo = v;
      D.overlay.sync(v);
      D.progress.attach(v);
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
    D.nav.apply();
    bootTimer = setTimeout(boot, 350);
  }

  // ---------- 新视频 ----------
  // 关键：抖音复用同一个 <video> 元素播放所有视频，元素引用永远不变，
  // 所以不能靠"元素变了"判断换视频，必须靠媒体事件（每次换片/换清晰度都会重新触发）。
  // 而 duration / currentSrc 都不能当身份：抖音大量视频是 MSE 流，
  // duration 常为 Infinity、currentSrc 常为空串，一撞就是全站同一个 key。
  // 因此统一用"代次" D.gen 表示当前是哪一条视频。
  // 只有"换了一张视频卡片"才算换了一条视频。
  // 抖音会把相邻视频预加载在 DOM 里、也会让短视频循环播放，它们都会反复触发
  // loadedmetadata / playing；若按事件次数计数，代次会虚增，过滤就会反复重扫同一张卡片
  // （单条视频十几秒内能重扫二十多次，白白吃 DOM 开销）。
  // 所以用"视频所在卡片元素"当身份：换片必然换卡片，循环播放 / 换清晰度都不换。
  function cardOfVideo(v) {
    return v.closest('[data-e2e="feed-item"], [data-e2e="feed-active-video"], .slider-video') ||
      v.parentElement;
  }

  // 判定"换了一条视频"是整套逻辑的地基，而抖音这边几乎没有可靠的媒体字段：
  //   duration 常为 Infinity、currentSrc 常为空串、卡片 DOM 会被反复重渲染。
  // 唯一稳定的、每条视频都不同的东西是卡片上的文案（标题/话题），
  // 所以用文案指纹当代次，认不出文案时才退回"隔 6 秒算一条"的时间判定。
  function videoSig(v) {
    const card = cardOfVideo(v);
    if (card) {
      const el = card.querySelector('.video-info-detail, [data-e2e*="video-desc"], [data-e2e*="video-info"]');
      const t = el ? D.textOf(el) : '';
      if (t) return t.slice(0, 40);
    }
    const d = v.duration;
    return (d > 0 && isFinite(d)) ? 'd' + Math.round(d * 10) : '';
  }

  function bumpGen(v) {
    // 预加载的相邻视频一律不算（它们处于暂停状态）
    if (v.paused) return;
    const now = Date.now();
    const sig = videoSig(v);
    const card = cardOfVideo(v);
    const poster = v.poster || '';

    if (sig) {
      // 标题指纹单独用会撞车：转载 / 同文案的连续两条视频标题完全一样。
      // 补两个旁证：① 视频卡片元素换了；② 封面地址换了（同一视频换清晰度不会换封面）。
      const cardChanged = !!(card && lastCard && card !== lastCard);
      const posterChanged = !!(lastPoster && poster && poster !== lastPoster);
      if (sig === lastSig && !cardChanged && !posterChanged) return;
      lastSig = sig;
      lastCard = card;
      if (poster) lastPoster = poster;
      D.gen++;
      lastGenAt = now;
      return;
    }

    lastCard = card;
    if (poster) lastPoster = poster;
    if (now - lastGenAt < 6000) return;
    D.gen++;
    lastGenAt = now;
  }

  function onNewVideo(v) {
    if (!v) return;
    bumpGen(v);
    lastVideo = v;
    lastSrc = srcOf(v);
    D.overlay.sync(v);
    D.progress.attach(v);
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

  // 身份比对看门狗：兜住事件漏掉的少数情况。
  // 注意不能用 src 当身份：抖音是 MSE 流，换清晰度/换流时 src 会自己变（甚至清空），
  // 拿它比对会每隔 2 秒就误判成"换了一条视频"，把清晰度那一轮的排队任务反复作废。
  // 所以这里只比 video 引用和卡片文案指纹（和代次判定用同一把尺子）。
  setInterval(() => {
    if (document.hidden) return;
    if (!html.classList.contains('dyc-feed')) return;
    const v = D.playingVideo();
    if (v) {
      const sig = v.paused ? '' : videoSig(v);
      if (v !== lastVideo || (sig && sig !== lastSig)) onNewVideo(v);
    }
    D.filter.closePopups(v);        // 顺手关掉头像旁的直播/推广小窗
  }, 2000);

  // ---------- 失焦自动暂停（不自动恢复） ----------
  function pauseActive() {
    if (!html.classList.contains('dyc-feed')) return;
    if (!D.settings || D.settings.pause === false) return;
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

  // ---------- 调试：Alt+Shift+D ----------
  // （不能用 Ctrl+Shift+D：那是 Chrome"收藏所有标签页"的浏览器级快捷键，按键到不了页面）
  window.addEventListener('keydown', e => {
    if (!e.altKey || !e.shiftKey || e.key.toLowerCase() !== 'd') return;
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
      进度条: D.progress.probe(),
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
