/* 视频浮层自动显隐
 *
 * 隐藏对象：视频上的标题/话题文案、右侧整条互动栏（头像·点赞·评论·收藏·分享）。
 * 规则：
 *   - 鼠标从画面外进入画面 -> 立即显示；
 *   - 鼠标在画面内移动 -> 一直显示（每次移动都重置计时）；
 *   - 鼠标停下不动 2 秒 -> 自动隐藏；
 *   - 鼠标移出画面 2 秒 -> 自动隐藏（移出后不再重置计时，避免在画面外乱动导致永不隐藏）。
 *
 * 实测：这些浮层都是 .slider-video 卡片里、位于 .xgplayer 之外的 position:absolute 元素，
 * 而点赞按钮的祖先链是 45 → 50 → 50 → 66 宽、高度 68 → 493 → 493 → 509。
 * 所以这里用三条互相兜底的规则：
 *   1) .video-info-detail —— 按几何（与视频水平重叠、在视频下方 460px 内）挑选；
 *   2) 点赞按钮的祖先 —— 向上找"窄而高"的那一层，整条互动栏一起隐藏；
 *   3) 通用规则 —— 卡片内所有 position:absolute/fixed、有文字、面积不到视频一半的浮层。
 * 全部标记只在换视频时做一次，鼠标判定走 rAF 合并，避免刷视频掉帧。
 */
(() => {
  const D = window.__DYC;
  if (!D) return;

  let timer = 0;
  let currentVideo = null;
  let currentRect = null;
  let marked = [];
  let syncAt = 0;
  let raf = 0;
  let pending = null;
  let wasInside = false;      // 上一次判断时鼠标是否在视频画面内
  let rectAt = 0;             // currentRect 的取样时刻

  const html = document.documentElement;
  // popup 设置：关闭后所有浮层常显，不再标记、不再计时隐藏
  const enabled = () => !D.settings || D.settings.overlay !== false;

  function arm() {
    clearTimeout(timer);
    timer = setTimeout(hide, D.HIDE_DELAY);
  }

  function show() {
    if (!enabled()) {
      clearTimeout(timer);
      timer = 0;
      if (!html.classList.contains('dyc-ui-on')) html.classList.add('dyc-ui-on');
      return;
    }
    if (!html.classList.contains('dyc-ui-on')) html.classList.add('dyc-ui-on');
    arm();
  }

  function hide() {
    if (!enabled()) return;
    clearTimeout(timer);
    timer = 0;
    html.classList.remove('dyc-ui-on');
  }

  function clearMarks() {
    marked.forEach(el => el.removeAttribute('data-dyc-ui'));
    marked = [];
  }

  function mark(el) {
    if (!el || el.nodeType !== 1 || marked.indexOf(el) !== -1) return;
    el.setAttribute('data-dyc-ui', '');
    marked.push(el);
  }

  // 视频真实所在的卡片（slider-video 那一层：宽高都比 video 略大一点）
  function cardOf(v, vr) {
    const direct = v.closest('.slider-video');
    if (direct) return direct;
    let node = v.parentElement;
    let best = null;
    for (let i = 0; i < 8 && node && node !== document.body; i++, node = node.parentElement) {
      const r = node.getBoundingClientRect();
      const fitW = r.width >= vr.width - 2 && r.width <= vr.width * 1.35;
      const fitH = r.height >= vr.height - 2 && r.height <= vr.height * 1.5;
      if (fitW && fitH) best = node;
      else if (best) break;
    }
    return best;
  }

  function markInfo(vr) {
    document.querySelectorAll('.video-info-detail, [data-e2e*="video-info"]').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 10) return;
      const xOverlap = r.left < vr.right && r.right > vr.left;
      const nearY = r.top > vr.top - 40 && r.top < vr.bottom + 460;
      if (xOverlap && nearY) mark(el);
    });
  }

  // 整条右侧互动栏：优先取"点赞/评论/收藏/分享"的最近公共祖先（不依赖任何哈希类名），
  // 公共祖先过大时退回"从点赞按钮向上找窄而高的一层"。
  function markRail(vr) {
    const limitW = Math.max(160, vr.width * 0.25);
    const picks = [];
    for (const sel of [D.SEL.digg, D.SEL.commentIcon, D.SEL.collect, D.SEL.share]) {
      const el = document.querySelector(sel);
      if (!el) continue;
      if (!D.near(el.getBoundingClientRect(), vr, 140)) continue;
      picks.push(el);
    }

    if (picks.length >= 2) {
      const rail = D.commonAncestor(picks, document.body);
      if (rail) {
        const r = rail.getBoundingClientRect();
        if (r.width >= 8 && r.width <= limitW && r.height >= 80 && r.height <= vr.height * 1.1) {
          mark(rail);
          return;
        }
      }
    }

    const digg = document.querySelector(D.SEL.digg);
    if (!digg) return;
    if (!D.near(digg.getBoundingClientRect(), vr, 140)) return;

    let node = digg.parentElement;
    let best = null;
    for (let i = 0; i < 6 && node && node !== document.body; i++, node = node.parentElement) {
      const r = node.getBoundingClientRect();
      if (r.width >= 8 && r.width <= limitW && r.height >= 80 && r.height <= vr.height * 0.98) best = node;
      else if (best) break;
    }
    if (best) mark(best);
  }

  // 通用兜底：卡片内所有压在视频上的绝对定位浮层
  function markOverlays(v, vr) {
    // 拿不到 slider-video 时退两层（播放器容器 + 卡片层），仍能覆盖浮层
    const card = cardOf(v, vr) || (v.parentElement && v.parentElement.parentElement);
    if (!card) return;
    // 新旧播放器容器都要排除：新版是 .douyin-player，控制条也有自己的 .douyin-player-controls
    const xp = v.closest('.xgplayer, .douyin-player');
    const vArea = Math.max(1, vr.width * vr.height);
    const nodes = card.querySelectorAll('div, span, section, aside, ul, li, a, button, img');
    let n = 0;
    for (const el of nodes) {
      if (++n > 900) break;
      if (xp && xp !== el && xp.contains(el)) continue;     // 播放器控制条不动
      if (el.contains(v)) continue;
      // 评论区是手动开关的面板，里面的评论 / 商品链接不参与自动隐藏
      if (el.closest('[data-e2e*="comment"], [class*="comment-list"], [class*="comment-panel"]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) continue;
      if (!D.near(r, vr, 24)) continue;
      if (r.width > vr.width * 0.9) continue;
      if (r.width * r.height > vArea * 0.5) continue;      // 大面板不接管
      if (r.height > vr.height * 0.75 && r.width > 140) continue; // 评论区（手动开关，保留）
      const cs = getComputedStyle(el);
      if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
      if (!D.textOf(el) && !/^(IMG|BUTTON|A)$/.test(el.tagName)) continue;
      mark(el);
    }
  }

  function sync(video) {
    if (!enabled()) {
      clearTimeout(timer);
      timer = 0;
      if (!html.classList.contains('dyc-ui-on')) html.classList.add('dyc-ui-on');
      clearMarks();
      currentVideo = null;
      currentRect = null;
      return;
    }

    const v = video || D.playingVideo();
    if (!v) return;
    const vr = v.getBoundingClientRect();
    if (!vr.width || !vr.height) return;

    // 同一个视频 500ms 内只重新标记一次，避免事件密集时反复查 DOM
    const now = performance.now();
    if (v === currentVideo && now - syncAt < 500) return;

    currentVideo = v;
    currentRect = vr;
    syncAt = now;
    rectAt = now;

    clearMarks();
    markInfo(vr);
    markRail(vr);
    markOverlays(v, vr);
    // 新视频默认保持干净；但鼠标还在画面里时不要突然隐藏，
    // 否则会表现为"刚动一下就瞬间消失"，和 2 秒延迟的规则不一致。
    if (!wasInside) hide();
    D.log('overlay: 已标记浮层', marked.length, '个');
  }

  function onMove() {
    raf = 0;
    const e = pending;
    pending = null;
    if (!enabled()) return;
    if (!e || !html.classList.contains('dyc-feed')) return;

    // 画面矩形按需刷新：最多每 250ms 读一次布局，既不会用到换视频/开评论后的旧尺寸，
    // 也不会给每帧增加布局开销。
    const now = performance.now();
    if (!currentRect || now - rectAt > 250) {
      const v = currentVideo || D.playingVideo();
      if (v) {
        currentRect = v.getBoundingClientRect();
        rectAt = now;
      }
      if (!currentRect) return;
    }

    const r = currentRect;
    const pad = 4;
    const inside = e.clientX > r.left - pad && e.clientX < r.right + pad &&
      e.clientY > r.top - pad && e.clientY < r.bottom + pad;

    if (inside) {
      // 进入或内部移动：立即显示，并不断重置 2 秒计时 -> 只要还在动就一直显示
      wasInside = true;
      show();
    } else if (wasInside) {
      // 从画面内移到画面外：不再重置计时，2 秒后自然隐藏
      wasInside = false;
      arm();
    }
    // 一直在画面外移动时什么都不做，避免无限推迟隐藏
  }

  document.addEventListener('pointermove', e => {
    if (!html.classList.contains('dyc-feed')) return;
    pending = e;
    if (raf) return;
    raf = requestAnimationFrame(onMove);
  }, { passive: true });

  // 视口变化时刷新缓存矩形（只做一次，不循环）
  window.addEventListener('resize', () => {
    currentRect = null;
    if (html.classList.contains('dyc-feed')) sync();
  }, { passive: true });

  D.overlay = {
    sync,
    applySettings() {
      if (!html.classList.contains('dyc-feed')) {
        clearMarks();
        return;
      }
      if (!enabled()) {
        clearTimeout(timer);
        timer = 0;
        if (!html.classList.contains('dyc-ui-on')) html.classList.add('dyc-ui-on');
        clearMarks();
        currentVideo = null;
        currentRect = null;
        return;
      }
      // 从"关闭"切回"开启"时，强制重新标记一次，别被 500ms 去重挡住
      currentVideo = null;
      currentRect = null;
      syncAt = 0;
      sync();
    },
    reset() {
      clearMarks();
      hide();
      currentVideo = null;
      currentRect = null;
      wasInside = false;
      rectAt = 0;
    }
  };
})();
