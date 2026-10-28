/* 视频浮层自动显隐
 *
 * 隐藏对象：视频上的标题/话题文案、右侧整条互动栏（头像·点赞·评论·收藏·分享）。
 * 规则：
 *   - 鼠标从画面外进入画面 -> 立即显示；
 *   - 鼠标在画面内移动 -> 一直显示（每次移动都重置计时）；
 *   - 鼠标停下不动 2 秒 -> 自动隐藏；
 *   - 鼠标移出画面 2 秒 -> 自动隐藏（移出后不再重置计时，避免在画面外乱动导致永不隐藏）；
 *   - 视频暂停 -> 立即收起一次；之后仍按上面的规则：鼠标一动就显示，静止 2 秒再收起。
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
  // 游戏卡 / 推荐卡是否已找到；tickLeft 限制每个视频最多补标几次
  let gameDone = false;
  let recDone = false;
  let badgeDone = false;       // 名字上方的小「推荐」标签是否已处理
  let tickLeft = 6;
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
      if (!html.classList.contains('dyc-ui-on')) {
        html.classList.add('dyc-ui-on');
        // 从隐藏切到显示时补挂一次进度条，避免暂停期间被播放器清掉后要等看门狗
        if (D.progress) D.progress.sync(D.playingVideo());
      }
      return;
    }
    if (!html.classList.contains('dyc-ui-on')) {
      html.classList.add('dyc-ui-on');
      if (D.progress) D.progress.sync(D.playingVideo());
    }
    arm();
  }

  function hide() {
    if (!enabled()) return;
    clearTimeout(timer);
    timer = 0;
    html.classList.remove('dyc-ui-on');
  }

  function clearMarks() {
    marked.forEach(el => {
      el.removeAttribute('data-dyc-ui');
      el.removeAttribute('data-dyc-instant');
    });
    marked = [];
    gameDone = false;
    recDone = false;
    badgeDone = false;
    tickLeft = 6;
  }

  function mark(el) {
    if (!el || el.nodeType !== 1 || marked.indexOf(el) !== -1) return;
    el.setAttribute('data-dyc-ui', '');
    marked.push(el);
  }

  // 和标题 / 互动栏完全同步：去掉过渡，避免慢半拍
  function markInstant(el) {
    if (!el || el.nodeType !== 1) return;
    el.setAttribute('data-dyc-instant', '');
    mark(el);
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

  // 当前屏幕上这张活动卡片里的视频。暂停后 D.playingVideo() 可能退回预加载卡片，
  // 用它的矩形判断鼠标位置会导致"鼠标在画面上却一直判定为画面外"。
  function activeVideo() {
    const active = document.querySelector('[data-e2e="feed-active-video"]');
    const v = active && active.querySelector('video');
    if (!v) return null;
    const r = v.getBoundingClientRect();
    return (r.width > 0 && r.height > 0) ? v : null;
  }

  // 暂停时 video 元素可能被隐藏（矩形为 0），但活动卡片本身仍有尺寸；
  // 用卡片矩形兜底，鼠标在画面上移动时依然能唤出浮层。
  function activeRect() {
    const active = document.querySelector('[data-e2e="feed-active-video"]');
    if (!active) return null;
    const v = active.querySelector('video');
    const vr = v && v.getBoundingClientRect();
    if (vr && vr.width > 0 && vr.height > 0) return vr;
    const ar = active.getBoundingClientRect();
    return (ar.width > 0 && ar.height > 0) ? ar : null;
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

  // 抖音会把下一条视频预加载在 DOM 里，同一选择器可能命中多张卡片；
  // 取离当前画面最近的那个，避免标记到别的卡片上导致整条互动栏没被标记。
  function pickNear(sel, vr, pad) {
    let best = null;
    let bestD = Infinity;
    document.querySelectorAll(sel).forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      if (!D.near(r, vr, pad)) return;
      const d = Math.abs((r.left + r.right) - (vr.left + vr.right)) +
        Math.abs((r.top + r.bottom) - (vr.top + vr.bottom));
      if (d < bestD) { bestD = d; best = el; }
    });
    return best;
  }

  // 整条右侧互动栏：优先取"点赞/评论/收藏/分享"的最近公共祖先（不依赖任何哈希类名），
  // 公共祖先过大时退回"从点赞按钮向上找窄而高的一层"。
  function markRail(vr) {
    const limitW = Math.max(160, vr.width * 0.25);
    const picks = [];
    for (const sel of [D.SEL.digg, D.SEL.commentIcon, D.SEL.collect, D.SEL.share]) {
      const el = pickNear(sel, vr, 140);
      if (el) picks.push(el);
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

    const digg = pickNear(D.SEL.digg, vr, 140);
    if (!digg) return;

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

  // 互动栏最底部的「听抖音」和「更多（省略号）」：
  // 类名全是哈希，只有 data-e2e 和文案可靠；「听抖音」正好是「更多」的前一个兄弟节点。
  // 它们不在点赞等按钮的静态隐藏规则里，必须单独标记，否则整条互动栏藏了它还露着。
  function markExtra(v, vr) {
    let found = false;
    document.querySelectorAll('[data-e2e="video-play-more"]').forEach(more => {
      const r = more.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || !D.near(r, vr, 60)) return;
      mark(more);
      const rail = more.parentElement;
      if (!rail) return;
      for (const child of rail.children) {
        if (D.textOf(child) === '听抖音') {
          mark(child);
          found = true;
        }
      }
    });
    if (found) return;

    // 兜底：某些布局没有「更多」按钮，按文案在卡片内找一次
    const card = cardOf(v, vr) || v.parentElement;
    if (!card) return;
    let n = 0;
    for (const el of card.querySelectorAll('div')) {
      if (++n > 1200) break;
      if (D.textOf(el) !== '听抖音') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || !D.near(r, vr, 60)) continue;
      let box = el;
      while (box.parentElement && D.textOf(box.parentElement) === '听抖音') box = box.parentElement;
      mark(box);
      break;
    }
  }

  // 画面左下角的游戏推广卡片（例如「游戏 原神 · 评分高达9.3」）。
  // 类名全是哈希，所以用三种互相兜底的判据：语义类名（game*）→ 文案（评分/游戏）→ 尺寸+位置。
  // 它必须跟标题 / 互动栏一起显隐（以前是直接永久隐藏，看起来就像"它不跟着一起动"）。
  function markGame(v, vr) {
    // 优先用整张活动卡：游戏卡片可能挂在播放器外层，cardOf 只到 .slider-video 会漏
    const card = v.closest('[data-e2e="feed-active-video"], [data-e2e="feed-item"]') ||
      cardOf(v, vr) || v.parentElement;
    if (!card) return;

    const near = el => {
      if (!el || el.nodeType !== 1) return null;
      if (el.closest('[data-e2e*="comment"], [class*="comment-list"], [class*="comment-panel"]')) return null;
      if (el.closest('.video-info-detail, [data-e2e*="video-info"]')) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 14 || r.width > 380 || r.height > 96) return null;
      if (vr.width && !D.near(r, vr, 60)) return null;
      // 只认画面左半边、下半部分：避开顶部的推荐入口和画面中央的按钮
      if (vr.width && r.left > vr.left + vr.width * 0.55) return null;
      if (vr.height && r.top < vr.top + vr.height * 0.4) return null;
      return r;
    };

    // 向上收拢到"包含它的最大小容器"，连图标一起藏
    const boxOf = el => {
      let box = el;
      while (box.parentElement && box.parentElement !== card) {
        const p = box.parentElement;
        if (!near(p)) break;
        box = p;
      }
      return box;
    };

    // 1) 明确的 game 语义标记（新版 / 旧版都可能带）
    let n = 0;
    for (const el of card.querySelectorAll('[class*="game" i], [data-e2e*="game" i]')) {
      if (++n > 8) break;
      if (!near(el)) continue;
      markInstant(boxOf(el));
      gameDone = true;
      return;
    }

    // 2) 按文案找小卡片
    n = 0;
    for (const el of card.querySelectorAll('div, span, a, section')) {
      if (++n > 900) break;
      if (!near(el)) continue;
      const t = D.textOf(el);
      if (!t || t.length > 60) continue;
      // 「评分」单独出现时容易撞上标题文案，必须同时带图标（游戏名称图标）才算
      const hit = /评分高达/.test(t) || /^游戏/.test(t) || /秒玩/.test(t) ||
        (/评分/.test(t) && !!el.querySelector('img, svg'));
      if (!hit) continue;
      markInstant(boxOf(el));
      gameDone = true;
      return;
    }
  }

  // 「推荐」相关浮层有两类，都要跟标题 / 互动栏同步收起：
  //   1) 左下角「某某 推荐」卡片：带图标，通常宽 40px 以上、位于画面下半部；
  //   2) 作者名字上方的小「推荐」标签：可能只有 20~40px 宽，紧贴视频信息块顶部。
  // 第二类尺寸比卡片小得多，不能套用第一类的 40px 下限，否则会像"长在画面上"一样露着。
  function markRecommend(v, vr) {
    const card = v.closest('[data-e2e="feed-active-video"], [data-e2e="feed-item"]') ||
      cardOf(v, vr) || v.parentElement;
    if (!card) return;

    const inComment = el =>
      !!el.closest('[data-e2e*="comment"], [class*="comment-list"], [class*="comment-panel"]');
    const inInfo = el => !!el.closest('.video-info-detail, [data-e2e*="video-info"]');

    // 1) 「某某 推荐」卡片
    if (!recDone) {
      const near = el => {
        if (inComment(el)) return null;
        if (inInfo(el)) return null;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 12 || r.width > 320 || r.height > 48) return null;
        if (vr.width && !D.near(r, vr, 48)) return null;
        if (vr.width && r.left > vr.left + vr.width * 0.6) return null;    // 只认画面左侧
        if (vr.height && r.top < vr.top + vr.height * 0.45) return null;   // 只认下半部
        return r;
      };

      let n = 0;
      for (const el of card.querySelectorAll('div, span, a, section')) {
        if (++n > 900) break;
        if (!near(el)) continue;
        const t = D.textOf(el);
        if (!t || t.length > 24 || !/推荐$/.test(t)) continue;
        // 向上取到包含图标的最大小容器，连图标一起藏
        let box = el;
        while (box.parentElement && box.parentElement !== card) {
          const p = box.parentElement;
          if (!near(p)) break;
          if (!/推荐$/.test(D.textOf(p))) break;
          box = p;
        }
        markInstant(box);
        recDone = true;
        break;
      }
    }

    // 2) 名字上方的小「推荐」标签
    if (badgeDone) return;

    // 信息块矩形：用来判断标签是不是"贴着名字上方"
    let info = null;
    let bestD = Infinity;
    card.querySelectorAll('.video-info-detail, [data-e2e*="video-info"]').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 10) return;
      if (vr.width && !D.near(r, vr, 40)) return;
      const d = Math.abs(r.left - vr.left) + Math.abs(r.bottom - vr.bottom);
      if (d < bestD) { bestD = d; info = r; }
    });

    let n = 0;
    for (const el of card.querySelectorAll('div, span, a, section, button, img')) {
      if (++n > 1200) break;
      // 先做零几何的文本判断：只有文案就是「推荐」的小元素才值得量尺寸。
      // 可见文案优先于 aria-label / title / alt，避免外层标签写了更长的说明就漏掉。
      if (el.childElementCount > 6) continue;
      const text = (el.textContent || '').replace(/\s+/g, '');
      const label = text || (el.getAttribute('aria-label') || el.getAttribute('title') ||
        el.getAttribute('alt') || '').replace(/\s+/g, '');
      if (!label || label.length > 24 || label !== '推荐') continue;

      const r = el.getBoundingClientRect();
      if (r.width < 16 || r.height < 10 || r.width > 96 || r.height > 40) continue;
      if (vr.width && !D.near(r, vr, 36)) continue;
      if (inComment(el)) continue;

      // 标签本来就在信息块里：信息块收起时它自然跟着收起，不用重复标记
      if (inInfo(el)) {
        badgeDone = true;
        return;
      }

      const aboveInfo = !!info &&
        r.bottom <= info.top + 14 && r.top >= info.top - 120 &&
        r.left < info.right && r.right > info.left;
      const lowerLeft = vr.width && r.left < vr.left + vr.width * 0.6 &&
        r.top > vr.top + vr.height * 0.4;
      if (!aboveInfo && !lowerLeft) continue;

      // 向上收拢到整枚小标签（含图标 / 背景），但不要越过一个正常的信息块
      let box = el;
      while (box.parentElement && box.parentElement !== card) {
        const p = box.parentElement;
        const pr = p.getBoundingClientRect();
        if (pr.width > 120 || pr.height > 48) break;
        if (vr.width && !D.near(pr, vr, 36)) break;
        if ((p.textContent || '').replace(/\s+/g, '') !== '推荐') break;
        box = p;
      }
      markInstant(box);
      badgeDone = true;
      return;
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
    if (!v || !D.inFeed(v)) return;
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
    markExtra(v, vr);
    markGame(v, vr);
    markRecommend(v, vr);
    // 新视频默认保持干净；但鼠标还在画面里时不要突然隐藏，
    // 否则会表现为"刚动一下就瞬间消失"，和 2 秒延迟的规则不一致。
    // 暂停的视频例外：切过去先立即收起一次。
    if (v.paused || !wasInside) hide();
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
      // 优先当前活动卡片里的视频：暂停 / 切广告后 currentVideo 可能是预加载卡片
      const v = activeVideo() || currentVideo || D.playingVideo();
      if (v && v !== currentVideo) currentVideo = v;
      const ar = activeRect();
      if (ar) {
        currentRect = ar;
        rectAt = now;
      } else if (v) {
        currentRect = v.getBoundingClientRect();
        rectAt = now;
      }
      if (!currentRect) return;
      // 缓存的元素被播放器重渲染移出 DOM 时，矩形会是 0；退回当前在播的视频重取
      if (!currentRect.width || !currentRect.height) {
        const live = D.playingVideo();
        if (live && live !== currentVideo) {
          currentVideo = live;
          currentRect = live.getBoundingClientRect();
          rectAt = now;
        }
      }
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

  // 滚轮不会触发 pointermove；指针停在画面上滑动滚轮时也让浮层显示
  document.addEventListener('wheel', e => {
    if (!html.classList.contains('dyc-feed')) return;
    pending = e;
    if (raf) return;
    raf = requestAnimationFrame(onMove);
  }, { passive: true });

  // 暂停 / 恢复由播放器事件驱动，不轮询。
  // 只认当前在播的那条视频，预加载的相邻视频暂停不会影响当前画面。
  // 暂停瞬间立即收起一次；之后鼠标移动照常显示，静止 2 秒照常收起。
  document.addEventListener('pause', e => {
    if (!(e.target instanceof HTMLVideoElement) || !html.classList.contains('dyc-feed')) return;
    const v = currentVideo || D.playingVideo();
    if (e.target !== v) return;
    hide();
  }, true);
  document.addEventListener('play', e => {
    if (!(e.target instanceof HTMLVideoElement) || !html.classList.contains('dyc-feed')) return;
    const v = currentVideo || D.playingVideo();
    if (e.target !== v) return;
    // 鼠标还停在画面上时，恢复播放也把浮层带回来
    if (wasInside) show();
  }, true);

  // 视口变化时刷新缓存矩形（只做一次，不循环）
  window.addEventListener('resize', () => {
    currentRect = null;
    if (html.classList.contains('dyc-feed')) sync();
  }, { passive: true });

  D.overlay = {
    sync,
    // 周期性补标（2 秒看门狗调用）：游戏卡 / 推荐卡经常比视频晚一步渲染，
    // 只在换片时标记一次会漏；这里只扫左下角两类小卡片，开销极小。
    tick() {
      if (!enabled() || !html.classList.contains('dyc-feed')) return;
      if (gameDone && recDone && badgeDone) return;  // 两类卡片与推荐标签都找到了，不再扫
      if (tickLeft <= 0) return;            // 每个视频最多补标 6 次（约 12 秒）
      tickLeft--;
      const v = activeVideo() || currentVideo || D.playingVideo();
      if (!v || !v.isConnected || !D.inFeed(v)) return;
      const vr = v.getBoundingClientRect();
      if (!vr.width || !vr.height) return;
      if (!gameDone) markGame(v, vr);
      if (!recDone || !badgeDone) markRecommend(v, vr);
    },
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
