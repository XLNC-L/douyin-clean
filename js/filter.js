/* 广告 / 带货视频过滤 + 头像旁直播小窗清理
 *
 * 重要教训（上一版的两个 bug 都在这里）：
 * - 以前命中后执行 video.muted = true + video.pause()。抖音前端是同一个 <video> 元素
 *   在不同视频间复用，muted 一旦置 true 就会一直静音下去；误判时也会表现为"莫名暂停"。
 *   所以现在**绝不改 muted、绝不 pause**，命中只做一件事：切到下一条。
 * - 判定范围也收紧：只认视频卡片里"小尺寸的广告/推广/赞助徽标"，不再扫 body、不再靠 URL 猜。
 * 另外加了冷却：1.5 秒内最多跳过一条，避免误判时连环跳视频。
 *
 * 直播：v1.8.0 起推荐流里的直播间也会自动跳过（面板里可单独关闭）。
 * v1.9.11 把直播判定拆成硬信号 / 软信号：直播间链接、LivePlayer_、直播时间标签、
 * 「直播中 / 进入直播间」徽标单独命中即可；只有「直播」字样或「1.2万观看」这类
 * 软信号时，必须两条同时成立才判，避免把"讲直播的普通视频"误跳。
 *
 * 带货：这类视频没有"广告"徽标，最稳的标志是画面左下角那颗"购物 / 商品名"小卡片
 * （位置固定、不随画面变化、也不会隐藏），其次是电商账号名。
 * v1.9.11 把文字判据分级：强信号（广告徽标、带分隔符的购物卡片）单独命中即跳过；
 * 弱信号（只有价格、只有购买按钮、只有营销话术）必须凑够两条不同种类，
 * 否则"¥19.9 三件套开箱"这种普通视频会被误跳。
 *
 * 状态跟着"当前这条视频"走，不挂在 <video> 元素上 —— 抖音始终复用同一个元素播放
 * 所有视频，状态挂在元素上会导致第一条视频判满次数后，后面全部视频被直接放过。
 *
 * 头像旁弹出的"直播/推广小窗"自动关闭：小窗不是列表里的视频，但右上角有原生关闭按钮。
 * 开销控制：页面里的 <video> 本来就只有几个，先按"小尺寸非主视频"找；
 * 这一步没结果时才做一次低频（10 秒最多一次）的文档级关闭按钮查询。
 */
(() => {
  const D = window.__DYC;
  if (!D) return;

  // 只保留"广告 / 推广 / 赞助"这类明确标注（直播由下面的 liveHit 单独判定）
  const BADGES = ['广告', '推广', '赞助'];
  // 评论区是用户主动打开的面板：里面的"广告/推广"字样、¥价格、店铺名都不是视频本身，
  // 必须排除出扫描范围，否则打开评论后很容易把正常视频判成带货。
  const COMMENT_PANEL_SEL = '[data-e2e*="comment"], [class*="comment-list"], [class*="comment-panel"]';
  // popup 设置：关闭后既不判定也不关闭小窗
  const enabled = () => !D.settings || D.settings.filter !== false;
  // 带货视频没有"广告"徽标，但左下角会有"购物"卡片、账号名常是"XX旗舰店/专卖店"
  // 卡片样式：购物车图标 + "购物/商品名"，所以关键词后面通常紧跟分隔符；没有分隔符时
  // 必须带图标才算，避免把"购物分享"这种普通文案误判成带货。
  const SHOP_CHIP_RE = /^(购物|商品|小店|橱窗|去购买|立即购买|商品详情|同款商品)([／/｜|·:：]|$)/;
  const SHOP_NAME_RE = /(旗舰店|专卖店|专营店|官方店|企业店|小店)$/;
  // 抖音的商品卡不止一种样式，文案也不统一：
  //   ① "购物 | 视频同款×××"
  //   ② "不容错过的优品 / ××× / ¥28.9 / 查看详情"
  // 所以主判据用容器类名（xgplayer-shop-anchor / douyin-player-shop-anchor，两种播放器通用），
  // 价格、购买按钮文案只作为兜底，避免只认"购物"两个字而漏判。
  const PRICE_RE = /^[¥￥]\s?\d/;
  const SHOP_CTA_RE = /(查看详情|立即购买|去购买|马上抢|加入购物车|领券购买)/;
  // 营销话术：单独出现不算数（标题里也常写"同款"），必须和另一条弱信号同时成立。
  const MARKETING_RE = /(小黄车|购物车|橱窗|同款商品|优惠券|领券|到手价|限时秒杀|点击左下角|左下角链接|商品链接|拍下)/;

  // 直播卡片与普通视频的区别（2026-10 实测）：
  //   · 播放器容器类名带 LivePlayer_（普通视频是 xgplayer）；
  //   · 控制条里的 .time-live-tag 在普通视频是 display:none，直播时显示「直播」；
  //   · 直播卡片 / 房间会带 data-e2e="live-room-*" / "livecard-*" / "web_live" 等语义标记；
  //   · 卡片链接指向 live.douyin.com 或 /live/。
  // 注意：每个头像都带 data-e2e="live-avatar"，绝不能按 data-e2e*="live" 通配。
  // v1.9.16：只有"当前这条视频本身"具备直播特征才跳过。
  // 作者正在直播时，普通视频卡片上会带作者头像直播圈、「正在直播 / 进入直播间」入口
  // 和指向直播间的链接 —— 这些是"作者在直播"，不是"当前视频是直播间"，一律不参与判定。
  // 因此直播链接 / 直播标记必须包住当前视频或播放器；文字徽标不再单独作为判定依据。
  const LIVE_LINK_SEL = 'a[href*="live.douyin.com"], a[href*="/live/"]';
  const LIVE_PLAYER_SEL = '[class*="LivePlayer_"], [class*="webcast-chatroom"]';
  const LIVE_MARK_SEL = '[data-e2e*="live-room"], [data-e2e*="livecard"], [data-e2e*="web_live"]';
  const MAX_LIVE_STREAK = 5;     // 连续跳过这么多条直播后先停一下，避免推荐流全是直播时无限切
  let liveStreak = 0;
  // 抖音复用同一个 <video> 元素播放所有视频，判定状态不能挂在元素上：
  // 元素上的计数一旦用满、或已判成广告，后面所有视频都会被直接放过。
  // 也不能用 duration / currentSrc 当身份：抖音大量视频是 MSE 流，
  // duration 常为 Infinity、currentSrc 常为空串，所有这类视频会撞成同一个 key，
  // 判定次数攒满后整条推荐流都不再检查（历史 bug，表现为"广告从不跳"）。
  // 现在统一用 main.js 维护的代次 D.gen：每换一条视频 +1。
  let st = { gen: -1, passes: 0, blocked: false, last: 0 };
  let lastSkip = 0;

  function cardOf(video) {
    return video.closest('[data-e2e="feed-active-video"], [data-e2e="feed-item"], .slider-video') ||
      video.parentElement || document.body;
  }

  const liveEnabled = () => !D.settings || D.settings.live !== false;

  function visibleBox(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  // 卡片内的文字扫描：一次遍历同时收"广告徽标 / 购物卡片 / 价格 / 购买按钮 / 营销话术"。
  // v1.9.11 起分成强信号与弱信号：
  //   强信号（广告徽标、带分隔符的购物卡片）单独命中即可跳过；
  //   弱信号（只有价格、只有购买按钮、只有营销话术）必须凑够两条不同种类，
  //   否则"¥19.9 三件套开箱"这种普通视频会被误跳。
  // 不再要求元素是叶子节点 —— 购物卡片是"图标 + 购物/ + 商品名"的复合结构，
  // 文本落在带子元素的容器上；也不再限制 3 个字（"购物/厚切吐司面包"就超了）。
  const inInfoBox = el => !!el.closest('.video-info-detail, [data-e2e*="video-info"]');

  function textSignals(root, vr) {
    const out = { strong: '', weak: [] };
    if (!root || !root.querySelectorAll) return out;
    const weak = new Set();
    let n = 0;
    for (const el of root.querySelectorAll('span, div, i, em, b, p, a')) {
      if (++n > 900) break;
      if (el.closest(COMMENT_PANEL_SEL)) continue;
      const t = D.textOf(el);
      if (!t || t.length > 24) continue;

      const r = el.getBoundingClientRect();
      const boxOk = (maxW, maxH) => r.width >= 6 && r.height >= 6 &&
        r.width <= maxW && r.height <= maxH && (!vr || D.near(r, vr, 40));

      // ① 广告徽标（强）：文本恰好是"广告/推广/赞助"
      if (t.length <= 3 && BADGES.indexOf(t) !== -1) {
        if (boxOk(160, 48)) { out.strong = t; return out; }
        continue;
      }

      // ② 购物卡片（强）：文案以"购物/商品"开头且后面紧跟分隔符或就是这几个字
      if (SHOP_CHIP_RE.test(t) && boxOk(320, 64)) { out.strong = '购物卡片'; return out; }
      // 另一种样式是"购物 视频同款×××"，空格会被 textOf 去掉，分隔符判据失效，
      // 这时必须带图标（购物车）才算，避免把"购物分享"这种普通文案误判成带货
      if (/^(购物|商品)/.test(t) && t.length <= 16 &&
          el.querySelector('img, svg, i') && boxOk(320, 64)) {
        out.strong = '购物卡片';
        return out;
      }

      // ③ 价格（弱）：只认"整块文字就是一个价格"的小元素，避免把正文里的 ¥ 算进来
      if (PRICE_RE.test(t) && t.length <= 12 && boxOk(220, 48)) { weak.add('价格'); continue; }

      // ④ 购买按钮（弱）：整块文字就是按钮文案
      if (SHOP_CTA_RE.test(t) && t.length <= 10 && boxOk(240, 56)) { weak.add('购买按钮'); continue; }

      // ⑤ 营销话术（弱）：标题 / 简介里也常写"同款"，所以排除信息块，且必须另有一条弱信号
      if (!inInfoBox(el) && MARKETING_RE.test(t) && t.length <= 20 && boxOk(300, 60)) {
        weak.add('营销话术');
      }
    }
    out.weak = Array.from(weak);
    return out;
  }

  function attrHit(root) {
    if (!root || !root.querySelectorAll) return '';
    let n = 0;
    for (const el of root.querySelectorAll('[data-e2e*="advert" i], [aria-label="广告"], img[alt="广告"], img[alt*="购物"], img[alt*="商品"], [aria-label*="购物"]')) {
      if (++n > 10) break;
      if (el.closest(COMMENT_PANEL_SEL)) continue;
      return 'ad';
    }
    return '';
  }

  // 商品卡容器：类名固定带 shop-anchor（新旧播放器都一样），这是最稳的判据
  function shopAnchorHit(root, vr) {
    if (!root || !root.querySelectorAll) return '';
    let n = 0;
    for (const el of root.querySelectorAll('[class*="shop-anchor"], [class*="shopAnchor"]')) {
      if (++n > 4) break;
      if (el.closest(COMMENT_PANEL_SEL)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 16) continue;
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
      if (a.closest(COMMENT_PANEL_SEL)) continue;
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

    // 1) 容器语义最稳：商品卡容器 / 广告属性
    let hit = shopAnchorHit(card, vr) || attrHit(card);
    if (hit) return hit;

    // 2) 文本信号：强信号直接判；弱信号要凑够两条不同种类
    const s = textSignals(card, vr);
    if (s.strong) return s.strong;
    if (s.weak.length >= 2) return '带货(' + s.weak.join('+') + ')';

    // 3) 店铺账号：旗舰店 / 专卖店 / 专营店 / 小店
    hit = shopAuthorHit(card, vr);
    if (hit) return hit;

    // 4) 兜底：卡片容器认错时（视频不在预期的卡片结构里），
    //    退一步在整页找"贴着视频画面"的商品卡 —— 它固定在左下角，不随画面变化。
    //    这里只认强信号，避免把页面别处的价格 / 营销文案算到这条视频头上。
    if (card !== document.body) {
      hit = shopAnchorHit(document.body, vr);
      if (hit) return hit;
      const page = textSignals(document.body, vr);
      if (page.strong) return page.strong;
    }
    return '';
  }

  // 直播判定：只认"当前这条视频本身是直播"的结构信号。
  // 作者正在直播时，普通视频卡片上也会出现头像直播圈、「正在直播 / 进入直播间」
  // 和指向直播间的链接；这些属于作者状态，不能据此跳过当前视频。
  // 因此：
  //   1) 直播链接 / 直播标记必须包住当前视频或播放器；
  //   2) 播放器本身必须是 LivePlayer_ / webcast-chatroom，或控制条显示直播时间标签；
  //   3) 不再用「直播中 / 正在直播 / 进入直播间」文字单独判定。
  function liveHit(video) {
    if (!liveEnabled()) return '';
    const card = video.closest('[data-e2e="feed-active-video"], [data-e2e="feed-item"]') || cardOf(video);
    const livePlayer = video.closest(LIVE_PLAYER_SEL);
    const player = video.closest('.xgplayer, .douyin-player, [class*="basePlayerContainer" i]') || null;

    // 1) 播放器根节点本身就是直播播放器 / 直播聊天室
    if (livePlayer && visibleBox(livePlayer)) return '直播(直播播放器)';

    // 2) 控制条把总时长换成了「直播」标签（普通视频隐藏）
    for (const root of [livePlayer, player]) {
      if (!root) continue;
      const tag = root.querySelector('.time-live-tag');
      if (tag && visibleBox(tag)) return '直播(直播时间标签)';
    }

    // 3) 直播链接：必须包住视频 / 播放器；作者头像、按钮等小入口一律不算
    for (const scope of [card, player, livePlayer]) {
      if (!scope) continue;
      for (const link of scope.querySelectorAll(LIVE_LINK_SEL)) {
        if (!visibleBox(link)) continue;
        if (link.contains(video) ||
            (player && link.contains(player)) ||
            (livePlayer && link.contains(livePlayer))) return '直播(直播间链接)';
      }
    }

    // 4) 直播间语义标记：必须是视频 / 播放器的祖先或容器
    for (const el of (card || document).querySelectorAll(LIVE_MARK_SEL)) {
      if (!visibleBox(el)) continue;
      if (el.closest(COMMENT_PANEL_SEL)) continue;
      if (el.contains(video) ||
          (player && (el.contains(player) || el === player)) ||
          (livePlayer && (el.contains(livePlayer) || el === livePlayer))) {
        return '直播(直播间标记)';
      }
    }

    // 5) 「直播中 / 正在直播 / 进入直播间」文字与头像直播圈不参与判定：
    //    那只能说明作者正在直播，当前视频仍可能是普通视频。
    return '';
  }

  // 切下一条。三种手段按顺序兜底，并且**复核是否真的切走了**：
  // 抖音的"下一条"箭头有时点不动（不可见 / 事件被拦），以前点完就当成功了，
  // blocked 一置真就再也不试，于是那条带货视频会一直播下去。
  function next(video, depth) {
    const d = depth || 0;
    // 用户暂停了就别跳：暂停状态下切走视频，观感就是"暂停被取消并划到下一条"
    if (video && video.paused) return;
    // 节流只作用于"首次尝试"，复核后的重试与降级递归必须能继续执行
    if (d === 0) {
      const now = Date.now();
      if (now - lastSkip < 1500) return;
      lastSkip = now;
    }

    const genAt = D.gen;
    const arrow = d === 0 ? document.querySelector(D.SEL.nextArrow) : null;

    if (arrow && arrow.getBoundingClientRect().width > 0) {
      arrow.click();
    } else if (d <= 1) {
      // 顺着可滚动容器滚一屏（抖音是 scroll-snap，会自动吸附到下一条）
      let node = video.parentElement;
      while (node && node !== document.body) {
        const cs = getComputedStyle(node);
        if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 50) break;
        node = node.parentElement;
      }
      if (node && node !== document.body) node.scrollBy({ top: node.clientHeight, behavior: 'auto' });
      else return next(video, 2);
    } else {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true
      }));
    }

    if (d >= 2) return;
    // 1.4 秒后复核：代次没变 = 还是同一条视频，说明这一下没生效
    setTimeout(() => {
      if (!video.isConnected || document.hidden) return;
      if (D.gen !== genAt) return;        // 已经换片了，成功
      st.blocked = false;                 // 允许下一轮重新判定并再试
      next(video, d + 1);
    }, 1400);
  }

  function judge(video) {
    if (!(video instanceof HTMLVideoElement)) return;
    if (!enabled() && !liveEnabled()) return;
    if (!document.documentElement.classList.contains('dyc-feed')) return;
    if (!video.isConnected) return;
    // 用户主动暂停时不判定、不跳下一条：暂停层常带"相关推荐 / 商品卡"，
    // 很容易被当成带货；而且暂停状态下切走视频就是"暂停被莫名其妙取消"的观感。
    if (video.paused) return;
    // 聊天页 / 私信抽屉 / 好友分享弹层里的播放器不参与广告判定：
    // 否则会把弹层里的「查看详情」当成商品卡，去点背后信息流的「下一条」箭头。
    if (D.isOverlayVideo(video)) return;

    // 抖音会把相邻视频预加载在 DOM 里，判错就会把正常视频切走。
    // 传进来的不是当前在播的那条时，改判在播的那条，并让本轮重新开始。
    const cur = D.playingVideo();
    if (cur && cur !== video) {
      video = cur;
      st.gen = -1;
    }
    if (D.isOverlayVideo(video)) return;

    // 换了视频就重置判定状态（用代次，不用 duration/src —— 它们经常是 Infinity/空串）
    if (D.gen !== st.gen) st = { gen: D.gen, passes: 0, blocked: false, last: 0 };

    const now = Date.now();
    if (now - st.last < 500) return;    // 同一视频短时间内别重复扫
    st.last = now;

    if (st.passes >= 5) return;         // 最多判 5 次：购物卡片有时比视频晚出现
    st.passes++;

    // 广告和直播是两个独立开关，谁开着就查谁
    let reason = enabled() ? detect(video) : '';
    if (!reason && liveEnabled()) reason = liveHit(video);
    D.log('filter: 检查', reason || '未命中');

    if (!reason) {
      liveStreak = 0;                   // 回到正常视频，连续直播计数清零
      if (st.passes < 5) setTimeout(() => judge(video), st.passes === 1 ? 900 : 1600);
      return;
    }

    if (!st.blocked) {
      st.blocked = true;
      D.log('filter: 识别到', reason, '，跳过该视频');
      if (liveStreak >= MAX_LIVE_STREAK) {
        liveStreak = 0;
        D.log('filter: 连续直播过多，暂停本次过滤');
        return;
      }
      if (reason.indexOf('直播') !== -1) liveStreak++;
      else liveStreak = 0;
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
    if (!enabled()) return;
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
    // 登录弹层的关闭按钮也不碰（部分版本没有 aria-label，只靠 class 命中）
    if (hit.closest('#login-full-panel, [id^="login-full-panel"]')) return;
    // 别去点正在播放的主播放器自己的按钮；新旧播放器容器都要判
    const mainBox = main ? main.closest('.xgplayer, .douyin-player') : null;
    const hitBox = hit.closest('.xgplayer, .douyin-player');
    if (mainBox && hitBox === mainBox) return;

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
    applySettings() {
      if (!enabled() && !liveEnabled()) {
        this.reset();
        return;
      }
      const v = D.playingVideo();
      if (v) judge(v);
    },
    probe() {
      const v = D.playingVideo();
      if (!v) return null;
      return {
        hit: detect(v) || null,
        live: liveEnabled() ? (liveHit(v) || null) : null,
        gen: D.gen,
        passes: st.passes,
        muted: v.muted,
        paused: v.paused
      };
    },
    reset() {
      st = { gen: -1, passes: 0, blocked: false, last: 0 };
      lastSkip = 0;
      lastScan = 0;
      liveStreak = 0;
    }
  };
})();
