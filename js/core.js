/* 抖音净播 · 核心配置与公共工具
 *
 * 性能红线（下面所有模块都必须遵守）：
 * 1) 视觉改动全部交给静态 CSS；运行时唯一的样式写入是底部进度条的
 *    transform: scaleX() 与一次性的颜色变量，前者走合成层，不触发重排；
 * 2) 不做列表轮询、不全站监听。唯一的定时器是 main.js 里 2 秒一次的视频身份看门狗，
 *    只比对 <video> 引用与卡片文案指纹；导航逐项隐藏用的是 #douyin-navigation 内的
 *    局部 MutationObserver（custom / off 模式启用），不会观察整页；
 * 3) 刷视频的时机只来自媒体事件（loadedmetadata / play 捕获阶段），事件驱动；
 *    进度条用 requestVideoFrameCallback 逐帧更新，同样不是定时器；
 * 4) 鼠标事件 passive，且每帧最多处理一次，只切换一个 class；
 * 5) 扫描类操作只在启动时做一次，并且有数量上限。
 */
(() => {
  'use strict';

  const D = (window.__DYC = {
    VER: '1.9.3',
    debug: false,

    // 视频代次：每换一条视频 +1。
    // 抖音大量视频的 duration 是 Infinity、currentSrc 是空串（MSE 流），
    // 用它们当"视频身份"会全部撞成一个 key，导致过滤/清晰度只对第一条生效。
    // 所以统一用这个由 main.js 在"新视频事件"里递增的代次当身份。
    gen: 0,

    // 浮层静止 / 移出视频画面后多久自动隐藏（毫秒）
    HIDE_DELAY: 2000,
    // 新视频开始播放后延迟多久去切清晰度
    // （要等播放器把这一条的档位表请求回来，太早读到的是上一条的旧表）
    QUALITY_DELAY: 1600,

    QUALITY_RANK: ['4K', '蓝光', '2K', '超清', '高清', '标清', '智能', '流畅'],

    KEEP_RE: /(通知|消息|私信|notification|message|inbox|im-entry|avatar)/i,
    BLOCK_WORDS: ['广告', '推广', '赞助'],

    SEL: {
      aside: 'aside',
      feedWrap: '[data-e2e="slideList"]',
      feedItem: '[data-e2e="feed-item"]',
      activeCard: '[data-e2e="feed-active-video"]',
      infoBox: '.video-info-detail',
      digg: '[data-e2e="video-player-digg"]',
      commentIcon: '[data-e2e="feed-comment-icon"]',
      collect: '[data-e2e="video-player-collect"]',
      share: '[data-e2e="video-player-share"]',
      qualityBtn: '.xgplayer-playclarity-setting, .douyin-player-playclarity-setting, .xgplayer-quality-selector, [class*="clarity-setting"], [class*="quality-selector"]',
      qualityItem: '.xgplayer-quality-item, [class*="quality-item"], [class*="clarity-item"], [class*="playclarity-item"]',
      nextArrow: '[data-e2e="video-switch-next-arrow"]',
      badge: '[data-e2e*="badge"], [class*="badge"], [class*="Badge"]'
    }
  });

  // 只在"刷视频"的页面激活；其他页面扩展完全静默
  D.isShell = () => {
    const p = location.pathname;
    return p === '/' ||
      /^\/(jingxuan|video|discover|channel|hot|recommend|following|friend)(\/|$)/.test(p);
  };

  D.log = (...args) => {
    if (D.debug) console.log('%c[抖音净播]', 'color:#25f4ee;font-weight:bold', ...args);
  };

  // 多个元素的最近公共祖先，用来从"点赞/评论/收藏/分享"反推右侧互动栏容器
  D.commonAncestor = (nodes, root) => {
    const list = (nodes || []).filter(Boolean);
    if (!list.length) return null;
    let cur = list[0];
    while (cur && cur !== root) {
      if (list.every(n => cur.contains(n))) return cur;
      cur = cur.parentElement;
    }
    return null;
  };

  // 任务丢到空闲时段执行，避免和播放器抢主线程
  D.idle = fn => {
    if ('requestIdleCallback' in window) requestIdleCallback(fn, { timeout: 1500 });
    else setTimeout(fn, 80);
  };

  D.sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  // 当前正在播放的视频元素：取"在播 + 面积最大"的那个，兼容任何页面布局
  D.playingVideo = () => {
    const all = Array.from(document.querySelectorAll('video'));
    if (!all.length) return null;
    const area = v => {
      const r = v.getBoundingClientRect();
      return (r.width * r.height) || 0;
    };
    const playing = all.filter(v => !v.paused && v.readyState >= 2);
    const pool = playing.length ? playing : all.filter(v => area(v) > 40000);
    if (!pool.length) return null;
    pool.sort((a, b) => area(b) - area(a));
    return pool[0];
  };

  D.textOf = el => (el && el.textContent ? el.textContent.replace(/\s+/g, '').trim() : '');

  // 两个矩形是否相邻/相交（pad 为额外容差）
  D.near = (a, b, pad = 40) => !!a && !!b &&
    a.left < b.right + pad && a.right > b.left - pad &&
    a.top < b.bottom + pad && a.bottom > b.top - pad;
})();
