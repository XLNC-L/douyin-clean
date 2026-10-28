/* 视频底部进度细线
 *
 * 位置：把一条 3px 细线挂进播放器根节点（.xgplayer / .douyin-player），absolute 贴底。
 * 播放器缩放、开评论区、全屏时都会跟着走，不需要读几何、不需要跟随 resize。
 *
 * 性能：进度更新只有两个来源，都不轮询：
 *   1) requestVideoFrameCallback —— 每呈现一帧回调一次，画面如何走线条就如何走；
 *   2) timeupdate（约 4Hz）—— 兜底，配 CSS 线性过渡补齐中间帧。
 * 每次只写 fill 的 transform: scaleX()（合成层动画，不触发重排），并按万分之一取整去重，
 * 暂停 / 卡顿时不会空写。颜色通过根节点上的 --dyc-progress-color 变量下发，
 * 开关与换色各写一次样式，播放过程中不读也不写样式表。
 *
 * 三个容易翻车的点（v1.9.11 重做）：
 *   · 播完"从头播放"不稳定：抖音可能是 loop 属性，也可能是 JS 里 seek 回 0，
 *     后者不保证触发 play / seeking；rVFC 在 ended 状态下也不会再回调。
 *     所以 ended 之后补三次兜底重画，并在 currentTime 变小时强制重画；
 *   · 逐帧回调会"丢"：rVFC 在暂停 / 播完 / 页面不可见时不回调，frameCb 一旦占住就再也排不上，
 *     线条只剩 4Hz 的 timeupdate。这里用轮次号 + 700ms 超时自愈；
 *   · 快进快退 / 跳转：seek 期间视频常常是暂停的，rVFC 不回调，
 *     所以 seeking 时用 rAF 补 1.2 秒，seeked 后再强制对齐一次。
 *
 * 直播 / duration 未知（MSE 流）时整条隐藏：这类视频没有可用的播放进度。
 */
(() => {
  const D = window.__DYC;
  if (!D) return;

  const html = document.documentElement;
  const ON_CLASS = 'dyc-progress-on';
  const ATTR_UNKNOWN = 'data-dyc-unknown';
  const ATTR_SMOOTH = 'data-dyc-smooth';

  // 支持逐帧回调时不要 CSS 过渡，否则线条会永远慢半拍；
  // 只有退回 timeupdate 时才用过渡把 4Hz 的跳动补顺。
  const hasRVFC = typeof HTMLVideoElement !== 'undefined' &&
    typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function';

  let bar = null;
  let fill = null;
  let host = null;
  let video = null;
  let frameCb = 0;
  let frameSeq = 0;         // 逐帧回调的轮次：迟到的旧回调靠它作废
  let frameAt = 0;          // 上次排帧的时刻：用来识别"回调再也不会来"
  let lastPct = -1;
  let lastTime = -1;        // 上次画线时的 currentTime：用来发现"回到开头 / 往回拖"
  let seekRaf = 0;          // 拖动进度条期间的补帧
  let endedTimers = [];     // 播放结束后的兜底重画
  let unknown = null;       // null=尚未判定；true/false=当前线条是否因时长未知而隐藏
  let effDur = NaN;         // 有效时长（duration 不是有限值时的兜底）
  let effAt = 0;            // 兜底时长的取样时刻，最多每秒读一次布局

  const enabled = () => !D.settings || D.settings.progress !== false;

  function colorOf() {
    const c = D.settings && D.settings.progressColor;
    return /^#[0-9a-f]{6}$/i.test(c || '') ? c : '#fe2c55';
  }

  // 只在设置变化时写一次，播放过程中不再碰样式表
  function paintColor() {
    html.style.setProperty('--dyc-progress-color', colorOf());
  }

  function cancelFrame() {
    frameSeq++;                 // 让还没回来的旧回调作废
    if (!frameCb) return;
    const v = video;
    if (v && typeof v.cancelVideoFrameCallback === 'function') {
      try { v.cancelVideoFrameCallback(frameCb); } catch (e) { /* 忽略 */ }
    }
    frameCb = 0;
  }

  function stopSeekBurst() {
    if (!seekRaf) return;
    cancelAnimationFrame(seekRaf);
    seekRaf = 0;
  }

  function clearEnded() {
    endedTimers.forEach(clearTimeout);
    endedTimers = [];
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
    const cur = video.ended ? d : video.currentTime;
    // 循环播放 / 拖回开头：currentTime 明显变小，说明已经重新开始或往回跳了。
    // 这里必须强制重画，否则线条会一直停在 100% 等下一帧 ——
    // 表现就是"播完之后有时会从头走、有时不会"。
    const back = lastTime >= 0 && cur + 0.35 < lastTime;
    lastTime = cur;
    const ratio = Math.max(0, Math.min(1, cur / d));
    // 万分之一：1000px 宽的线条上约 0.1px，肉眼看不出量化，却能挡掉大量重复写入
    const pct = Math.round(ratio * 10000) / 10000;
    if (!force && !back && pct === lastPct) return;
    lastPct = pct;
    fill.style.transform = 'scaleX(' + pct + ')';
    if (back && !video.paused) schedule();     // 回到开头后确保逐帧回调还在跑
  }

  // 抖音很多 MSE 流的 video.duration 是 Infinity / NaN；这时用 seekable 区间
  // 或播放器时间显示里的总时长兜底，否则这些视频的进度条会一直消失
  // （表现就是"有时候有、有时候没有"）。直播返回 NaN，整条隐藏。
  function fallbackDuration(v) {
    const host = v.closest('.xgplayer, .douyin-player') || v.parentElement;
    if (!host) return NaN;

    // 直播：控制条里的 .time-live-tag 会从 display:none 变成显示
    const liveTag = host.querySelector('.time-live-tag');
    if (liveTag) {
      const cs = getComputedStyle(liveTag);
      if (cs.display !== 'none' && cs.visibility !== 'hidden' &&
          liveTag.getBoundingClientRect().width > 0) return NaN;
    }

    // MSE 点播常见：duration 为 Infinity，但 seekable 末端就是真实时长
    const s = v.seekable;
    if (s && s.length) {
      const end = s.end(s.length - 1);
      if (isFinite(end) && end > 0) return end;
    }

    // 最后再读一次播放器自己的总时长文案（mm:ss / hh:mm:ss）
    const el = host.querySelector('.time-duration');
    const text = el ? el.textContent.replace(/\s+/g, '').trim() : '';
    if (!text) return NaN;
    const parts = text.split(':').map(Number);
    if (parts.length < 2 || parts.some(n => !isFinite(n))) return NaN;
    return parts.length === 3
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : parts[0] * 60 + parts[1];
  }

  // 正常视频直接用 video.duration，不读布局；只有时长不是有限值时才走兜底，
  // 并且最多每秒取样一次，避免逐帧查询 DOM。
  function durationOf(v) {
    const d = v.duration;
    if (isFinite(d) && d > 0) return d;
    const now = performance.now();
    if (now - effAt < 1000) return effDur;
    effAt = now;
    effDur = fallbackDuration(v);
    return effDur;
  }

  function schedule() {
    if (frameCb || !bar || !video || !hasRVFC || !enabled()) return;
    const v = video;
    // 不能因为 ended 就不排帧：抖音播完是"直接 seek 回 0 继续播"，
    // 这一下不一定触发 play / seeking，只有逐帧回调能把线条拉回开头。
    if (v.paused) return;
    const seq = ++frameSeq;
    frameAt = performance.now();
    frameCb = v.requestVideoFrameCallback(() => {
      if (seq !== frameSeq) return;        // 已经被新一轮接管，忽略迟到的回调
      frameCb = 0;
      if (video !== v || !bar || !bar.isConnected) return;
      paint();
      schedule();
    });
  }

  // rVFC 在暂停 / 播完 / 页面不可见时不会回调，frameCb 会一直占着，
  // 之后即使继续播也排不上帧 —— 线条只剩 4Hz 的 timeupdate，
  // 看起来就是"有时跟得上、有时卡住"。这里做一次廉价自愈。
  function ensureFrames() {
    if (!frameCb || !bar || !video) return;
    if (performance.now() - frameAt < 700) return;
    frameSeq++;                            // 作废迟到的旧回调
    frameCb = 0;
    schedule();
  }

  // 拖动 / 点击原生进度条（快进快退、跳转）时逐帧跟随。
  // seek 期间视频常常是暂停的，rVFC 不会回调，所以这里用 rAF 补 1.2 秒。
  function seekBurst() {
    if (seekRaf || !bar || !video || !enabled()) return;
    const now = performance.now();
    const until = now + 1200;        // 正常补 1.2 秒
    const hardStop = now + 3000;     // 拖住不放时最多补 3 秒，避免无限 rAF
    const step = () => {
      seekRaf = 0;
      if (!bar || !video || !enabled()) return;
      paint(true);
      const t = performance.now();
      if (t < until || (video.seeking && t < hardStop)) seekRaf = requestAnimationFrame(step);
    };
    seekRaf = requestAnimationFrame(step);
  }

  // 播完这一条：先画满，再补几次兜底重画。
  // 抖音"从头播放"可能是 loop 属性、也可能是 JS 里 seek 回 0，
  // 后者不保证触发 play / seeking，只靠事件会漏，所以这里定时复核一次 currentTime。
  function onEnded(v) {
    paint(true);
    lastPct = 1;
    clearEnded();
    for (const ms of [80, 260, 900]) {
      endedTimers.push(setTimeout(() => {
        if (video !== v || !bar) return;
        lastTime = -1;                     // 不管回到没回到开头，都按最新值重画
        paint(true);
        if (!v.paused) { schedule(); ensureFrames(); }
      }, ms));
    }
  }

  // 播放器重渲染（开评论、切布局）会把我们的节点一起清掉：重新挂到新宿主上
  function ensure(v) {
    const nextHost = v.closest('.xgplayer, .douyin-player') || v.parentElement;
    if (!nextHost) return false;
    if (video === v && host === nextHost && bar && bar.isConnected) return true;

    cancelFrame();
    stopSeekBurst();
    clearEnded();
    if (bar) bar.remove();
    video = v;
    host = nextHost;
    unknown = null;
    lastPct = -1;
    lastTime = -1;
    frameAt = 0;
    effDur = NaN;
    effAt = 0;

    bar = document.createElement('div');
    bar.className = 'dyc-progress';
    bar.setAttribute('data-dyc-progress', '');
    bar.setAttribute('aria-hidden', 'true');
    if (!hasRVFC) bar.setAttribute(ATTR_SMOOTH, '');
    fill = document.createElement('div');
    fill.className = 'dyc-progress-fill';
    fill.style.transform = 'scaleX(0)';
    bar.appendChild(fill);
    host.appendChild(bar);
    return true;
  }

  function detach() {
    cancelFrame();
    stopSeekBurst();
    clearEnded();
    video = null;
    host = null;
    lastPct = -1;
    lastTime = -1;
    frameAt = 0;
    unknown = null;
    effDur = NaN;
    effAt = 0;
    if (bar) bar.remove();
    bar = null;
    fill = null;
  }

  // 预加载的相邻视频也会触发媒体事件 / 被 main.js 传进来。
  // 进度条只应该挂在"当前屏幕上这张卡片"的视频上；优先用 feed-active-video，
  // 没有再退回传进来的视频 / 当前在播视频。自动跳广告后卡片会换，这一步能防止
  // 线条被留在上一张或屏幕外的预加载卡片里。
  function visibleVideo(v) {
    const active = document.querySelector('[data-e2e="feed-active-video"]');
    const activeVideo = active && active.querySelector('video');
    const pool = [activeVideo, v, D.playingVideo()].filter(Boolean);
    for (const c of pool) {
      const r = c.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return c;
    }
    return pool[0] || null;
  }

  // 预加载的相邻视频也会触发媒体事件 / 被 main.js 传进来，
  // 统一只认"当前在播且面积最大"的那个，避免线条挂到屏幕外的卡片上。
  function attach(v) {
    if (!enabled() || !html.classList.contains('dyc-feed')) {
      detach();
      return;
    }
    // 聊天 / 弹层里的播放器不挂线条
    if (v && D.isOverlayVideo(v)) return;
    // 不依赖 settings 的异步回调：storage 不可用 / 回调早于本模块加载时，
    // 这里补一次开关类，保证第一次挂载就有样式。
    if (!html.classList.contains(ON_CLASS)) html.classList.add(ON_CLASS);
    // 同理补颜色变量；值相同就跳过，避免每次换片都让整页样式失效。
    if (html.style.getPropertyValue('--dyc-progress-color') !== colorOf()) paintColor();
    const target = visibleVideo(v);
    if (!target) return;
    if (!ensure(target)) return;
    paint(true);
    schedule();
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
      // 聊天页 / 私信抽屉 / 好友分享弹层里的播放器不挂进度线
      if (D.isOverlayVideo(v)) return;

      if (v !== video) {
        // 预加载的相邻视频处于暂停状态，不抢当前画面
        if (v.paused) return;
        if (D.playingVideo() !== v) return;
        attach(v);
        return;
      }

      if (type === 'durationchange' || type === 'loadedmetadata' || type === 'emptied') {
        effDur = NaN;
        effAt = 0;
        lastTime = -1;
      }

      if (!bar || !bar.isConnected) {
        // 宿主被播放器重渲染了：重新挂上并补一帧
        if (!ensure(v)) return;
        paint(true);
        schedule();
        return;
      }

      if (type === 'ended') {
        onEnded(v);
        return;
      }

      paint();

      // 快进 / 快退 / 点进度条跳转：seek 期间逐帧补，松手后再对齐一次
      if (type === 'seeking') {
        seekBurst();
        return;
      }
      if (type === 'seeked') {
        lastTime = -1;
        paint(true);
        schedule();
        ensureFrames();
        return;
      }
      if (type === 'play' || type === 'playing' || type === 'ratechange') {
        schedule();
        ensureFrames();
        return;
      }
      // timeupdate 约 4Hz：既补画，也用来发现"逐帧回调已经丢了"
      if (type === 'timeupdate') ensureFrames();
    }, true);
  }

  D.progress = {
    attach,
    // 幂等补挂：只在"视频/宿主/节点"真的变了或被播放器清掉时才重建。
    // 给 main.js 的 2 秒看门狗和 overlay 的显示切换用，暂停时也能把线条补回来。
    sync(v) {
      if (!enabled() || !html.classList.contains('dyc-feed')) return;
      if (v && D.isOverlayVideo(v)) return;
      const target = visibleVideo(v);
      if (!target) return;
      // 先补开关类和颜色，防止设置回调/重渲染把样式丢了却被下面的幂等判断直接放行
      if (!html.classList.contains(ON_CLASS)) html.classList.add(ON_CLASS);
      if (html.style.getPropertyValue('--dyc-progress-color') !== colorOf()) paintColor();
      const nextHost = target.closest('.xgplayer, .douyin-player') || target.parentElement;
      if (video === target && host === nextHost && bar && bar.isConnected) {
        paint();                 // 顺带补一帧：暂停时也能把最新位置画出来
        ensureFrames();          // 逐帧回调丢了就重新排
        return;
      }
      // 这里不用 attach()：暂停时 attach 会退回 D.playingVideo()，可能挂到别的预加载卡片上；
      // 看门狗 / 显示切换传进来的就是当前视频，直接挂它。
      if (!ensure(target)) return;
      paint(true);
      schedule();
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
        逐帧: hasRVFC,
        时长: isFinite(d) ? Math.round(d * 10) / 10 : null,
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
