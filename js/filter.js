/* 广告 / 带货视频过滤 + 头像旁直播小窗清理
 *
 * 重要教训（上一版的两个 bug 都在这里）：
 * - 以前命中后执行 video.muted = true + video.pause()。抖音前端是同一个 <video> 元素
 *   在不同视频间复用，muted 一旦置 true 就会一直静音下去；误判时也会表现为"莫名暂停"。
 *   所以现在**绝不改 muted、绝不 pause**，命中只做一件事：切到下一条。
 * - 判定范围也收紧：只认视频卡片里"小尺寸的广告/推广/赞助徽标"，不再扫 body、不再靠 URL 猜。
 * 另外加了冷却：1.5 秒内最多跳过一条，避免误判时连环跳视频。
 *
 * 直播：用户会主动看直播，所以**不再把直播视频当成广告跳过**（去掉了"直播中"徽标与 .flv 判定）。
 * 带货：这类视频没有"广告"徽标（左下角是"购物"卡片、账号名是"XX旗舰店"），所以新增两条判定。
 *
 * 头像旁弹出的"直播/推广小窗"自动关闭：小窗不是列表里的视频，但右上角有原生关闭按钮。
 * 开销控制：页面里的 <video> 本来就只有几个，先按"小尺寸非主视频"找；
 * 这一步没结果时才做一次低频（10 秒最多一次）的文档级关闭按钮查询。
 */
(() => {
  const D = window.__DYC;
  if (!D) return;

  // 只保留"广告 / 推广 / 赞助"这类明确标注；直播不再跳过（用户需要看直播）
  const BADGES = ['广告', '推广', '赞助'];
  // 带货视频没有"广告"徽标，但左下角会有"购物"卡片、账号名常是"XX旗舰店/专卖店"
  const SHOP_CHIP_RE = /^(购物|商品|小店|橱窗|去购买|立即购买|商品详情|同款商品)/;
  const SHOP_NAME_RE = /(旗舰店|专卖店|专营店|官方店|企业店|小店)$/;
  const passes = new WeakMap();     // video -> 已判定次数
  const blocked = new WeakSet();
  let lastSkip = 0;

  function cardOf(video) {
    return video.closest('[data-e2e="feed-active-video"], [data-e2e="feed-item"], .slider-video') ||
      video.parentElement || document.body;
  }

  // 只认"小徽标"：文本恰好是广告/推广/赞助/直播中，且元素尺寸像标签
  function badgeHit(root, vr) {
    if (!root || !root.querySelectorAll) return '';
    let n = 0;
    for (const el of root.querySelectorAll('span, div, i, em, b, p')) {
      if (++n > 600) break;
      if (el.children.length) continue;
      const t = D.textOf(el);
      if (!t || t.length > 3) continue;
      if (BADGES.indexOf(t) === -1) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) continue;
      if (r.width > 160 || r.height > 48) continue;      // 大面积文案不算徽标
      if (vr && !D.near(r, vr, 60)) continue;
      return t;
    }
    return '';
  }

  function attrHit(root) {
    if (!root || !root.querySelectorAll) return '';
    const el = root.querySelector('[data-e2e*="advert" i], [aria-label="广告"], img[alt="广告"]');
    return el ? 'ad' : '';
  }

  // 带货视频的标志：播放器左下角那颗"购物 / 商品"小卡片
  function shopChipHit(root, vr) {
    if (!root || !root.querySelectorAll) return '';
    let n = 0;
    for (const el of root.querySelectorAll('span, div, i, em, b, p, a')) {
      if (++n > 600) break;
      if (el.children.length) continue;
      const t = D.textOf(el);
      if (!t || t.length > 8) continue;
      if (!SHOP_CHIP_RE.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) continue;
      if (r.width > 140 || r.height > 44) continue;
      if (vr && !D.near(r, vr, 40)) continue;
      return '购物卡片';
    }
    return '';
  }

  // 电商账号：旗舰店 / 专卖店 / 小店这类名称基本只做带货
  // 必须离视频够近：万一 cardOf 退化成 body，也不会把页面其它位置的店铺链接算进来
  function shopAuthorHit(root, vr) {
    if (!root || !root.querySelectorAll) return '';
    let n = 0;
    for (const a of root.querySelectorAll('a[href*="/user/"], [data-e2e*="author" i]')) {
      if (++n > 8) break;
      const t = D.textOf(a).replace(/^@/, '');
      if (!t || t.length > 20) continue;
      if (!SHOP_NAME_RE.test(t)) continue;
      const r = a.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) continue;
      if (vr && !D.near(r, vr, 80)) continue;
      return '店铺账号';
    }
    return '';
  }

  function detect(video) {
    const vr = video.getBoundingClientRect();
    const card = cardOf(video);
    let hit = badgeHit(card, vr);
    if (!hit) hit = attrHit(card);
    if (!hit) hit = shopChipHit(card, vr);
    if (!hit) hit = shopAuthorHit(card, vr);
    return hit;
  }

  function next(video) {
    const now = Date.now();
    if (now - lastSkip < 1500) return;
    lastSkip = now;

    const arrow = document.querySelector('[data-e2e="video-switch-next-arrow"]');
    if (arrow && arrow.getBoundingClientRect().width > 0) {
      arrow.click();
      return;
    }
    // 顺着可滚动容器滚一屏（抖音是 scroll-snap，会自动吸附到下一条）
    let node = video.parentElement;
    while (node && node !== document.body) {
      const cs = getComputedStyle(node);
      if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 50) break;
      node = node.parentElement;
    }
    if (node && node !== document.body) {
      node.scrollBy({ top: node.clientHeight, behavior: 'auto' });
      return;
    }
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true
    }));
  }

  function judge(video) {
    if (!(video instanceof HTMLVideoElement)) return;
    if (!document.documentElement.classList.contains('dyc-feed')) return;
    if (video !== D.playingVideo()) return;

    const n = passes.get(video) || 0;
    if (n >= 4) return;                 // 最多判 4 次：购物卡片有时比视频晚出现
    passes.set(video, n + 1);

    const reason = detect(video);
    if (!reason) {
      if (n + 1 < 4) setTimeout(() => judge(video), n === 0 ? 900 : 1500);
      return;
    }

    if (!blocked.has(video)) {
      blocked.add(video);
      D.log('filter: 识别到', reason, '，跳过该视频');
      next(video);
    }
  }

  // ---------- 头像旁弹出的直播 / 推广小窗 ----------
  const BTN_SEL = '[aria-label*="关闭"], [aria-label*="close" i], [title*="关闭"], [title*="close" i], [class*="close" i]';
  const tries = new WeakMap();      // 关闭按钮 -> 已尝试次数
  let lastScan = 0;
  let lastClose = 0;

  function btnUsable(el) {
    if (!el || (tries.get(el) || 0) >= 2) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return false;
    if (r.width > 56 || r.height > 56) return false;     // 大的不是小窗关闭按钮
    if (r.bottom < 0 || r.top > window.innerHeight) return false;
    return true;
  }

  // 在小窗范围内找关闭按钮：先认语义标记，再认"只有一颗 ×"的按钮
  function closeBtnIn(scope) {
    if (!scope || !scope.querySelectorAll) return null;
    let n = 0;
    for (const el of scope.querySelectorAll(BTN_SEL)) {
      if (++n > 30) break;
      if (btnUsable(el)) return el;
    }
    n = 0;
    for (const el of scope.querySelectorAll('div, span, i, b, button, a')) {
      if (++n > 240) break;
      if (el.children.length) continue;
      if (!btnUsable(el)) continue;
      const t = D.textOf(el);
      if (t.length > 2 || !/^[×✕✖✗╳xX]$/.test(t)) continue;
      return el;
    }
    return null;
  }

  // 小尺寸、可见、不是正在播放的视频 -> 顺着祖先找关闭按钮（最多 5 层，越往上越像整页就停）
  function closeBtnOfMini(v, main) {
    const r = v.getBoundingClientRect();
    if (r.width < 120 || r.width > 720) return null;
    if (r.height < 80 || r.height > 520) return null;
    if (r.right < 0 || r.left > window.innerWidth) return null;
    if (r.bottom < 0 || r.top > window.innerHeight) return null;
    if (main) {
      const mr = main.getBoundingClientRect();
      if (r.width * r.height >= mr.width * mr.height * 0.6) return null;
    }

    let node = v.parentElement;
    for (let i = 0; i < 5 && node && node !== document.body; i++, node = node.parentElement) {
      const br = node.getBoundingClientRect();
      if (br.width > 780 || br.height > 660) break;      // 已经不是小窗了
      const btn = closeBtnIn(node);
      if (btn) return btn;
    }
    return null;
  }

  function closePopups(video) {
    if (!document.documentElement.classList.contains('dyc-feed')) return;
    const now = Date.now();
    if (now - lastClose < 800) return;                   // 关得太密容易误伤别的东西

    const main = (video instanceof HTMLVideoElement) ? video : D.playingVideo();
    let hit = null;

    let n = 0;
    for (const v of document.querySelectorAll('video')) {
      if (++n > 12) break;
      if (v === main) continue;
      hit = closeBtnOfMini(v, main);
      if (hit) break;
    }

    // 少数小窗没有预览画面、只有文案：低频兜底一次（10 秒最多一次）
    if (!hit && now - lastScan > 10000) {
      lastScan = now;
      let k = 0;
      for (const btn of document.querySelectorAll(BTN_SEL)) {
        if (++k > 16) break;
        if (!btnUsable(btn)) continue;
        let box = btn.parentElement;
        for (let i = 0; i < 5 && box && box !== document.body; i++, box = box.parentElement) {
          const br = box.getBoundingClientRect();
          if (br.width < 120 || br.height < 80) continue;
          if (br.width > 780 || br.height > 660) break;
          if (!/直播|LIVE/i.test(D.textOf(box))) continue;
          hit = btn;
          break;
        }
        if (hit) break;
      }
    }

    if (!hit) return;
    // 私信/消息抽屉里的关闭按钮不是"直播小窗"，别去点它
    if (hit.closest('aside')) return;
    // 别去点播放器自己的按钮
    if (main && hit.closest('.xgplayer') && hit.closest('.xgplayer') === main.closest('.xgplayer')) return;

    tries.set(hit, (tries.get(hit) || 0) + 1);
    lastClose = now;
    try { hit.click(); } catch (e) { /* 忽略 */ }
    D.log('filter: 已关闭头像旁的直播/推广小窗');
  }

  D.filter = {
    checkAd(video) {
      judge(video);
    },
    closePopups,
    probe() {
      const v = D.playingVideo();
      if (!v) return null;
      return { hit: detect(v) || null, muted: v.muted, paused: v.paused };
    },
    reset() {
      // 状态挂在元素上，无需额外清理；只重置低频扫描计时
      lastScan = 0;
    }
  };
})();
