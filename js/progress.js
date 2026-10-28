/* 视频底部进度细线
 *
 * 位置：把一条 3px 细线挂进播放器根节点（.xgplayer / .douyin-player），absolute 贴底。
 * 播放器缩放、开评论区、全屏时都会跟着走，不需要读几何、不需要跟随 resize。
 *
 * 更新方式（v1.9.11 重做，合并上一版"逐帧读 currentTime"的做法）：
 *   requestAnimationFrame 循环 —— 线条挂着就一直每帧读一次 video.currentTime 写
 *   transform: scaleX()。这是唯一驱动，不再依赖 requestVideoFrameCallback：
 *   rVFC 只在"有新画面呈现"时回调，拖动进度条、跳转、切清晰度、页面不可见时都可能
 *   长时间不回调，回调链一断线条就只剩 4Hz 的 timeupdate，
 *   看起来就是"只会匀速走、快进快退和跳转都没反应"。
 *   媒体事件（timeupdate / seeking / seeked / ended / ratechange …）仍然保留，
 *   用于即时对齐和兜底，事件与循环写的是同一个 paint()。
 *
 * 每帧只读 currentTime（纯内存属性，不触发重排）、只写 fill 的 transform，
 * 并按万分之一取整去重，暂停 / 卡顿时不会空写。颜色通过根节点上的
 * --dyc-progress-color 变量下发，播放过程中不读也不写样式表。
 *
 * 另外三个容易翻车的点：
 *   · 播完"从头播放"不稳定：抖音可能是 loop 属性，也可能是 JS 里 seek 回 0，
 *     后者不保证触发 play / seeking。ended 之后补三次兜底重画，currentTime 变小时也强制重画；
 *   · 拖动进度条时视频常常是暂停的，而且抖音不保证触发 seeking / timeupdate：
 *     循环干脆一直跑（页面不可见时 rAF 自己会停），任何一次 currentTime 变化都能跟上；
 *   · 时长兜底值可能比当前位置还小（读到了"当前时间"而不是总时长）：这种值直接丢弃，
 *     否则线条会一直卡在 100%，看起来就像"这条视频不跟进度"；
 *   · 线条挂错视频：每秒复核一次，目标视频被换掉 / 移出 DOM 时改挂当前活动卡片。
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
  let lastTime = -1;        // 上次画线时的 currentTime：用来发现"回到开头 / 往回拖"
  let idAt = 0;             // 目标视频复核时刻
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

  // ---------- 逐帧循环 ----------
  function stopLoop() {
    if (!rafId) return;
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  // 循环一直跑（页面不可见时 rAF 自己会停），而不是"只在播放时跑"。
  // 原因：抖音的拖动 / 跳转 / 切清晰度并不保证触发 seeking / timeupdate，
  // 按事件开关循环会漏掉一部分视频 —— 表现就是"有的视频能同步快进快退，有的却不动"。
  // 每帧只读一次 currentTime 并与上次比较，值没变就什么都不写，
  // 一帧的开销是两次属性读取，远小于一次样式计算。
  function loop() {
    rafId = 0;
    if (!enabled() || !html.classList.contains('dyc-feed')) return;
    retarget();                        // 每 120ms 确认一次"线条该挂在哪条视频上"
    if (bar && video && !document.hidden) paint();
    if (!rafId) rafId = requestAnimationFrame(loop);
  }

  function startLoop() {
    if (rafId || !enabled()) return;
    rafId = requestAnimationFrame(loop);
  }

  // 开关类与颜色：settings 是异步读出来的，这里每次都补一遍（幂等，代价可忽略）
  function ensureStyle() {
    if (!html.classList.contains(ON_CLASS)) html.classList.add(ON_CLASS);
    if (html.style.getPropertyValue('--dyc-progress-color') !== colorOf()) paintColor();
  }

  // 活动卡片里的视频（真正贴在屏幕上的那张卡片）
  function activeCardVideo() {
    const active = document.querySelector('[data-e2e="feed-active-video"]');
    const v = active && active.querySelector('video');
    return (v && v.isConnected) ? v : null;
  }

  // 线条最该跟的那条视频：优先"在播 + 在视口里"，其次才是活动卡片。
  // 抖音换片时会留下上一条继续播放的旧视频，也会把相邻视频预加载在 DOM 里；
  // 只按"活动卡片"挑，很容易挑到已经换走的那条 —— 表现就是
  // "刚打开时前几条正常，之后线条全部不动 / 不跟快进"。
  function bestTarget() {
    const cands = [];
    const playing = D.playingVideo();
    if (playing && playing.isConnected && D.visibleArea(playing) > 0) cands.push(playing);
    const active = activeCardVideo();
    if (active && active !== playing && D.visibleArea(active) > 0) cands.push(active);
    if (!cands.length) return null;
    // 在播的优先；都在播（或都暂停）时取可见面积大的
    cands.sort((a, b) => {
      const pa = (a.paused || a.ended) ? 0 : 1;
      const pb = (b.paused || b.ended) ? 0 : 1;
      if (pa !== pb) return pb - pa;
      return D.visibleArea(b) - D.visibleArea(a);
    });
    return cands[0];
  }

  // 每 120ms 复核一次目标：换了视频、或者我们的节点被播放器重渲染清掉，
  // 就立刻改挂并补一帧。这条是"前几条之后全部失效"的根因修复 ——
  // 抖音后面会换新的 <video> 元素，旧元素还留在 DOM 里但已经不在播，
  // 线条若继续挂在它身上就永远不动。
  function retarget() {
    const now = performance.now();
    if (now - idAt < 120) return;
    idAt = now;
    const next = bestTarget();
    if (!next) return;
    if (next === video && bar && bar.isConnected) return;
    ensureStyle();
    if (!ensure(next)) return;
    paint(true);
  }

  function setUnknown(flag) {
    if (unknown === flag) return;
    unknown = flag;
    if (!bar) return;
    if (flag) bar.setAttribute(ATTR_UNKNOWN, '');
    else bar.removeAttribute(ATTR_UNKNOWN);
  }

  // ---------- 镜像抖音自己的进度条 ----------
  // 我们的线条本质上是"复述"播放进度。抖音的播放器有 MSE / 虚拟时间轴 / 特殊 seek 等情况，
  // 个别视频上 video.currentTime 与用户看到的进度会不一致，这时直接读它自己的进度条更准。
  // 只读 style 上的 transform / width（不触发布局），最多每 200ms 取一次。
  const PROGRESS_SEL = '[class*="progress-played"], [class*="progress-inner"], [class*="progress-current"]';
  let mirrorAt = 0;
  let mirrorVal = NaN;
  let mirrorLast = NaN;
  let mirrorSince = 0;
  let mirrorCt = 0;
  let mirrorOff = false;

  const clamp01 = n => (n < 0 ? 0 : n > 1 ? 1 : n);

  function resetMirror() {
    mirrorAt = 0;
    mirrorVal = NaN;
    mirrorLast = NaN;
    mirrorSince = 0;
    mirrorCt = 0;
    mirrorOff = false;
  }

  function readMirror() {
    if (mirrorOff || !video) return NaN;
    const box = host || video.closest('.xgplayer, .douyin-player');
    if (!box) return NaN;
    const el = box.querySelector(PROGRESS_SEL);
    if (!el) return NaN;
    const tf = el.style.transform || '';
    const m = /scaleX\(\s*([\d.]+)\s*\)/.exec(tf);
    if (m) return clamp01(parseFloat(m[1]));
    const w = el.style.width || '';
    if (/%\s*$/.test(w)) return clamp01(parseFloat(w) / 100);
    // 最后退回几何（最多 5 次/秒，代价可接受）
    const p = el.parentElement;
    if (!p) return NaN;
    const pw = p.getBoundingClientRect().width;
    if (!(pw > 0)) return NaN;
    return clamp01(el.getBoundingClientRect().width / pw);
  }

  // 防御：如果认到的这个"进度条"一直不动、而 currentTime 在走，说明认错了元素，
  // 本视频不再镜像，避免线条被钉死在某个位置。
  function mirrorRatio() {
    const now = performance.now();
    if (now - mirrorAt < 200) return mirrorVal;
    mirrorAt = now;
    mirrorVal = readMirror();
    if (isFinite(mirrorVal)) {
      const cur = video.currentTime;
      if (mirrorVal !== mirrorLast) {
        mirrorLast = mirrorVal;
        mirrorSince = now;
        mirrorCt = cur;
      } else if (now - mirrorSince > 4000 && Math.abs(cur - mirrorCt) > 2) {
        mirrorOff = true;
        mirrorVal = NaN;
      }
    }
    return mirrorVal;
  }

  function paint(force) {
    if (!bar || !video) return;
    const d = durationOf(video);
    const cur = video.ended ? d : video.currentTime;
    let ratio;
    if (isFinite(d) && d > 0) {
      // 时长已知：currentTime / duration 就是准确值，不折腾
      ratio = clamp01(cur / d);
      setUnknown(false);
    } else {
      // 时长未知（MSE 流）：优先镜像抖音自己的进度条，读不到才判为"未知"整条隐藏
      const nr = mirrorRatio();
      if (!isFinite(nr)) {
        setUnknown(true);
        return;
      }
      ratio = nr;
      setUnknown(false);
    }
    // 循环播放 / 拖回开头：currentTime 明显变小，说明已经重新开始或往回跳了。
    // 必须强制重画，否则线条会一直停在 100% 等下一帧 ——
    // 表现就是"播完之后有时会从头走、有时不会"。
    const back = lastTime >= 0 && cur + 0.35 < lastTime;
    lastTime = cur;
    // 万分之一：1000px 宽的线条上约 0.1px，肉眼看不出量化，却能挡掉大量重复写入
    const pct = Math.round(ratio * 10000) / 10000;
    if (!force && !back && pct === lastPct) return;
    lastPct = pct;
    fill.style.transform = 'scaleX(' + pct + ')';
  }

  // 抖音很多 MSE 流的 video.duration 是 Infinity / NaN；这时用播放器时间显示里的总时长
  // 或 seekable 区间兜底，否则这些视频的进度条会一直消失 / 算错。
  // 直播返回 NaN，整条隐藏。
  // 「00:35」「1:02:03」「00:12/00:35」都按最后一段解析成秒
  function parseClock(text) {
    if (!text) return NaN;
    const tail = String(text).split('/').pop().replace(/\s+/g, '').trim();
    const nums = tail.split(':').map(Number);
    if (nums.length < 2 || nums.length > 3 || !nums.every(n => isFinite(n))) return NaN;
    return nums.length === 3
      ? nums[0] * 3600 + nums[1] * 60 + nums[2]
      : nums[0] * 60 + nums[1];
  }

  function fallbackDuration(v) {
    const box = v.closest('.xgplayer, .douyin-player') || v.parentElement;
    if (!box) return NaN;

    // 直播：控制条里的 .time-live-tag 会从 display:none 变成显示
    const liveTag = box.querySelector('.time-live-tag');
    if (liveTag) {
      const cs = getComputedStyle(liveTag);
      if (cs.display !== 'none' && cs.visibility !== 'hidden' &&
          liveTag.getBoundingClientRect().width > 0) return NaN;
    }

    const cur = isFinite(v.currentTime) ? v.currentTime : 0;

    // ① 播放器自己的总时长文案最接近真实时长（seekable 可能只到已缓冲位置）。
    //    注意有的版本 .time-duration 显示的是"当前时间"而不是总时长：
    //    总时长一定 >= 当前位置，比当前位置还小的直接丢弃，否则线条会一直卡在 100%。
    for (const sel of ['.time-total', '[class*="time-total"]', '.time-duration', '[class*="duration"]']) {
      const el = box.querySelector(sel);
      const sec = parseClock(el ? el.textContent : '');
      if (sec > 0 && sec + 1 >= cur) return sec;
    }

    // ② MSE 点播常见：duration 为 Infinity，但 seekable 末端就是真实时长
    const s = v.seekable;
    if (s && s.length) {
      const end = s.end(s.length - 1);
      if (isFinite(end) && end > 0 && end + 1 >= cur) return end;
    }
    return NaN;
  }

  // 正常视频直接用 video.duration，不读布局；只有时长不是有限值时才走兜底，
  // 并且最多每秒取样一次，避免逐帧查询 DOM。兜底值按最大值累积，
  // 防止 seekable 只覆盖已缓冲区间时把进度算得忽快忽慢。
  // 例外：兜底值比当前位置还小（说明过期的估算 / 跳到了未缓冲区间），
  // 立刻重采样，不让线条卡在 100%。
  function durationOf(v) {
    const d = v.duration;
    if (isFinite(d) && d > 0 && d < 86400) return d;
    const now = performance.now();
    const cur = isFinite(v.currentTime) ? v.currentTime : 0;
    const stale = !(effDur > 0) || cur > effDur + 1;
    if (now - effAt < 1000 && !stale) return effDur;
    effAt = now;
    const fb = fallbackDuration(v);
    if (!isFinite(fb) || fb <= 0) return effDur;
    effDur = (isFinite(effDur) && effDur > 0) ? Math.max(effDur, fb) : fb;
    return effDur;
  }

  // 播完这一条：先画满，再补几次兜底重画。
  // 抖音"从头播放"可能是 loop 属性、也可能是 JS 里 seek 回 0，
  // 后者不保证触发 play / seeking，只靠事件会漏，所以这里定时复核一次 currentTime。
  function onEnded(v) {
    paint(true);
    clearEnded();
    for (const ms of [80, 260, 900]) {
      endedTimers.push(setTimeout(() => {
        if (video !== v || !bar) return;
        lastTime = -1;                     // 不管回到没回到开头，都按最新值重画
        paint(true);
        if (!v.paused) startLoop();
      }, ms));
    }
  }

  function clearEnded() {
    endedTimers.forEach(clearTimeout);
    endedTimers = [];
  }

  // 播放器重渲染（开评论、切布局）会把我们的节点一起清掉：重新挂到新宿主上
  function ensure(v) {
    const nextHost = v.closest('.xgplayer, .douyin-player') || v.parentElement;
    if (!nextHost) return false;
    if (video === v && host === nextHost && bar && bar.isConnected) return true;

    stopLoop();
    clearEnded();
    if (bar) bar.remove();
    video = v;
    host = nextHost;
    unknown = null;
    lastPct = -1;
    lastTime = -1;
    idAt = 0;
    effDur = NaN;
    effAt = 0;
    resetMirror();

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
    clearEnded();
    video = null;
    host = null;
    lastPct = -1;
    lastTime = -1;
    idAt = 0;
    unknown = null;
    effDur = NaN;
    effAt = 0;
    resetMirror();
    if (bar) bar.remove();
    bar = null;
    fill = null;
  }

  // 挂载目标：先按"在播 + 视口内"挑（bestTarget），挑不到再退回传进来的视频。
  // 不能只认 feed-active-video —— 抖音后面的卡片会换新的 <video> 元素，
  // 活动卡片属性更新滞后时就会一直挂在已经换走的那条上。
  function targetVideo(v) {
    const best = bestTarget();
    if (best) return best;
    if (v && v.isConnected && D.visibleArea(v) > 0) return v;
    return null;
  }

  function attach(v) {
    if (!enabled() || !html.classList.contains('dyc-feed')) {
      detach();
      return;
    }
    // 聊天 / 弹层里的播放器不挂线条
    if (v && D.isOverlayVideo(v)) return;
    ensureStyle();
    const target = targetVideo(v);
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
      if (LOG_TYPES[type]) logEvent(type, v);
      if (!enabled() || !html.classList.contains('dyc-feed')) return;
      // 聊天页 / 私信抽屉 / 好友分享弹层里的播放器不挂进度线
      if (D.isOverlayVideo(v)) return;

      if (v !== video) {
        // 目标由 retarget() 每 120ms 复核；这里只对"当前最该跟的那条"做即时接管，
        // 避免残留的旧视频一触发事件就把线条抢走。
        if (v.paused || D.visibleArea(v) <= 0) return;
        if (bestTarget() !== v) return;
        ensureStyle();
        if (!ensure(v)) return;
        paint(true);
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
        startLoop();
        return;
      }

      if (type === 'ended') {
        onEnded(v);
        return;
      }

      // seek 相关的三个事件都要即时对齐：拖动 / 点击跳转时，事件可能早于
      // 实际时间更新，所以除了立刻画一帧，还要确保逐帧循环在跑。
      if (type === 'seeking') {
        lastTime = -1;
        paint(true);
        startLoop();
        return;
      }
      if (type === 'seeked') {
        lastTime = -1;
        paint(true);
        startLoop();
        return;
      }

      paint();
      if (type === 'play' || type === 'playing' || type === 'pause' ||
          type === 'ratechange' || type === 'timeupdate' || type === 'waiting') {
        startLoop();
      }
    }, true);
  }

  // 页面切回来时 rAF 可能停过一轮：重新起循环
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (!bar || !video) return;
    paint(true);
    startLoop();
  });

  // ---------- 诊断：事件日志 + 实时面板（Alt+Shift+P） ----------
  // 真机排查用：面板直接显示"线条挂在哪条视频上、该挂哪条、填充值、原生进度"，
  // 事件日志记录最近 40 条 seek / play / ended，便于判断是"没收到事件"还是"收到了但没画"。
  const LOG_TYPES = { seeking: 1, seeked: 1, ended: 1, ratechange: 1, play: 1, pause: 1, emptied: 1, durationchange: 1 };
  const evLog = [];

  function logEvent(type, v) {
    const d = v.duration;
    evLog.push(type + ' t=' + (Math.round(v.currentTime * 100) / 100) +
      ' d=' + (isFinite(d) ? Math.round(d * 100) / 100 : d));
    if (evLog.length > 40) evLog.shift();
  }

  let hudEl = null;
  let hudTimer = 0;

  function hudText() {
    const best = bestTarget();
    const d = video ? video.duration : NaN;
    const fmt = n => (isFinite(n) ? Math.round(n * 100) / 100 : String(n));
    return [
      '抖音净播 v' + D.VER,
      '循环 ' + (rafId ? 'on' : 'off') + ' · 线条 ' + (bar && bar.isConnected ? 'on' : 'off') +
        ' · 未知 ' + (unknown ? 'Y' : 'N') + ' · 镜像 ' + (mirrorOff ? 'off' : 'on'),
      '挂载 ' + (video ? (video.isConnected ? '' : '已移除 ') + (video.paused ? '暂停' : '播放') +
        ' t=' + fmt(video.currentTime) + ' d=' + fmt(d) + ' x' + video.playbackRate : '无'),
      '应挂 ' + (best ? (best === video ? '同一条 ' : '不同! ') + (best.paused ? '暂停' : '播放') +
        ' t=' + fmt(best.currentTime) : '无'),
      '填充 ' + (lastPct >= 0 ? (lastPct * 100).toFixed(1) + '%' : '-') +
        ' · 原生 ' + (isFinite(mirrorVal) ? (mirrorVal * 100).toFixed(1) + '%' : '无'),
      '宿主 ' + (host ? String(host.className).slice(0, 46) : '-')
    ].join('\n');
  }

  function toggleHud() {
    if (hudEl) {
      clearInterval(hudTimer);
      hudTimer = 0;
      hudEl.remove();
      hudEl = null;
      return;
    }
    hudEl = document.createElement('div');
    hudEl.style.cssText = 'position:fixed;left:12px;top:12px;z-index:2147483647;padding:8px 10px;' +
      'background:rgba(0,0,0,.78);color:#25f4ee;font:11px/1.55 ui-monospace,Consolas,monospace;' +
      'white-space:pre;border-radius:6px;pointer-events:none';
    document.body.appendChild(hudEl);
    const tick = () => { if (hudEl) hudEl.textContent = hudText(); };
    tick();
    hudTimer = setInterval(tick, 250);
  }

  window.addEventListener('keydown', e => {
    if (!e.altKey || !e.shiftKey || e.key.toLowerCase() !== 'p') return;
    e.preventDefault();
    toggleHud();
  }, { passive: false });

  D.progress = {
    attach,
    // 幂等补挂：只在"视频/宿主/节点"真的变了或被播放器清掉时才重建。
    // 给 main.js 的 2 秒看门狗和 overlay 的显示切换用，暂停时也能把线条补回来。
    sync(v) {
      if (!enabled() || !html.classList.contains('dyc-feed')) return;
      if (v && D.isOverlayVideo(v)) return;
      // 先补开关类和颜色，防止设置回调/重渲染把样式丢了却被下面的幂等判断直接放行
      ensureStyle();
      // 循环万一因为异常 / 页面切换断掉，这里顺手拉起来（看门狗每 2 秒调一次）
      startLoop();
      const target = targetVideo(v);
      if (!target) return;
      const nextHost = target.closest('.xgplayer, .douyin-player') || target.parentElement;
      if (video === target && host === nextHost && bar && bar.isConnected) {
        paint();                 // 顺带补一帧：暂停时也能把最新位置画出来
        return;
      }
      if (!ensure(target)) return;
      paint(true);
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
      const best = bestTarget();
      return {
        启用: enabled(),
        线条: !!(bar && bar.isConnected),
        循环: !!rafId,
        挂载: video ? {
          连接: video.isConnected,
          可见面积: Math.round(D.visibleArea(video)),
          在播: !video.paused,
          当前时间: isFinite(video.currentTime) ? Math.round(video.currentTime * 10) / 10 : null,
          时长: isFinite(d) ? Math.round(d * 10) / 10 : (isFinite(effDur) ? '兜底 ' + Math.round(effDur * 10) / 10 : null),
          倍速: video.playbackRate,
          宿主: host ? String(host.className).slice(0, 40) : null
        } : null,
        应挂: best ? {
          同一条: best === video,
          可见面积: Math.round(D.visibleArea(best)),
          在播: !best.paused,
          当前时间: isFinite(best.currentTime) ? Math.round(best.currentTime * 10) / 10 : null
        } : null,
        进度: (video && lastPct >= 0) ? Math.round(lastPct * 1000) / 10 + '%' : null
      };
    },
    // 最近 40 条 seek / play / ended 事件，真机排查用
    log() {
      return evLog.slice();
    },
    reset() {
      detach();
      html.classList.remove(ON_CLASS);
    }
  };
})();
