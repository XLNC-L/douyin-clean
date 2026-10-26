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
  let lastPct = -1;
  let unknown = null;       // null=尚未判定；true/false=当前线条是否因时长未知而隐藏

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
    if (!frameCb) return;
    const v = video;
    if (v && typeof v.cancelVideoFrameCallback === 'function') {
      try { v.cancelVideoFrameCallback(frameCb); } catch (e) { /* 忽略 */ }
    }
    frameCb = 0;
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
    const d = video.duration;
    if (!isFinite(d) || d <= 0) {
      setUnknown(true);
      return;
    }
    setUnknown(false);
    const ratio = Math.max(0, Math.min(1, video.currentTime / d));
    // 万分之一：1000px 宽的线条上约 0.1px，肉眼看不出量化，却能挡掉大量重复写入
    const pct = Math.round(ratio * 10000) / 10000;
    if (!force && pct === lastPct) return;
    lastPct = pct;
    fill.style.transform = 'scaleX(' + pct + ')';
  }

  function schedule() {
    if (frameCb || !bar || !video || !hasRVFC || !enabled()) return;
    const v = video;
    if (v.paused || v.ended) return;
    frameCb = v.requestVideoFrameCallback(() => {
      frameCb = 0;
      if (video !== v || !bar || !bar.isConnected) return;
      paint();
      schedule();
    });
  }

  // 播放器重渲染（开评论、切布局）会把我们的节点一起清掉：重新挂到新宿主上
  function ensure(v) {
    const nextHost = v.closest('.xgplayer, .douyin-player') || v.parentElement;
    if (!nextHost) return false;
    if (video === v && host === nextHost && bar && bar.isConnected) return true;

    cancelFrame();
    if (bar) bar.remove();
    video = v;
    host = nextHost;
    unknown = null;
    lastPct = -1;

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
    video = null;
    host = null;
    lastPct = -1;
    unknown = null;
    if (bar) bar.remove();
    bar = null;
    fill = null;
  }

  // 预加载的相邻视频也会触发媒体事件 / 被 main.js 传进来，
  // 统一只认"当前在播且面积最大"的那个，避免线条挂到屏幕外的卡片上。
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
    const target = (v && !v.paused && !v.ended && v.readyState >= 2)
      ? v
      : (D.playingVideo() || v);
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

      if (v !== video) {
        // 预加载的相邻视频处于暂停状态，不抢当前画面
        if (v.paused) return;
        if (D.playingVideo() !== v) return;
        attach(v);
        return;
      }

      if (!bar || !bar.isConnected) {
        // 宿主被播放器重渲染了：重新挂上并补一帧
        if (!ensure(v)) return;
        paint(true);
        schedule();
        return;
      }

      paint();
      if (type === 'play' || type === 'playing' || type === 'seeked' || type === 'ratechange') {
        schedule();
      }
    }, true);
  }

  D.progress = {
    attach,
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
