/* 启动自检 + 安全降级 + 诊断导出
 *
 * 抗改版的地基：抖音改结构时，扩展必须"知道自己坏了"，而不是默默误判、乱跳视频。
 * 这里只做三件事：
 *   1) 探测 6 个关键锚点，算出健康度；
 *   2) 关键锚点（信息流卡片 / 当前卡片 / <video>）缺失时置 D.safeMode = true，
 *      filter 会据此停止"跳视频"这类破坏性动作，只保留纯 CSS 视觉改动；
 *   3) 暴露 __DYC.diag()，一次性导出可复制的诊断 JSON。
 *
 * 性能：不做定时轮询。只在启动 1.2 秒后测一次，以及 html 的 class 变化时重测
 * （路由切换会改 dyc-feed，正好是重新评估的时机）。每次探测只查 6 个选择器。
 */
(() => {
  'use strict';
  const D = window.__DYC;
  if (!D) return;

  const html = document.documentElement;

  // weight 只用于健康度打分，不参与 safeMode 判定
  const CHECKS = [
    { key: 'feedItem', sel: '[data-e2e="feed-item"]', weight: 3, critical: true },
    { key: 'activeCard', sel: '[data-e2e="feed-active-video"]', weight: 3, critical: true },
    { key: 'video', sel: 'video', weight: 2, critical: true },
    { key: 'nextArrow', sel: '[data-e2e="video-switch-next-arrow"]', weight: 1 },
    { key: 'videoId', sel: '[data-e2e-vid]', weight: 1 },
    { key: 'nav', sel: '#douyin-navigation', weight: 1 },
    { key: 'clarity', sel: '.xgplayer-playclarity-setting, .douyin-player-playclarity-setting', weight: 1 }
  ];

  D.health = { ts: 0, route: '', items: {}, score: 0, total: 0, safeMode: false };
  D.safeMode = false;
  let announced = false;
  // 首屏可能还没渲染出信息流卡片：关键锚点缺失时先继续探测，别急着进安全模式。
  // 误判成安全模式会让"跳广告"看起来完全失灵，这比晚几秒降级更糟。
  let probeTries = 0;
  const PROBE_MAX = 8;
  const PROBE_GAP = 1200;

  function probe() {
    const feed = D.route.feed;
    const items = {};
    let score = 0;
    let total = 0;
    for (const c of CHECKS) {
      const ok = !!document.querySelector(c.sel);
      items[c.key] = ok;
      total += c.weight;
      if (ok) score += c.weight;
    }

    // 只在"刷视频"页面评估破坏性动作的可用性；其他页面本来就不跳视频。
    // 信息流卡片与在播视频都找不到时，跳视频很可能是在错误的卡片上乱切，必须停手。
    const criticalOk = (items.feedItem || items.activeCard) && items.video;

    // 首屏还没渲染出卡片：继续探测，暂不改 safeMode（避免把"加载慢"误判成"改版"）。
    // 关键锚点已经齐了、但辅助项（导航 / 清晰度组件）还没渲染时再多等两轮，
    // 否则健康度会显示成一个误导性的低分。
    const needMore = criticalOk ? (score < total && probeTries < 2) : (probeTries < PROBE_MAX);
    if (feed && needMore) {
      probeTries++;
      D.health = {
        ts: Date.now(),
        route: location.pathname,
        items,
        score,
        total,
        feed,
        safeMode: D.safeMode,
        waiting: true,
        probeTries
      };
      schedule(PROBE_GAP);
      return D.health;
    }
    if (criticalOk) probeTries = 0;

    const safeMode = feed && !criticalOk;

    const prev = D.safeMode;
    D.health = {
      ts: Date.now(),
      route: location.pathname,
      items,
      score,
      total,
      feed,
      safeMode
    };
    D.safeMode = safeMode;

    if (safeMode !== prev) {
      D.log(safeMode
        ? 'health: 关键选择器失效，进入安全模式（只保留视觉改动，不跳视频）'
        : 'health: 关键选择器正常，退出安全模式');
    }
    // 首次自检无条件打一行，方便确认"新代码确实注入了、自检确实跑过了"
    if (!announced) {
      announced = true;
      console.log(
        '%c[抖音净播] 自检',
        'color:#25f4ee;font-weight:bold',
        score + '/' + total,
        JSON.stringify(items),
        feed ? (safeMode ? '安全模式' : '正常') : '非信息流页面'
      );
    }
    D.log('health:', '健康度 ' + score + '/' + total, items, feed ? '' : '(非信息流页面)');

    // 把精简状态写到 DOM 上：外部（CDP / 控制台一行代码）不用进隔离世界也能看到
    // 当前到底挂了哪条视频、判定有没有命中。定位"时好时坏"最省事的入口。
    try {
      const pv = D.playingVideo();
      const card = pv ? pv.closest('[data-e2e="feed-active-video"], [data-e2e="feed-item"]') : null;
      const fp = D.filter && D.filter.probe ? (D.filter.probe() || {}) : {};
      document.documentElement.setAttribute('data-dyc-health', JSON.stringify({
        safe: safeMode,
        score,
        total,
        gen: D.gen,
        vid: card ? card.getAttribute('data-e2e-vid') : null,
        hit: fp.hit || null,
        live: fp.live || null,
        paused: pv ? pv.paused : null,
        vis: pv ? Math.round(D.visibleArea(pv)) : 0
      }));
    } catch (e) { /* 忽略 */ }

    return D.health;
  }

  D.diag = () => {
    const v = D.playingVideo();
    return {
      版本: D.VER,
      时间: new Date().toISOString(),
      页面: {
        路由: location.pathname + location.search,
        信息流: D.route.feed,
        能力: D.route,
        安全模式: D.safeMode === true,
        焦点: document.hasFocus(),
        可见: !document.hidden
      },
      自检: D.health,
      代次: D.gen,
      视频: v ? {
        实测: (v.videoWidth || 0) + 'x' + (v.videoHeight || 0),
        时长: v.duration,
        当前: Math.round((v.currentTime || 0) * 10) / 10,
        暂停: v.paused,
        静音: v.muted,
        卡片: (() => {
          const card = v.closest('[data-e2e="feed-item"], [data-e2e="feed-active-video"], .slider-video');
          return card ? {
            有卡片: true,
            视频ID: (function () {
              const a = card.querySelector('a[href*="/video/"]') || (card.closest && card.closest('a[href*="/video/"]'));
              const href = a ? (a.getAttribute('href') || '') : '';
              const m = /\/video\/(\d{8,})/.exec(href);
              return m ? m[1] : null;
            })()
          } : { 有卡片: false };
        })()
      } : null,
      清晰度: D.quality && D.quality.probe ? D.quality.probe() : null,
      过滤: D.filter && D.filter.probe ? D.filter.probe() : null,
      进度: D.progress && D.progress.probe ? D.progress.probe() : null,
      布局标记: {
        导航隐藏项: document.querySelectorAll('[data-dyc-nav-hide]').length,
        顶栏隐藏项: document.querySelectorAll('[data-dyc-hide]').length,
        浮层标记: document.querySelectorAll('[data-dyc-ui]').length
      }
    };
  };

  // 控制台手动导出（也可以直接 __DYC.diag() 看对象）
  D.exportDiag = () => {
    const json = JSON.stringify(D.diag(), null, 2);
    console.log('[抖音净播] 诊断\n' + json);
    return json;
  };

  // 只在需要时测：启动后一次 + html class 变化（路由切换）时
  let timer = 0;
  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(probe, delay);
  }
  schedule(1200);

  try {
    new MutationObserver(() => {
      probeTries = 0;          // 路由变化：重新给首屏渲染留出探测次数
      schedule(400);
    }).observe(html, { attributes: true, attributeFilter: ['class'] });
  } catch (e) { /* 忽略 */ }
})();
