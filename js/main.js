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
  let lastVid = '';
  let lastAdCheck = 0;

  const srcOf = v => (v && (v.currentSrc || v.src)) || '';

  // ---------- 聊天页 / 私信 / 好友分享弹层：暂停背后的推荐流 ----------
  // 需求：在聊天页点开视频时，背后的推荐视频必须停下来，
  // 不能出现"聊天里正在看视频，背景的推荐视频还在播 / 还在出声"。
  // 这里只做一件事：前台弹层视频起播 -> 暂停信息流卡片里的视频。
  // 不参与过滤 / 清晰度 / 浮层 / 进度条，也不改信息流自己的播放逻辑。
  let overlayVideo = null;

  function pauseFeedFor(v) {
    let hit = 0;
    for (const other of document.querySelectorAll('video')) {
      if (other === v || other.paused || other.ended) continue;
      if (!D.inFeedCard(other)) continue;      // 只动信息流卡片里的视频
      try { other.pause(); hit++; } catch (e) { /* 忽略 */ }
    }
    if (hit) D.log('pause: 前台弹层视频起播，已暂停背后信息流', hit, '条');
    return hit > 0;
  }

  // 不挂在 dyc-feed 上：聊天页可能是独立路由（/messages 等），
  // 那时扩展的其余功能静默，但"暂停背后视频"仍然要生效。
  for (const type of ['play', 'playing']) {
    document.addEventListener(type, e => {
      const v = e.target;
      if (!(v instanceof HTMLVideoElement)) return;
      if (!D.isOverlayVideo(v)) return;
      overlayVideo = v;
      pauseFeedFor(v);
    }, true);
  }

  // 尽早挂上页面标记，避免左侧导航先闪一下再消失
  // 能力矩阵按当前路由算一次；dyc-player 是 CSS 开关（浮层 / 进度线 / 清晰度弹层），
  // dyc-feed 只作为"可切条"的语义标记，不再被视觉规则依赖
  D.route = D.routeOf(location.pathname, location.hostname);
  html.classList.toggle('dyc-feed', D.route.feed);
  html.classList.toggle('dyc-player', D.route.player);
  // 上一次的路由能力（feed|player）。只换参数（搜索页切 tab / 翻页）时能力不变，
  // 不必推倒重来，否则浮层与进度线会跟着闪一下。
  let capsAt = (D.route.feed ? '1' : '0') + (D.route.player ? '1' : '0');

  // ---------- 搜索页：点击视频 = 暂停/继续，不再跳进全屏弹层 ----------
  // 真机（2026-11）实测：www.douyin.com/search/<kw> 页顶部的内嵌播放器，
  // 结构是 video > .douyin-player > .basePlayerContainer > .slider-video > 卡片，
  // 默认点击视频画面会被卡片行为带到 ?modal_id=<id> 的全屏沉浸播放页。
  // 需求：这一下点击只切换暂停，不跳全屏。
  //
  // 放行判据（搜索页点击拦截的回归修复）：最初只排除了 `video-player-*`，评论图标
  // （`data-e2e="feed-comment-icon"`）没被排除，点评论也被拦成暂停，评论面板打不开。
  // 更麻烦的是真机点击命中的不是按钮本身，而是一层覆盖全卡片的 `positionBox`，
  // 所以按"点击目标是谁"判断并不可靠。
  // 现在改成按坐标：点击点在任一互动按钮的矩形内就放行（评论 / 点赞 / 收藏 / 分享 /
  // 更多 / 头像 / 关注 / 控制条），只有真正落在画面空白处才当暂停区。
  const PASS_SEL = 'button, a, input, textarea, select, label, [role="button"], [contenteditable="true"]';
  const BTN_SEL = [
    '.douyin-player-controls',
    '[data-e2e="feed-comment-icon"]',
    '[data-e2e*="video-player-"]',
    '[data-e2e="video-play-more"]',
    '[data-e2e*="avatar"]',
    '[data-e2e*="follow"]'
  ].join(', ');

  function hitButton(card, x, y) {
    let n = 0;
    for (const el of card.querySelectorAll(BTN_SEL)) {
      if (++n > 12) break;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 6 && y <= r.bottom + 6) return true;
    }
    return false;
  }

  // ---------- 屏蔽双击点赞 ----------
  // 抖音网页版双击视频画面会点赞（飘心 + 点赞数 +1）。在捕获阶段吃掉
  // 第二次 click（detail >= 2）与 dblclick，控件区域照常放行。
  // 必须注册在搜索页「点击暂停」监听之前：否则搜索页双击会先被暂停逻辑吃掉一次，
  // 表现为"暂停一下又立刻播回去"。
  function blockDoubleLike(e) {
    if (D.settings && D.settings.noDoubleLike === false) return;
    if (!D.route.player) return;
    if (e.type === 'click' && e.detail < 2) return;
    const t = e.target;
    if (!t || t.nodeType !== 1 || !t.closest) return;
    if (t.closest(PASS_SEL)) return;
    if (t.closest('.douyin-player-controls, [class*="player-controls"]')) return;
    if (!t.closest('.slider-video, [data-e2e="feed-active-video"], [data-e2e="feed-item"], .douyin-player')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  document.addEventListener('click', blockDoubleLike, true);
  document.addEventListener('dblclick', blockDoubleLike, true);

  document.addEventListener('click', e => {
    if (D.route.page !== 'search') return;
    const t = e.target;
    if (!t || t.nodeType !== 1) return;
    const card = t.closest('.slider-video');
    if (!card) return;
    // 键盘触发的 click（Enter / 空格）没有坐标，一律不干预
    if (!e.detail && e.clientX === 0 && e.clientY === 0) return;
    if (t.closest(PASS_SEL)) return;
    if (t.closest('.douyin-player-controls, [class*="player-controls"]')) return;
    if (hitButton(card, e.clientX, e.clientY)) return;
    const v = card.querySelector('video');
    if (!v) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!v.paused) {
      try { v.pause(); } catch (err) { /* 忽略 */ }
      return;
    }
    // 暂停态下继续播放：play() 是异步的，失败时只记日志，不影响后续操作
    const p = v.play();
    if (p && p.catch) p.catch(() => { /* 被播放器策略拒绝时忽略 */ });
  }, true);

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
    lastVid = '';
  }

  function boot() {
    clearTimeout(bootTimer);
    if (!D.route.feed) {
      // 非信息流页面：不切条、不过滤，但播放器相关的（清晰度 / 进度线 / 浮层）仍要工作
      D.nav.apply();
      D.header.apply();
      if (D.live) D.live.apply();
      if (D.route.player) {
        const pv = D.playingVideo();
        if (pv && !D.isOverlayVideo(pv)) {
          lastVideo = pv;
          D.overlay.sync(pv);
          D.progress.attach(pv);
          D.quality.schedule(pv);
        }
        return;
      }
      teardown();
      return;
    }
    D.nav.apply();
    D.header.apply();
    const v = D.playingVideo();
    if (v && !D.isOverlayVideo(v)) {
      lastVideo = v;
      D.overlay.sync(v);
      D.progress.attach(v);
    } else if (v) {
      overlayVideo = v;
      pauseFeedFor(v);
    }
    retries = 0;
  }

  function onRoute() {
    if (location.href === href) return;
    href = location.href;
    const next = D.routeOf(location.pathname, location.hostname);
    D.route = next;
    const caps = (next.feed ? '1' : '0') + (next.player ? '1' : '0');
    if (caps === capsAt) {
      // 能力没变（比如直播站首页 → 直播间）：导航/顶栏不用重来，
      // 但直播间的精简是按当前结构算的，仍要重算一次。
      if (D.live) D.live.apply();
      return;
    }
    capsAt = caps;
    html.classList.toggle('dyc-feed', next.feed);
    html.classList.toggle('dyc-player', next.player);
    retries = 0;
    lastVideo = null;
    if (!next.feed) {
      teardown();
      D.nav.apply();
      D.header.apply();
      if (D.live) D.live.apply();
      // 详情 / 影院 / 短剧 / 合集：只跑播放器相关能力
      if (D.route.player) bootTimer = setTimeout(boot, 350);
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
  // 优先级是「视频 ID > 卡片文案指纹 + 卡片元素 + 封面旁证」，都认不出时才
  // 退回"隔 6 秒算一条"的时间判定。
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

  // 视频 ID：真机实测（2026-10）信息流卡片上带 data-e2e-vid，就是 aweme_id，
  // 例如 <div data-e2e="feed-active-video" data-e2e-vid="7702750408389720050">。
  // 这是比文案更强的身份：虚拟列表复用卡片、同文案转载都不会影响它。
  // 所以有 ID 时以 ID 为准，没有再退回"文案 + 卡片 + 封面"的旁证。
  function videoIdOf(card) {
    if (!card) return '';
    const own = card.getAttribute ? (card.getAttribute('data-e2e-vid') || '') : '';
    if (own) return own;
    const el = card.querySelector ? card.querySelector('[data-e2e-vid]') : null;
    if (el) {
      const v = el.getAttribute('data-e2e-vid') || '';
      if (v) return v;
    }
    // 兜底：详情页 / 少数卡片没有 data-e2e-vid 时，从链接的 /video/<id> 或 aweme_id 取
    const a = card.querySelector ? card.querySelector('a[href*="/video/"], a[href*="aweme_id="]') : null;
    if (!a) return '';
    const href = a.getAttribute('href') || '';
    const m = /\/video\/(\d{8,})/.exec(href) || /aweme_id=(\d{8,})/.exec(href);
    return m ? m[1] : '';
  }

  function bumpGen(v) {
    // 预加载的相邻视频一律不算（它们处于暂停状态）
    if (v.paused) return;
    const now = Date.now();
    const sig = videoSig(v);
    const card = cardOfVideo(v);
    const poster = v.poster || '';
    const vid = videoIdOf(card);

    // ① 有视频 ID：直接以 ID 为身份，同一 ID 无论换清晰度 / 循环都算同一条
    if (vid) {
      if (vid === lastVid) return;
      lastVid = vid;
      lastSig = sig;
      lastCard = card;
      if (poster) lastPoster = poster;
      D.gen++;
      lastGenAt = now;
      return;
    }

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
    // 聊天页 / 私信抽屉 / 好友分享弹层里的视频：只负责暂停背后的信息流。
    // 以前会把它当成"换了一条信息流视频"，广告判定随后点到背后的「下一条」箭头，
    // 表现为"点开好友视频，原来的视频不暂停，反而滑到下一条"。
    if (D.isOverlayVideo(v)) {
      overlayVideo = v;
      if (!v.paused) pauseFeedFor(v);
      return;
    }
    bumpGen(v);
    lastVideo = v;
    lastSrc = srcOf(v);
    D.overlay.sync(v);
    D.progress.attach(v);
    if (D.route.feed) D.filter.checkAd(v);   // 只有信息流页面才做过滤 / 切条
    D.quality.schedule(v);
  }

  document.addEventListener('loadedmetadata', e => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || !D.route.player) return;
    onNewVideo(v);
  }, true);

  document.addEventListener('playing', e => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || !D.route.player) return;
    onNewVideo(v);
  }, true);

  // 暂停后补标游戏卡片：抖音的推广卡常在暂停后才渲染，而暂停时 <video> 的矩形是 0，
  // 换片标记与 12 秒补标窗口都覆盖不到。这里在暂停后 0.4s / 1.5s 各补一次。
  document.addEventListener('pause', e => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || !D.route.player) return;
    if (!D.overlay || !D.overlay.hideGameNow) return;
    setTimeout(() => { if (D.overlay) D.overlay.hideGameNow(); }, 400);
    setTimeout(() => { if (D.overlay) D.overlay.hideGameNow(); }, 1500);
  }, true);

  // 换片/换清晰度前 src 会被清空（emptied），此时先排一次清晰度判断
  document.addEventListener('emptied', e => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || !D.route.player) return;
    if (D.isOverlayVideo(v)) return;            // 聊天 / 弹层播放器不归信息流逻辑管
    if (v !== lastVideo && v !== D.playingVideo()) return;
    D.quality.schedule(v);
  }, true);

  // 身份比对看门狗：兜住事件漏掉的少数情况。
  // 注意不能用 src 当身份：抖音是 MSE 流，换清晰度/换流时 src 会自己变（甚至清空），
  // 拿它比对会每隔 2 秒就误判成"换了一条视频"，把清晰度那一轮的排队任务反复作废。
  // 所以这里只比 video 引用和卡片文案指纹（和代次判定用同一把尺子）。
  setInterval(() => {
    if (document.hidden) return;
    // 路由兜底：抖音的搜索框回车、部分站内跳转走的是 history.pushState，
    // 既没有 popstate 也没有 click，onRoute 会漏掉，结果"进了搜索页还在按首页的能力跑"
    // （表现为该页浮层 / 进度线不生效，或者反过来把搜索页当信息流去切条）。
    // 每 2 秒比一次 href 只是字符串比较，开销可以忽略。
    if (location.href !== href) onRoute();
    // 聊天页 / 弹层视频还在播时，背后的信息流要保持暂停：
    // 抖音的自动播放会在切回页面时把推荐视频重新拉起来，这里每 2 秒复核一次。
    if (overlayVideo) {
      if (!overlayVideo.isConnected || overlayVideo.paused || overlayVideo.ended) overlayVideo = null;
      else pauseFeedFor(overlayVideo);
    }
    // 导航 / 顶栏精简全站生效：页面重建后要能自愈（否则"换个页面又全冒出来"）
    if (D.nav && D.nav.verify) D.nav.verify();
    if (D.header && D.header.verify) D.header.verify();
    if (D.live && D.live.verify) D.live.verify();
    if (!D.route.player) return;
    const v = D.playingVideo();
    if (v && !D.isOverlayVideo(v)) {
      const sig = v.paused ? '' : videoSig(v);
      if (v !== lastVideo || (sig && sig !== lastSig)) onNewVideo(v);
      // 播放器重渲染 / 暂停期间可能把自绘进度条清掉；这里只做幂等补挂，没有就重建
      if (D.progress) D.progress.sync(v);
    }
    // 游戏卡片 / 推荐卡片经常比视频晚一步渲染：换片时标一次会漏，这里有限次补标
    if (D.overlay && D.overlay.tick) D.overlay.tick();
    // 暂停态下不会有 loadedmetadata / playing 事件，过滤没有触发点：
    // 每 6 秒补判一次，保证"暂停画面上的广告"也能被发现（强信号命中会直接切）。
    if (D.route.feed && v && v.paused) {
      const now = Date.now();
      if (now - lastAdCheck > 6000) {
        lastAdCheck = now;
        D.filter.checkAd(v);
      }
    }
    // 命中广告时视频可能处于暂停：恢复播放后由这里补跳（见 filter.js 的 pendingSkip）
    if (D.filter && D.filter.retryPending) D.filter.retryPending();
    D.filter.closePopups(v);        // 顺手关掉头像旁的直播/推广小窗
  }, 2000);

  // ---------- 失焦自动暂停（不自动恢复） ----------
  // 搜索页（含推荐页搜索的 /root/search）以前整页没有播放器能力，
  // pauseActive 第一行就 return，失焦了照播。路由修好后这里再补两点：
  //   ① 不再用 document.hasFocus() 复核 —— blur 事件本身就是"窗口已失焦"的证据，
  //      而 hasFocus 在 blur 回调里偶尔还是 true，会把这次暂停吞掉；
  //   ② 暂停所有"在画面里还在播"的视频，而不是只暂停 D.playingVideo() 挑出来的那一条。
  //      搜索页常有多张卡片同时挂着视频，只暂停一条看起来就像"没生效"。
  let pausedByBlurAt = 0;
  // 图文：抖音把轮播挂在一个 0×0 的 <video> 上（图片按它的 currentTime 切换），
  // 这种视频可见面积是 0，上面的规则会跳过，所以之前切到后台图片仍在自动翻页。
  // 这里只处理"卡片里没有可见视频、但有大幅图片"的活动卡片。
  function pauseGallery() {
    const card = document.querySelector('[data-e2e="feed-active-video"]');
    if (!card) return 0;
    const videos = Array.from(card.querySelectorAll('video'));
    if (!videos.length) return 0;
    if (videos.some(v => D.visibleArea(v) >= 40000)) return 0;   // 普通视频，交给上面的规则
    const hasBigPic = Array.from(card.querySelectorAll('img')).some(img => {
      const r = img.getBoundingClientRect();
      return r.width >= 300 && r.height >= 300;
    });
    if (!hasBigPic) return 0;
    let n = 0;
    for (const v of videos) {
      if (v.paused || v.ended) continue;
      try { v.pause(); n++; } catch (e) { /* 忽略 */ }
    }
    return n;
  }

  function pauseActive() {
    if (!D.route.player) return;
    if (!D.settings || D.settings.pause === false) return;
    let hit = 0;
    for (const v of document.querySelectorAll('video')) {
      if (v.paused || v.ended) continue;
      if (D.visibleArea(v) < 40000) continue;      // 只暂停真正显示在画面上的
      try { v.pause(); hit++; } catch (e) { /* 忽略 */ }
    }
    hit += pauseGallery();
    if (hit) {
      pausedByBlurAt = Date.now();
      D.log('pause: 页面失去焦点，已自动暂停', hit, '条');
      // 调试探针（同 data-dyc-nav-state / data-dyc-judge 的用法）：
      // 外部不用进隔离世界就能确认"这一次失焦暂停到底执行了没有"。
      try { document.documentElement.setAttribute('data-dyc-pause', String(pausedByBlurAt)); } catch (e) { /* 忽略 */ }
    }
  }
  window.addEventListener('blur', pauseActive);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseActive();
  });
  // 失焦暂停后 3 秒内视频又自己播起来：说明是播放器自己续播的（不是用户点的），
  // 记一笔探针，用来区分"暂停没生效"和"暂停了又被自动恢复"。
  document.addEventListener('play', e => {
    if (!(e.target instanceof HTMLVideoElement)) return;
    if (!pausedByBlurAt || Date.now() - pausedByBlurAt > 3000) return;
    try { document.documentElement.setAttribute('data-dyc-replay', String(Date.now())); } catch (err) { /* 忽略 */ }
  }, true);

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
      顶栏隐藏项: document.querySelectorAll('[data-dyc-hide]').length,
      自检: D.health || null,
      代次: D.gen
    };
    console.log('[抖音净播] 状态', info);
    // 一键把诊断 JSON 复制到剪贴板（失败时退回控制台查看 __DYC.diag()）
    if (D.diag) {
      try {
        const json = JSON.stringify(D.diag(), null, 2);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(json)
            .then(() => console.log('[抖音净播] 诊断已复制到剪贴板，可直接粘贴反馈'))
            .catch(() => console.log('[抖音净播] 诊断\n' + json));
        } else {
          console.log('[抖音净播] 诊断\n' + json);
        }
      } catch (err) { /* 忽略 */ }
    }
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
