/* 抖音净播 · 核心配置与公共工具
 *
 * 性能红线（下面所有模块都必须遵守）：
 * 1) 视觉改动全部交给静态 CSS；运行时唯一的样式写入是底部进度条的
 *    transform: scaleX() 与一次性的颜色变量，前者走合成层，不触发重排；
 * 2) 不做列表轮询、不全站监听。唯一的定时器是 main.js 里 2 秒一次的视频身份看门狗，
 *    只比对 <video> 引用与卡片文案指纹；导航逐项隐藏用的是 #douyin-navigation 内的
 *    局部 MutationObserver（custom / off 模式启用），不会观察整页；
 * 3) 刷视频的时机只来自媒体事件（loadedmetadata / play 捕获阶段），事件驱动；
 *    进度条用 requestAnimationFrame 逐帧读 currentTime，同样不是定时器；
 * 4) 鼠标事件 passive，且每帧最多处理一次，只切换一个 class；
 * 5) 扫描类操作只在启动时做一次，并且有数量上限。
 */
(() => {
  'use strict';

  const D = (window.__DYC = {
    VER: '2.0.3',
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

  // ---------- 路由能力矩阵 ----------
  // 旧版只有一个 isShell 布尔：非信息流页面全部静默，而视频详情页又被当成信息流
  // （会去点"下一条"箭头，但详情页根本没有这个结构）。
  // 现在按"这个页面能做什么"声明能力，模块只依赖能力，不再各自判断某个 class：
  //   feed   - 竖向信息流，可以切下一条（广告过滤 / 切条）
  //   player - 有播放器，可以做清晰度 / 进度线 / 浮层显隐（详情页、影院、短剧、合集）
  // 左侧导航与顶栏精简本来就是全站生效，不需要额外能力。
  const FEED_ROOTS = new Set(['jingxuan', 'recommend', 'following', 'friend', 'discover', 'hot', 'channel']);
  const PLAYER_ROOTS = new Set([
    'video', 'theater', 'cinema', 'movie', 'film',
    'series', 'drama', 'playlet', 'shortplay',
    'collection', 'mix',
    // 放映厅（/vs）与 AI 搜索页也可能带播放器
    'vs', 'aisearch',
    // 搜索结果 / 用户主页也有播放器（卡片里点开就播），浮层与进度线同样需要工作
    'search', 'user'
  ]);

  D.routeOf = (path, host) => {
    const p = path || '/';
    const h = String(host || (typeof location !== 'undefined' ? location.hostname : ''));
    // 直播站是独立域名（live.douyin.com），结构完全不同：没有信息流卡片，不能切条
    if (h.indexOf('live.douyin.com') >= 0) return { page: 'live', feed: false, player: true };
    // 推荐页顶部的搜索框打开的是 /root/search/<关键词>（不是 /search/<关键词>），
    // 真正的页面类型在 root 之后的第二段；只取第一段会把整页认成 other，
    // 于是浮层显隐与进度线全都不工作。
    const segs = p.split('/').filter(Boolean).map(s => s.toLowerCase());
    const seg = (segs[0] === 'root' && segs[1]) ? segs[1] : (segs[0] || '');
    if (p === '/' || FEED_ROOTS.has(seg)) return { page: 'feed', feed: true, player: true };
    if (PLAYER_ROOTS.has(seg)) return { page: seg, feed: false, player: true };
    return { page: 'other', feed: false, player: false };
  };

  D.route = D.routeOf(
    typeof location !== 'undefined' ? location.pathname : '/',
    typeof location !== 'undefined' ? location.hostname : ''
  );

  // 兼容旧调用：isShell 等价于"是信息流页面"
  D.isShell = () => D.route.feed;

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

  // 当前正在播放的视频元素：取"在播 + 可见面积最大"的那个，兼容任何页面布局。
  // 关键：必须按"与视口的交集面积"排序，不能按 rect 的宽高。
  // 抖音会把相邻视频预加载在 DOM 里，它们与当前视频尺寸完全一样（rect 面积相同），
  // 按 rect 面积排序时 `sort` 会选中先出现的那条 —— 常常是滚出屏幕的预加载视频，
  // 于是过滤 / 清晰度 / 进度条 / 浮层全部作用在错误的对象上，表现为"时好时坏"。
  D.playingVideo = () => {
    const all = Array.from(document.querySelectorAll('video'));
    if (!all.length) return null;
    const playing = all.filter(v => !v.paused && v.readyState >= 2);
    const pool = playing.length ? playing : all.filter(v => D.visibleArea(v) > 40000);
    if (!pool.length) return null;
    pool.sort((a, b) => D.visibleArea(b) - D.visibleArea(a));
    const best = pool[0];
    // 在播的候选全部在屏幕外时（切标签 / 预加载），退回"所有可见视频里最大的那条"
    if (D.visibleArea(best) < 10000) {
      const visible = all.filter(v => D.visibleArea(v) > 40000);
      if (visible.length) {
        visible.sort((a, b) => D.visibleArea(b) - D.visibleArea(a));
        return visible[0];
      }
    }
    return best;
  };

  D.textOf = el => (el && el.textContent ? el.textContent.replace(/\s+/g, '').trim() : '');

  // ---------- 信息流视频 / 前台弹层视频 ----------
  // 抖音复用同一个 <video> 元素播放所有视频，但"信息流卡片里的视频"和
  // "聊天页 / 私信抽屉 / 好友分享弹层里的视频"必须区别对待：
  // 后者一旦被当成信息流视频，就会出现"点开好友视频，原来的推荐视频不暂停，
  // 反而被广告判定点到背后的下一条箭头"。
  D.FEED_CARD_SEL = '[data-e2e="feed-item"], [data-e2e="feed-active-video"], .slider-video';

  // 播放器根节点。真机（2026-10）上抖音详情页的播放器根是
  // 「xgpUb0ay basePlayerContainer ...」这类哈希类名，**不带 .xgplayer / .douyin-player**，
  // 只按旧选择器会退回到 <video> 的父节点，进度线/控制条的位置就不对了。
  D.PLAYER_SEL = '.xgplayer, .douyin-player, [class*="basePlayerContainer" i], [class*="playerContainer" i]';

  // 聊天页 / 私信抽屉 / 弹层容器。只用来判断"这条视频是不是压在信息流上面的前台播放器"，
  // 不参与隐藏逻辑（aside 里还有右侧面板，不能整类动）。
  D.CHAT_HOST_SEL = [
    'aside',
    '[role="dialog"]',
    '[data-e2e*="chat" i]',
    '[data-e2e*="message" i]',
    '[data-e2e*="conversation" i]',
    '[data-e2e*="session" i]',
    '[class*="chat" i]',
    '[class*="conversation" i]',
    '[class*="message" i]',
    '[class*="session" i]',
    '[class*="drawer" i]',
    '[class*="modal" i]'
  ].join(', ');

  // 视频在视口内的可见面积（滚出视口的旧视频算 0）
  D.visibleArea = v => {
    if (!v || !v.getBoundingClientRect) return 0;
    const r = v.getBoundingClientRect();
    const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    return (w > 0 && h > 0) ? w * h : 0;
  };

  // 是否在信息流卡片里（预加载的相邻视频也算，它们本来就在卡片里）
  D.inFeedCard = v => !!(v && v.closest && v.closest(D.FEED_CARD_SEL));

  // 背后是否还有信息流视频：只有存在信息流时，"暂停背后的推荐视频"才有意义
  D.hasFeedVideo = () => !!document.querySelector(
    '[data-e2e="feed-item"] video, [data-e2e="feed-active-video"] video, .slider-video video');

  // 聊天页 / 私信 / 好友分享弹层里的前台视频。
  // 判据刻意保守，宁可不生效也不能把信息流视频误判成前台弹层
  // （误判的后果是过滤、清晰度、浮层、进度条全部不工作）：
  //   ① 在信息流卡片里的一律不是；
  //   ② 明确的聊天 / 弹层容器里，且视频有实际尺寸 -> 是（聊天页里的小视频也算）；
  //   ③ 没有明确容器时，只有"背后确实还有信息流视频"+ 这条足够大（占屏幕 30% 以上）
  //      才认，避免鼠标划过右侧悬停预览就把信息流暂停。
  D.isOverlayVideo = v => {
    if (!v || !v.isConnected) return false;
    if (D.inFeedCard(v)) return false;
    const area = D.visibleArea(v);
    if (area < 120 * 90) return false;          // 小预览 / 缩略图一律不算
    const host = v.closest(D.CHAT_HOST_SEL);
    if (host) {
      // aside 也可能是右侧面板 / 悬停预览：要求够大才算前台
      if (host.tagName === 'ASIDE' && area < 280 * 200) return false;
      return true;
    }
    if (!D.hasFeedVideo()) return false;
    return area >= window.innerWidth * window.innerHeight * 0.3;
  };

  // 两个矩形是否相邻/相交（pad 为额外容差）
  D.near = (a, b, pad = 40) => !!a && !!b &&
    a.left < b.right + pad && a.right > b.left - pad &&
    a.top < b.bottom + pad && a.bottom > b.top - pad;
})();
