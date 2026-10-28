/* 视频底部进度细线
 *
 * 位置：把一条 3px 细线挂进播放器根节点（.xgplayer / .douyin-player），absolute 贴底。
 * 播放器缩放、开评论区、全屏时都会跟着走，不需要读几何、不需要跟随 resize。
 *
 * 进度更新只有两个来源，都不轮询：
 *   1) requestAnimationFrame —— 播放期间每帧回调一次，直接读 video.currentTime。
 *      currentTime 已经是"媒体时间"，倍速播放 / 拖动快进时它会跟着变，
 *      线条因此天然跟随倍速与 seek，不需要额外换算；
 *   2) 媒体事件（timeupdate / seeking / seeked / ratechange …）—— 兜底与即时刷新。
 * 每次只写 fill 的 transform: scaleX()（合成层动画，不触发重排），并按万分之一取整去重，
 * 暂停 / 卡顿时不会空写。颜色通过根节点上的 --dyc-progress-color 变量下发。
 *
 * 关键：线条必须跟着"当前屏幕上这张卡片"的视频，而不是任何一条仍在后台播放的旧视频。
 * 抖音切换视频时偶尔会留下上一条继续播放，若线条挂在它身上，表现就是
 * "画面已经切走了，线条还按上一套时间在走" —— 也就是看起来永远匀速。
 *
 * 直播 / duration 未知（MSE 流）时整条隐藏：这类视频没有可用的播放进度。
 */
(() => {
  const D = window.__DYC;
  if (!D) return;

  const html = document.documentElement;
  const ON_CLASS = 'dyc-progress-on';
  const ATTR_UNKNOWN = 'data-dyc-unknown';

  let bar = null;
  let fill = null;
  let host = null;
  let video = null;
  let rafId = 0;
  let lastPct = -1;
  let unknown = null;       // null=尚未判定；true/false=当前线条是否因时长未知而隐藏
  let effDur = NaN;         // 有效时长（duration 不是有限值时的兜底）
  let effAt = 0;            // 兜底时长的取样时刻，最多每秒读一次布局
  let idAt = 0;             // 跟随当前活动视频的检查时刻

  const enabled = () => !D.settings || D.settings.progress !== false;

  function colorOf() {
    const c = D.settings && D.settings.progressColor;
    return /^#[0-9a-f]{6}$/i.test(c || '') ? c : '#fe2c55';
  }

  // 只在设置变化时写一次，播放过程中不再碰样式表
  function paintColor() {
    html.style.setProperty('--dyc-progress-color', colorOf());
  }

  function stopLoop() {
    if (!rafId) return;
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function loop() {
    rafId = 0;
    if (!bar || !video || !enabled()) return;
    paint();
    followActive();
    // followActive 重新挂载时会自己 startLoop，这里不能重复排帧
    if (!rafId && !video.paused && !video.ended) rafId = requestAnimationFrame(loop);
  }

  function startLoop() {
    // 暂停时不排帧没有意义，但 seek 常常发生在暂停状态：
    // 这里允许排一帧，loop 自己会在"已暂停"时结束，不会空转。
    if (rafId || !bar || !video) return;
    rafId = requestAnimationFrame(loop);
  }

  function setUnknown(flag) {
    if (unknown === flag) return;
    unknown = flag;
    if (!bar) return;
    if (flag) bar.setAttribute(ATTR_UNKNOWN, '');
    else bar.removeAttribute(ATTR_UNKNOWN);
  }

  function paint(force) {
    if (!bar || !video) return;
    const d = durationOf(video);
    if (!isFinite(d) || d <= 0) {
      setUnknown(true);
      return;
    }
    setUnknown(false);
    const t = video.ended ? d : video.currentTime;
    const ratio = Math.max(0, Math.min(1, t / d));
    // 万分之一：1000px 宽的线条上约 0.1px，肉眼看不出量化，却能挡掉大量重复写入
    const pct = Math.round(ratio * 10000) / 10000;
    if (!force && pct === lastPct) return;
    lastPct = pct;
    fill.style.transform = 'scaleX(' + pct + ')';
  }

  // 活动卡片里的视频（真正贴在屏幕上的那张卡片）
  function activeCardVideo() {
    const active = document.querySelector('[data-e2e="feed-active-video"]');
    const v = active && active.querySelector('video');
    if (!v) return null;
    const r = v.getBoundingClientRect();
    // 必须与视口相交：换片瞬间 feed-active-video 可能还指着上一张卡片，
    // 只判断宽高非 0 会把已经滚出屏幕的旧视频当成活动视频。
    return (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight) ? v : null;
  }

  // 抖音切换视频时上一条有时还在播（还会出声）；线条只认活动卡片 / 屏幕上那条，
  // 否则会挂在后台旧视频上按旧时间走，看起来就是"永远 1 倍速"。
  // 优先级：事件里刚动过的那条（确实在视口内就是它）→ 活动卡片 → 屏幕在播 → 兜底。
  function onScreen(v) {
    if (!v || !v.isConnected) return false;
    const r = v.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
  }

  function visibleVideo(v) {
    // 私信 / 好友分享弹层里的视频不挂进度线：只认信息流里的播放器
    if (v && D.inFeed(v) && onScreen(v)) return v;
    const a = activeCardVideo();
    if (a) return a;
    const on = D.onScreenVideo ? D.onScreenVideo() : null;
    if (on && D.inFeed(on)) return on;
    const playing = D.playingVideo();
    return (playing && D.inFeed(playing)) ? playing : null;
  }

  // 逐帧顺带做一次"我是不是跟错视频了"的纠正（每秒最多一次，代价可忽略）
  function followActive() {
    const now = performance.now();
    if (now - idAt < 1000) return;
    idAt = now;
    const a = activeCardVideo();
    if (!a || a === video || !a.isConnected) return;
    // 暂停中的卡片视频不抢：用户可能就是停在它身上，此时旧视频仍在播也不该把线条带走
    if (a.paused && !video.paused) return;
    if (!ensure(a)) return;
    paint(true);
    startLoop();
  }

  // 抖音很多 MSE 流的 video.duration 是 Infinity / NaN；这时用 seekable 区间
  // 或播放器时间显示里的总时长兜底，否则这些视频的进度条会一直消失
  // （表现就是"有时候有、有时候没有"）。直播返回 NaN，整条隐藏。
  function fallbackDuration(v) {
    const h = v.closest('.xgplayer, .douyin-player') || v.parentElement;
    if (!h) return NaN;

    // 直播：控制条里的 .time-live-tag 会从 display:none 变成显示
    const liveTag = h.querySelector('.time-live-tag');
    if (liveTag) {
      const cs = getComputedStyle(liveTag);
      if (cs.display !== 'none' && cs.visibility !== 'hidden' &&
          liveTag.getBoundingClientRect().width > 0) return NaN;
    }

    let best = NaN;

    // 播放器自己的总时长文案最接近真实时长（seekable 可能只到已缓冲位置）
    const el = h.querySelector('.time-duration');
    const text = el ? el.textContent.replace(/\s+/g, '').trim() : '';
    if (text) {
      const parts = text.split(':').map(Number);
      if (parts.length >= 2 && parts.length <= 3 && parts.every(n => isFinite(n))) {
        best = parts.length === 3
          ? parts[0] * 3600 + parts[1] * 60 + parts[2]
          : parts[0] * 60 + parts[1];
      }
    }

    // MSE 点播常见：duration 为 Infinity，但 seekable 末端就是真实时长
    const s = v.seekable;
    if (s && s.length) {
      const end = s.end(s.length - 1);
      if (isFinite(end) && end > 0) best = isFinite(best) ? Math.max(best, end) : end;
    }
    return best;
  }

  // 正常视频直接用 video.duration，不读布局；只有时长不是有限值时才走兜底，
  // 并且最多每秒取样一次，避免逐帧查询 DOM。兜底值按最大值累积，
  // 防止 seekable 只覆盖已缓冲区间时把进度算得忽快忽慢。
  function durationOf(v) {
    const d = v.duration;
    if (isFinite(d) && d > 0 && d < 86400) return d;
    const now = performance.now();
    if (now - effAt < 1000) return effDur;
    effAt = now;
    const fb = fallbackDuration(v);
    if (!isFinite(fb) || fb <= 0) return effDur;
    effDur = (isFinite(effDur) && effDur > 0) ? Math.max(effDur, fb) : fb;
    return effDur;
  }

  // 播放器重渲染（开评论、切布局）会把我们的节点一起清掉：重新挂到新宿主上
  function ensure(v) {
    const nextHost = v.closest('.xgplayer, .douyin-player') || v.parentElement;
    if (!nextHost) return false;
    if (video === v && host === nextHost && bar && bar.isConnected) return true;

    stopLoop();
    if (bar) bar.remove();
    video = v;
    host = nextHost;
    unknown = null;
    lastPct = -1;
    effDur = NaN;
    effAt = 0;
    idAt = 0;

    bar = document.createElement('div');
    bar.className = 'dyc-progress';
    bar.setAttribute('data-dyc-progress', '');
    bar.setAttribute('aria-hidden', 'true');
    fill = document.createElement('div');
    fill.className = 'dyc-progress-fill';
    fill.style.transform = 'scaleX(0)';
    bar.appendChild(fill);
    host.appendChild(bar);
    return true;
  }

  function detach() {
    stopLoop();
    video = null;
    host = null;
    lastPct = -1;
    unknown = null;
    effDur = NaN;
    effAt = 0;
    idAt = 0;
    if (bar) bar.remove();
    bar = null;
    fill = null;
  }

  function attach(v) {
    if (!enabled() || !html.classList.contains('dyc-feed')) {
      detach();
      return;
    }
    // 不依赖 settings 的异步回调：storage 不可用 / 回调早于本模块加载时，
    // 这里补一次开关类，保证第一次挂载就有样式。
    if (!html.classList.contains(ON_CLASS)) html.classList.add(ON_CLASS);
    // 同理补颜色变量；值相同就跳过，避免每次换片都让整页样式失效。
    if (html.style.getPropertyValue('--dyc-progress-color') !== colorOf()) paintColor();
    const target = visibleVideo(v);
    if (!target) return;
    if (!ensure(target)) return;
    paint(true);
    startLoop();
  }

  const MEDIA_EVENTS = [
    'timeupdate', 'durationchange', 'loadedmetadata', 'loadeddata',
    'play', 'playing', 'pause', 'seeking', 'seeked', 'ended',
    'ratechange', 'emptied', 'waiting'
  ];

  for (const type of MEDIA_EVENTS) {
    document.addEventListener(type, e => {
      const v = e.target;
      if (!(v instanceof HTMLVideoElement)) return;
      if (!enabled() || !html.classList.contains('dyc-feed')) return;

      if (v !== video) {
        // 预加载 / 残留的邻接视频一律不接管：只有"当前屏幕上这张卡片"的那条才配挂线条
        if (visibleVideo(v) !== v) return;
        if (!ensure(v)) return;
        paint(true);
        startLoop();
        return;
      }

      if (type === 'durationchange' || type === 'loadedmetadata' || type === 'emptied') {
        effDur = NaN;
        effAt = 0;
      }

      if (!bar || !bar.isConnected) {
        // 宿主被播放器重渲染了：重新挂上并补一帧
        if (!ensure(v)) return;
        paint(true);
        startLoop();
        return;
      }

      paint();
      if (type === 'play' || type === 'playing' || type === 'seeked' ||
          type === 'seeking' || type === 'ratechange' || type === 'timeupdate') {
        startLoop();
      }
    }, true);
  }

  D.progress = {
    attach,
    // 幂等补挂：只在"视频/宿主/节点"真的变了或被播放器清掉时才重建。
    // 给 main.js 的 2 秒看门狗和 overlay 的显示切换用，暂停时也能把线条补回来。
    sync(v) {
      if (!enabled() || !html.classList.contains('dyc-feed')) return;
      const target = visibleVideo(v);
      if (!target) return;
      // 先补开关类和颜色，防止设置回调/重渲染把样式丢了却被下面的幂等判断直接放行
      if (!html.classList.contains(ON_CLASS)) html.classList.add(ON_CLASS);
      if (html.style.getPropertyValue('--dyc-progress-color') !== colorOf()) paintColor();
      const nextHost = target.closest('.xgplayer, .douyin-player') || target.parentElement;
      if (video === target && host === nextHost && bar && bar.isConnected) {
        paint(true);
        startLoop();
        return;
      }
      // 这里不用 attach()：暂停时 attach 会退回 D.playingVideo()，可能挂到别的预加载卡片上；
      // 看门狗 / 显示切换传进来的就是当前视频，直接挂它。
      if (!ensure(target)) return;
      paint(true);
      startLoop();
    },
    applySettings() {
      paintColor();
      const on = enabled() && html.classList.contains('dyc-feed');
      html.classList.toggle(ON_CLASS, on);
      if (!on) {
        detach();
        return;
      }
      attach(video || D.playingVideo());
    },
    probe() {
      const d = video ? video.duration : NaN;
      return {
        启用: enabled(),
        线条: !!(bar && bar.isConnected),
        时长: isFinite(d) ? Math.round(d * 10) / 10 : null,
        倍速: video ? video.playbackRate : null,
        进度: (video && isFinite(d) && d > 0)
          ? Math.round(video.currentTime / d * 1000) / 10 + '%'
          : null
      };
    },
    reset() {
      detach();
      html.classList.remove(ON_CLASS);
    }
  };
})();
