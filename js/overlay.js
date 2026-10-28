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
  let pending = null;
  let wasInside = false;      // 上一次判断时鼠标是否在视频画面内
  let rectAt = 0;             // currentRect 的取样时刻
  // 左下角小卡片（游戏 / 推荐）经常比视频晚一步渲染：换片时标一次会漏，
  // 由 main.js 的 2 秒看门狗调用 tick() 有限次补标。
  let gameDone = false;
  let recDone = false;
  let tickLeft = 6;

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
    tickLeft = 6;
  }

  // 始终隐藏的推广卡片（游戏卡片）：用 data-dyc-hide，不跟浮层显隐；
  // 单独记录，扩展关闭/切页时能恢复。
  let permanent = [];
  function hidePermanent(el) {
    if (!el || el.nodeType !== 1) return;
    el.setAttribute('data-dyc-hide', '');
    if (permanent.indexOf(el) === -1) permanent.push(el);
  }
  function clearPermanent() {
    permanent.forEach(el => el.removeAttribute('data-dyc-hide'));
    permanent = [];
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

  // 画面左下角的游戏卡片（例如「游戏 原神 · 评分高达9.3」）。
  // 类名同样是哈希，按小尺寸 + 固定文案定位；直接永久隐藏，避免跟着浮层切换时慢半拍。
  function markGame(v, vr) {
    // 优先用整张活动卡：游戏卡片可能挂在播放器外层，cardOf 只到 .slider-video 会漏
    const card = v.closest('[data-e2e="feed-active-video"], [data-e2e="feed-item"]') ||
      cardOf(v, vr) || v.parentElement;
    if (!card) return;

    const near = el => {
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 12 || r.width > 320 || r.height > 48) return null;
      if (vr.width && !D.near(r, vr, 48)) return null;
      if (el.closest('[data-e2e*="comment"], [class*="comment-list"], [class*="comment-panel"]')) return null;
      if (el.closest('.video-info-detail, [data-e2e*="video-info"]')) return null;
      return r;
    };

    // 1) 明确的 game anchor 语义（如果当前版本带这类标记）
    let n = 0;
    for (const el of card.querySelectorAll('[class*="game-anchor" i], [data-e2e*="game-anchor" i], [class*="gameAnchor" i]')) {
      if (++n > 6) break;
      if (near(el)) { hidePermanent(el); gameDone = true; return; }
    }

    // 2) 按文案找小卡片；向上取到包含它的最大小容器，连图标一起藏
    n = 0;
    for (const el of card.querySelectorAll('div, span, a, section')) {
      if (++n > 900) break;
      if (!near(el)) continue;
      const t = D.textOf(el);
      if (!t || t.length > 48 || !/评分高达|^游戏.*评分/.test(t)) continue;
      let box = el;
      while (box.parentElement && box.parentElement !== card) {
        const p = box.parentElement;
        if (!near(p)) break;
        if (!/评分高达|^游戏.*评分/.test(D.textOf(p))) break;
        box = p;
      }
      hidePermanent(box);
      gameDone = true;
      return;
    }
  }

  // 「推荐」类浮层统一处理（v1.9.11 重做）。
  // 这一类在抖音上有三种形态，以前只认了前两种、而且尺寸下限写死 40px：
  //   ① 左下角「某某 推荐」卡片（带图标，通常 40px 以上宽）；
  //   ② 作者名字上方的小「推荐」标签（常常只有 20~40px 宽，直接被 40px 下限挡掉）；
  //   ③ 「1.2万人推荐」这种人气推荐条（文案更长，位置可能贴着标题上方）。
  // 它们唯一的共同点：文本以「推荐」结尾，并且是压在画面上的小尺寸元素。
  // 所以这里统一按"文本 + 小尺寸 + 靠近画面"识别，用"排除标题 / 评论 / 大容器"防误伤，
  // 标记方式与「某某 推荐」完全一致（data-dyc-ui + data-dyc-instant），
  // 也就是跟标题 / 互动栏一起出现、一起隐藏。
  const RECOMMEND_RE = /推荐$/;
  const REC_W = 340;      // 单条推荐卡片的最大宽度
  const REC_H = 64;       // 最大高度

  function markInstant(el) {
    if (!el || el.nodeType !== 1) return;
    el.setAttribute('data-dyc-instant', '');
    mark(el);
  }

  function markRecommend(v, vr) {
    const card = v.closest('[data-e2e="feed-active-video"], [data-e2e="feed-item"]') ||
      cardOf(v, vr) || v.parentElement;
    if (!card) return 0;

    let hits = 0;
    let n = 0;
    for (const el of card.querySelectorAll('div, span, a, section, p, i, em, b, button')) {
      if (++n > 1200) break;
      if (el.contains(v)) continue;
      if (el.closest('[data-e2e*="comment"], [class*="comment-list"], [class*="comment-panel"]')) continue;
      // 只认"文字几乎就是这句话"的小元素：容器里塞了别的内容就跳过，
      // 避免把整块信息区 / 整张卡片标记掉。
      if (el.childElementCount > 8) continue;
      const t = D.textOf(el);
      if (!t || t.length > 24) continue;
      if (!RECOMMEND_RE.test(t)) continue;

      // 已经在信息块里的推荐条：信息块收起时它自然跟着收起，不必单独标记。
      // 否则标题「好物推荐」这类文案会白占"最多 3 条"的名额，把真正的推荐卡片挤掉。
      const info = el.closest('.video-info-detail, [data-e2e*="video-info"]');
      if (info && info.hasAttribute('data-dyc-ui')) continue;

      const r = el.getBoundingClientRect();
      if (r.width < 14 || r.height < 10) continue;
      // 标题也可能以「推荐」结尾（例如「好物推荐」）：靠尺寸挡掉 ——
      // 标题 / 话题块通常又宽又高，远超这里的上限。
      if (r.width > REC_W || r.height > REC_H) continue;
      if (vr.width && !D.near(r, vr, 60)) continue;

      // 向上收拢到"包含图标 / 背景"的同一文案小容器
      let box = el;
      while (box.parentElement && box.parentElement !== card) {
        const p = box.parentElement;
        const pr = p.getBoundingClientRect();
        if (pr.width > REC_W || pr.height > REC_H) break;
        if (D.textOf(p) !== t) break;
        box = p;
      }
      if (box.hasAttribute('data-dyc-ui')) continue;   // 已经被上一层收拢标记过
      markInstant(box);
      if (++hits >= 3) break;                          // 一张卡片最多 3 个，防止误伤成片
    }
    return hits;
  }

  function sync(video) {
    if (!enabled()) {
      clearTimeout(timer);
      timer = 0;
      if (!html.classList.contains('dyc-ui-on')) html.classList.add('dyc-ui-on');
      clearMarks();
      clearPermanent();
      currentVideo = null;
      currentRect = null;
      return;
    }

    const v = video || D.playingVideo();
    if (!v) return;
    // 聊天页 / 弹层里的播放器不参与信息流浮层标记
    if (D.isOverlayVideo(v)) return;
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
    recDone = markRecommend(v, vr) > 0;
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
    // 周期性补标（main.js 的 2 秒看门狗调用）：游戏卡片 / 推荐卡片经常比视频晚一步渲染，
    // 只在换片时标一次会漏。这里只扫左下角两类小卡片，每个视频最多补 6 次（约 12 秒）。
    tick() {
      if (!enabled() || !html.classList.contains('dyc-feed')) return;
      if (gameDone && recDone) return;
      if (tickLeft <= 0) return;
      const v = activeVideo() || currentVideo || D.playingVideo();
      if (!v || !v.isConnected || D.isOverlayVideo(v)) return;
      const vr = v.getBoundingClientRect();
      if (!vr.width || !vr.height) return;
      tickLeft--;
      if (!gameDone) markGame(v, vr);
      if (!recDone) recDone = markRecommend(v, vr) > 0;
    },
    applySettings() {
      if (!html.classList.contains('dyc-feed')) {
        clearMarks();
        clearPermanent();
        return;
      }
      if (!enabled()) {
        clearTimeout(timer);
        timer = 0;
        if (!html.classList.contains('dyc-ui-on')) html.classList.add('dyc-ui-on');
        clearMarks();
        clearPermanent();
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
      clearPermanent();
      hide();
      currentVideo = null;
      currentRect = null;
      wasInside = false;
      rectAt = 0;
    }
  };
})();
