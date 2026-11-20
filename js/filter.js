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
  // 游戏 / 应用推广（2026-10 真机实测）：抖音不给这类视频打广告标，
  // 而是在画面里挂平台自己的按钮组件 —— semi-button / semi-button-primary，
  // 文案固定是「点击预约 / 立即预约 / 立即下载 / 打开应用」，旁边配游戏名与 @官方号。
  // 这类按钮很短、尺寸小、就在画面内，误伤概率极低，所以单独命中即可跳过。
  const PROMO_CTA_RE = /^(点击预约|立即预约|预约下载|一键预约|立即下载|下载应用|打开应用|去下载)$/;

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
  // 连续跳过这么多条直播后先停一下，避免推荐流全是直播时无限切。
  // 原来只给 5 条，实测正常推荐流里连着六七条直播很常见，数到 5 就进 20 秒冷却，
  // 用户感受到的就是"忽然不跳了"。放宽到 15，并把冷却压到 10 秒。
  const MAX_LIVE_STREAK = 15;
  let liveStreak = 0;
  let liveCooldownUntil = 0;     // 直播冷却截止时间：冷却期内不再跳直播，也不重判
  // 抖音复用同一个 <video> 元素播放所有视频，判定状态不能挂在元素上：
  // 元素上的计数一旦用满、或已判成广告，后面所有视频都会被直接放过。
  // 也不能用 duration / currentSrc 当身份：抖音大量视频是 MSE 流，
  // duration 常为 Infinity、currentSrc 常为空串，所有这类视频会撞成同一个 key，
  // 判定次数攒满后整条推荐流都不再检查（历史 bug，表现为"广告从不跳"）。
  // 现在统一用 main.js 维护的代次 D.gen：每换一条视频 +1。
  let st = { gen: -1, passes: 0, blocked: false, last: 0, retryAt: 0, firstAt: 0, skipFail: 0, hitAt: 0 };
  let lastSkip = 0;
  // 复核定时器只保留一条链：媒体事件和看门狗都会调 judge，各自再排定时器的话，
  // 60 秒窗口内会叠出多条并行的扫描链，白白多耗 CPU。
  let judgeTimer = 0;
  // 命中但视频处于暂停状态时的"待跳"记录：暂停中不切走（暂停层里常带推荐 / 商品卡，
  // 切走会让用户觉得"暂停被取消"），但也不能像旧版那样直接放弃并永久 blocked。
  // 恢复播放后由 main.js 的 2 秒看门狗调用 retryPending() 补跳。
  let pendingSkip = null;

  // ---------- 判定诊断日志 ----------
  // 「该跳没跳」带随机性（容器晚到 / 布局瞬时异常 / 切条被手动操作打断），
  // 只靠现场重试很难抓到。这里把关键节点记进环形缓冲，用户在 popup 里
  // 一键复制，就能把当时的现场发回来，不用打开 DevTools。
  // 只记关键节点和"结构发生变化的未命中"，不记每一次扫描 ——
  // 单条视频 60 秒窗口内有 120 次扫描，全记会把有用记录挤掉。
  const DIAG_MAX = 600;
  let diag = [];
  let diagSeq = 0;
  let lastMissKey = '';

  function diagAdd(kind, data) {
    diag.push(Object.assign({ n: ++diagSeq, t: Date.now(), kind }, data || {}));
    if (diag.length > DIAG_MAX) diag.splice(0, diag.length - DIAG_MAX);
  }

  // 判定依赖的结构快照：视频尺寸、时长、是否在播、在播视频是否对得上、
  // 卡片里的 feed-live 容器尺寸、LivePlayer 容器是否存在。
  // 这些正是"第一次不跳、划回才跳"时最需要比对的东西。
  function snapOf(video) {
    const out = { gen: D.gen, passes: st.passes, blocked: st.blocked };
    if (!video || !video.getBoundingClientRect) return out;
    const vr = video.getBoundingClientRect();
    out.vw = Math.round(vr.width);
    out.vh = Math.round(vr.height);
    out.paused = video.paused;
    const d = video.duration;
    out.dur = d === Infinity ? 'inf' : (typeof d === 'number' && isFinite(d) ? Math.round(d * 10) / 10 : String(d));
    out.same = D.playingVideo() === video ? 1 : 0;
    out.livePlayer = video.closest(LIVE_PLAYER_SEL) ? 1 : 0;
    const card = video.closest('[data-e2e="feed-active-video"], [data-e2e="feed-item"]') || video.parentElement;
    out.live = [];
    if (card) {
      let n = 0;
      for (const el of card.querySelectorAll('[data-e2e="feed-live"]')) {
        if (++n > 5) break;
        const r = el.getBoundingClientRect();
        out.live.push(Math.round(r.width) + 'x' + Math.round(r.height));
      }
    }
    return out;
  }

  // ---------- 手动返回过的不再自动跳过 ----------
  // 需求：自动跳过的广告 / 直播，如果用户又手动滑回来了，说明他其实想看，
  // 之后遇到这一条不再跳，避免"感兴趣的内容被略过"。
  // 身份用视频 ID（data-e2e-vid），存 chrome.storage.local，最多保留 200 条。
  const NO_SKIP_KEY = 'dyc_noSkip';
  const NO_SKIP_VER_KEY = 'dyc_noSkipVer';
  // 名单判定规则换代：旧版会在每次判定里隐式比对身份，抖音切条后的回吸 /
  // 预加载旧 <video> 都会被当成"用户手动返回"，把大量直播和广告误拉黑，
  // 表现就是"刷着刷着直播再也不跳了"。换新规则时清掉旧名单（一次性）。
  const NO_SKIP_VER = 2;
  const NO_SKIP_MAX = 200;
  const respectBack = () => !D.settings || D.settings.respectBack !== false;
  let noSkip = new Set();
  let pendingBack = null;          // { vid, at, gen }：刚刚被自动跳过的那条
  let userBack = null;             // { vid, at }：用户确实手动滑回来的那条

  function saveNoSkip() {
    try {
      const list = Array.from(noSkip).slice(-NO_SKIP_MAX);
      noSkip = new Set(list);
      chrome.storage.local.set({ [NO_SKIP_KEY]: list });
    } catch (e) { /* 忽略 */ }
  }

  try {
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ [NO_SKIP_KEY]: [], [NO_SKIP_VER_KEY]: 0 }, res => {
        if ((res && res[NO_SKIP_VER_KEY] || 0) < NO_SKIP_VER) {
          noSkip = new Set();
          chrome.storage.local.set({ [NO_SKIP_KEY]: [], [NO_SKIP_VER_KEY]: NO_SKIP_VER });
          D.log('filter: 旧版"手动返回"名单不可信，已清空');
          return;
        }
        noSkip = new Set((res && res[NO_SKIP_KEY]) || []);
        D.log('filter: 已载入不再跳过的视频', noSkip.size, '条');
      });
    }
  } catch (e) { /* 忽略 */ }

  function vidOf(video) {
    if (!video) return '';
    const card = video.closest('[data-e2e="feed-item"], [data-e2e="feed-active-video"], .slider-video');
    if (card) {
      const own = card.getAttribute && card.getAttribute('data-e2e-vid');
      if (own) return own;
      const el = card.querySelector && card.querySelector('[data-e2e-vid]');
      const inner = el && el.getAttribute('data-e2e-vid');
      if (inner) return inner;
      // 真机实测（2026-11）：抖音已经不再给卡片写 data-e2e-vid，
      // 上面的两条恒为空，所以视频 / 广告都退回下面的链接与文案身份。
      if (card.querySelectorAll) {
        for (const a of card.querySelectorAll('a[href*="aweme_id="]')) {
          const m = /aweme_id=(\d{8,})/.exec(a.getAttribute('href') || '');
          if (m) return m[1];
        }
        for (const a of card.querySelectorAll('a[href*="/video/"]')) {
          const m = /\/video\/(\d{8,})/.exec(a.getAttribute('href') || '');
          if (m) return m[1];
        }
        const desc = card.querySelector('.video-info-detail, [data-e2e*="video-desc"], [data-e2e*="video-info"]');
        if (desc) {
          const t = String(desc.innerText || '').replace(/\s+/g, ' ').trim();
          if (t) return 'T:' + t.slice(0, 50);
        }
      }
    }
    // 直播卡片另外用作者名当身份（没有 aweme_id，标题和热度都会变）
    // 容器不在 video 祖先链上时（卡片重渲染后 feed-live 变成兄弟层），
    // 退到活动卡片里找，否则身份恒为空、「手动返回不再跳」对直播完全失效。
    let live = video.closest('[data-e2e="feed-live"]');
    if (!live) {
      const card = video.closest('[data-e2e="feed-active-video"], [data-e2e="feed-item"]');
      if (card) {
        for (const el of card.querySelectorAll('[data-e2e="feed-live"]')) {
          if (el.getBoundingClientRect().width > 200) { live = el; break; }
        }
      }
    }
    if (live) {
      const raw = String(live.innerText || '').replace(/\s+/g, ' ');
      const who = /@([^\s【]+)/.exec(raw);
      if (who) return 'L:' + who[1].slice(0, 40);
      const t = raw
        .replace(/连播|点击或按|进入直播间|直播中|直播已结束/g, '')
        .replace(/[\d.]+\s*[万亿]?/g, '')
        .trim();
      if (t) return 'L:' + t.slice(0, 60);
    }
    return '';
  }

  // 「手动返回」只在用户真的用手势往回滑时记录（向上滚轮 / ↑ / PageUp）。
  // 旧版还在 judge / next 里按身份隐式认定"用户回来了"，但抖音切条后的
  // scroll-snap 回吸、播放器预加载让旧 <video> 仍是 playingVideo 等情形，
  // 都会被误判成用户返回 —— 名单越攒越多，最后直播和广告全都不跳了。
  // 现在只有这里会写名单，并且要求代次确实变过（证明真的切走了）。
  const onManualBack = () => {
    if (!respectBack() || !pendingBack) return;
    // 只认"刚被扩展跳走、且马上滑回来"的那一条。以前 pendingBack 永不过期，
    // 几分钟后随手向上滚一次、正好滚回当时命中的那条，就会被永久拉黑 ——
    // 实测表现就是"广告、直播都不再判"，因为这个视频再也没进过判定。
    if (Date.now() - pendingBack.at > 6000) {
      pendingBack = null;
      return;
    }
    const want = pendingBack.vid;
    const genAt = pendingBack.gen;
    const at = pendingBack.at;
    setTimeout(() => {
      if (Date.now() - at > 6800) { pendingBack = null; return; }
      if (D.gen === genAt) return;             // 根本没切走，不算返回
      const v = D.playingVideo();
      const vid = v && vidOf(v);
      if (!vid || vid !== want) return;
      userBack = { vid, at: Date.now() };
      if (!noSkip.has(vid)) {
        noSkip.add(vid);
        saveNoSkip();
      }
      pendingBack = null;
      D.log('filter: 用户手动滑回，之后不再跳', vid);
      diagAdd('manual-back', { vid: vid.slice(0, 24) });
    }, 700);
  };
  window.addEventListener('wheel', e => { if (e.deltaY < 0) onManualBack(); }, true);
  window.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' || e.key === 'PageUp') onManualBack();
  }, true);

  // 「用户刚动过手」的标记：命中后是三段式切条（点箭头 -> 复核 -> 追加滚动），
  // 中间有几次 500ms 的排队复核。用户如果在这个空档自己滑了一下，
  // 排队的复核还会继续执行，观感就是"我手动操作了，它又自己跳"。
  // 所以只要检测到真实手势，就让排队中的切条放弃。
  let lastUserAct = 0;
  let lastDoneAt = 0;              // 上次切条成功的时刻
  const noteUserAct = () => { lastUserAct = Date.now(); };
  window.addEventListener('wheel', noteUserAct, { capture: true, passive: true });
  window.addEventListener('keydown', noteUserAct, true);
  window.addEventListener('touchstart', noteUserAct, { capture: true, passive: true });
  window.addEventListener('pointerdown', noteUserAct, true);

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

  // 被浮层自动隐藏的元素（css/content.css 用 opacity:0 + pointer-events:none 收起浮层，
  // 不改 display/visibility，所以 DOM 和尺寸都还在）。
  // 含义：商品卡 / 广告标识这类"结构强信号"即使看不见也仍然是广告，照判；
  // 但价格、购买按钮、"同款"话术这类纯文案弱信号被隐藏时不参与凑数，
  // 避免"看不见的推荐卡文案"把正常视频判成带货。
  const hiddenByOverlay = el => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    return parseFloat(cs.opacity || '1') < 0.15;
  };

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
      if (PRICE_RE.test(t) && t.length <= 12 && boxOk(220, 48)) { if (!hiddenByOverlay(el)) weak.add('价格'); continue; }

      // ④ 购买按钮（弱）：整块文字就是按钮文案
      if (SHOP_CTA_RE.test(t) && t.length <= 10 && boxOk(240, 56)) { if (!hiddenByOverlay(el)) weak.add('购买按钮'); continue; }

      // ④-2 游戏 / 应用推广按钮（强）：平台按钮组件固定文案，单独命中即可
      if (PROMO_CTA_RE.test(t) && boxOk(300, 64)) { out.strong = '推广按钮(' + t + ')'; return out; }

      // ⑤ 营销话术（弱）：标题 / 简介里也常写"同款"，所以排除信息块，且必须另有一条弱信号
      if (!inInfoBox(el) && MARKETING_RE.test(t) && t.length <= 20 && boxOk(300, 60)) {
        if (!hiddenByOverlay(el)) weak.add('营销话术');
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
    // ① 作者名本身就是店铺名：抖音的昵称节点是 data-e2e="feed-video-nickname"，
    //    比遍历 a[href*="/user/"] 的文本可靠得多（头像链接的文本常常是空的）。
    const nick = root.querySelector('[data-e2e="feed-video-nickname"], .account-name');
    const nt = nick ? D.textOf(nick).replace(/^@/, '') : '';
    if (nt && nt.length <= 20 && SHOP_NAME_RE.test(nt)) return '店铺账号';
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

  // 作者名右侧的「广告」标识：抖音官方标注。
  // 真机实测（2026-10）是 .account 里紧跟昵称的一个 svg：
  //   <svg width="30" height="16" viewBox="0 0 30 16" style="margin-left:4px">
  //     <rect rx="2" fill-opacity=".08"/> + 两个字形 path
  // 没有 aria-label、没有 class，只能靠 viewBox + 尺寸 + 与昵称同行来认。
  // 这是最权威的"这是广告"信号，命中即跳过；认证 / 蓝V 图标有 class 或 aria，
  // 这里显式排除，避免把蓝V 视频全部误跳。
  function adBadgeHit(card) {
    if (!card || !card.querySelectorAll) return '';
    const nick = card.querySelector('[data-e2e="feed-video-nickname"], .account-name');
    if (!nick) return '';
    const box = nick.closest('.account') || nick.parentElement;
    if (!box) return '';
    const nr = nick.getBoundingClientRect();
    let n = 0;
    for (const svg of box.querySelectorAll('svg')) {
      if (++n > 4) break;
      const r = svg.getBoundingClientRect();
      if (r.width < 20 || r.width > 40 || r.height < 10 || r.height > 22) continue;
      const cls = String(svg.getAttribute('class') || '');
      if (/verify|official|cert|auth/i.test(cls)) continue;
      const vb = svg.getAttribute('viewBox') || '';
      if (vb === '0 0 30 16' && Math.abs(r.top - nr.top) <= 14) return '广告标识';
    }
    // 兜底：另一版不是 svg，而是昵称右侧一个写着「广告」的小标签（红底白字，实测宽约 30）。
    // 只认文本完全等于「广告」、尺寸很小、且与昵称同一行 —— 标题正文里的"广告"两个字
    // 文本更长，不会被这里命中。
    // 先查昵称所在容器，再退到它的父级（不同版本的标签挂载层级不一样）。
    for (const scope of [box, box.parentElement]) {
      if (!scope || !scope.querySelectorAll) continue;
      let k = 0;
      for (const el of scope.querySelectorAll('span, div, i, button')) {
        if (++k > 200) break;
        if (D.textOf(el) !== '广告') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 10 || r.width > 70) continue;
        if (r.height < 8 || r.height > 28) continue;
        if (Math.abs(r.top - nr.top) > 16) continue;
        return '广告标识';
      }
    }
    return '';
  }

  // 电商推广浮层的固定文案（"不容错过的优品 / 商品好评率"）。
  // 这类浮层不一定带 shop-anchor 类名，但文案是抖音电商组件固定的，可作为兜底。
  function promoOverlayHit(card) {
    if (!card || !card.querySelectorAll) return '';
    // ① 抖音电商素材图：图片托管在电商专属 CDN（p3-aio.ecombdimg.com / ecom-shop-material），
    //    普通视频不会用这个域名，所以这是比文案更稳的信号。
    if (card.querySelector('img[src*="ecombdimg"], img[src*="ecom-shop-material"]')) return '电商浮层';
    // ② 兜底：电商浮层的固定文案
    let n = 0;
    for (const el of card.querySelectorAll('span, div')) {
      if (++n > 400) break;
      const t = D.textOf(el);
      if (!t || t.length > 80) continue;
      if (t.indexOf('不容错过的优品') >= 0 || t.indexOf('商品好评率') >= 0) return '推广浮层';
    }
    return '';
  }

  function detect(video) {
    const vr = video.getBoundingClientRect();
    const card = cardOf(video);

    // 0) 手动屏蔽规则（你自己按 Alt+Shift+X 标记过的话题 / 作者），优先级最高
    const manual = (D.rules && D.rules.match) ? D.rules.match(card) : '';
    if (manual) return manual;

    // 0-2) 官方「广告」标识：作者名旁的小 svg，最权威，命中即判
    let hit = adBadgeHit(card);
    if (hit) return hit;

    // 1) 容器语义最稳：商品卡容器 / 广告属性
    hit = shopAnchorHit(card, vr) || attrHit(card);
    if (hit) return hit;

    // 1-2) 电商推广浮层的固定文案
    hit = promoOverlayHit(card);
    if (hit) return hit;

    // 2) 文本信号：强信号直接判；弱信号要凑够两条不同种类
    const s = textSignals(card, vr);
    if (s.strong) return s.strong;
    if (s.weak.length >= 2) return '带货(' + s.weak.join('+') + ')';

    // 3) 店铺账号：只凭昵称（旗舰店 / 专卖店 / 专营店 / 小店）不足以判定带货 ——
    //    商家号发日常内容很常见，实测「爱悦享成人用品专营店」发的健身视频
    //    被整条误跳。现在要求同时已经出现一条弱带货信号（价格 / 购买按钮 / 营销话术）
    //    才把它当第二条证据。
    if (s.weak.length >= 1) {
      hit = shopAuthorHit(card, vr);
      if (hit) return '带货(店铺账号+' + s.weak.join('+') + ')';
    }

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

    // 1) 播放器根节点本身就是直播播放器 / 直播聊天室。
    // 但抖音会在普通视频之间复用 LivePlayer_* 容器（PreCreatePlayer / Preview），
    // 只按类名判会把「刚从直播间滑出来的那条普通视频」整条误跳 ——
    // 用户看到的就是"误判，跳过了上一条视频"。
    // 补两条独立佐证：容器要把视频画面盖住，且视频时长是 Infinity（直播流特征；
    // 普通视频是有限时长，实测 15.6 / 333.0 这类）。未起播的直播由 4.5 段兜底。
    if (livePlayer && visibleBox(livePlayer)) {
      const lr = livePlayer.getBoundingClientRect();
      const vr1 = video.getBoundingClientRect();
      // 高度门槛别省：预创建容器的视频是 0×0，退化成 "0 >= 0" 会一路通过。
      const covers = vr1.width > 300 && vr1.height > 200 &&
        lr.width >= vr1.width * 0.8 && lr.height >= vr1.height * 0.6;
      if (covers && video.duration === Infinity) return '直播(直播播放器)';
    }

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

    // 4.5) feed-live 容器：抖音现在大量直播间用它，旧的 LIVE_MARK_SEL 认不到。
    //
    // 早期要求它必须包住 video（video.closest），但卡片重渲染时 feed-live
    // 经常是后来才插进来的兄弟层或更外层的包裹，closest 会落空 ——
    // 表现就是"有的直播跳、有的不跳"。现在改成在整张活动卡片里找，
    // 再用「矩形覆盖住视频区域」和尺寸把内嵌小窗排除掉（小窗固定 337×189）。
    const liveCard = card || video.parentElement;
    if (liveCard) {
      const vr = video.getBoundingClientRect();
      for (const el of liveCard.querySelectorAll('[data-e2e="feed-live"]')) {
        if (!visibleBox(el)) continue;
        const fr = el.getBoundingClientRect();
        // 内嵌直播小窗实测 337×189，用它自己的尺寸就能排除；
        // 这里绝不能拿「视频宽度 > 700」当判据 —— 桌面端正常视频都超过 700，
        // 只要卡片里挂了小窗就会把普通视频整条判成直播跳掉。
        if (fr.width < 500 || fr.height < 300) continue;
        // 容器必须在视口内（卡片容器里可能带着预加载、在屏幕外的直播卡片）
        if (fr.right < 0 || fr.left > window.innerWidth) continue;
        const ox = Math.min(fr.right, vr.right) - Math.max(fr.left, vr.left);
        const oy = Math.min(fr.bottom, vr.bottom) - Math.max(fr.top, vr.top);
        if (vr.width > 0 && vr.height > 0) {
          // 盖住视频画面的大部分才算直播间（小窗只占右下角一小块）
          if (ox > vr.width * 0.6 && oy > vr.height * 0.5) return '直播(全屏直播)';
        } else if (ox > fr.width * 0.6 && oy > fr.height * 0.4) {
          // 视频还没出画面（刚滚到这一条）时退回按容器自身算
          return '直播(全屏直播)';
        }
      }
    }

    // 5) 「直播中 / 正在直播 / 进入直播间」文字与头像直播圈不参与判定：
    //    那只能说明作者正在直播，当前视频仍可能是普通视频。
    return '';
  }

  // 切下一条。三段式：尝试 -> 复核 -> 升级；三次都失败时不再永久放弃。
  // 旧版的 bug：第三次尝试后直接 return，而 blocked 已经置 true，
  // 于是一条"点不动"的视频会一直播到用户手动划走，所有后续判定都被 blocked 挡掉。
  // 第三层也不再发合成 KeyboardEvent：isTrusted=false，抖音的事件委托不接受，等于没有兜底。
  const SWITCH_TRIES = 3;
  const SWITCH_RECHECK = 400;        // 每次尝试后多久复核（抖音换片通常在几百毫秒内完成）
  const SWITCH_MIN_GAP = 500;        // 两次切条之间的最小间隔
  const SWITCH_RETRY_DELAY = 1000;   // 三次都失败后隔多久重新判定

  // 找承载信息流的可滚动容器（抖音是 scroll-snap，滚一屏会吸附到下一条）
  function scrollTarget(video) {
    let node = video && video.parentElement;
    while (node && node !== document.body) {
      const cs = getComputedStyle(node);
      if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 50) return node;
      node = node.parentElement;
    }
    return null;
  }

  // 离当前视频最近、且可见的"下一条"箭头。页面上可能同时存在多个（含隐藏 /
  // 旧卡片里的），以前用 querySelector 取第一个经常会点到别的容器 ——
  // 实测就是"连点三次都没切走"。
  // 不能再按"距视频左右 260px"筛：评论面板打开时视频只有 1414 宽，
  // 而箭头在 x≈1996（贴着评论面板左侧），距离 580px，会被整批排除。
  function nearestArrow(video) {
    const vr = video.getBoundingClientRect();
    let best = null;
    let bestD = Infinity;
    let n = 0;
    for (const a of document.querySelectorAll(D.SEL.nextArrow)) {
      if (++n > 8) break;
      const r = a.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (r.right <= 0 || r.left >= window.innerWidth) continue;      // 必须在视口内
      const d = Math.abs((r.top + r.bottom) / 2 - (vr.top + vr.bottom) / 2);
      if (d > Math.max(vr.height, 240)) continue;                     // 垂直方向大致同一屏
      if (d < bestD) { bestD = d; best = a; }
    }
    return best;
  }

  // 合成 click 有时不触发抖音的 React 处理，补齐完整指针序列再补一次 click。
  function clickReal(el) {
    const r = el.getBoundingClientRect();
    const opt = {
      bubbles: true, cancelable: true, composed: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      button: 0, buttons: 1, pointerId: 1, isPrimary: true, pointerType: 'mouse'
    };
    try {
      el.dispatchEvent(new PointerEvent('pointerover', opt));
      el.dispatchEvent(new PointerEvent('pointerenter', opt));
      el.dispatchEvent(new PointerEvent('pointerdown', opt));
      el.dispatchEvent(new MouseEvent('mousedown', opt));
      el.dispatchEvent(new PointerEvent('pointerup', { ...opt, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('mouseup', { ...opt, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('click', { ...opt, buttons: 0 }));
    } catch (e) {
      try { el.click(); } catch (e2) { /* 忽略 */ }
    }
  }

  function switchAttempt(video, i) {
    // 1) 原生"下一条"箭头：和用户点一样走抖音自己的能力。
    //    第 1、3 次都点箭头，中间夹一次滚动 —— 两种路径都试到，且不同时触发，
    //    避免"点了箭头又滚一屏"一次跳过两条。
    if (i !== 1 && i !== 2) {
      const arrow = nearestArrow(video);
      if (arrow) {
        clickReal(arrow);
        return;
      }
    }
    // 2) 滚动容器滚一屏；第二次多滚 30%，防止 scroll-snap 又吸回原位
    if (i === 1) {
      const node = scrollTarget(video);
      if (node) {
        try { node.scrollBy({ top: node.clientHeight * 1.3, behavior: 'auto' }); } catch (e) { /* 忽略 */ }
        return;
      }
      try { window.scrollBy({ top: window.innerHeight * 1.3, behavior: 'auto' }); } catch (e) { /* 忽略 */ }
      return;
    }
    // 3) 键盘：抖音网页版支持 ↓ / PageDown 切下一条，容器找不到时用它兜底
    try {
      const ke = { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true, cancelable: true };
      (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', ke));
      (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keyup', { ...ke, keyCode: 0 }));
    } catch (e) { /* 忽略 */ }
    const node = scrollTarget(video);
    if (node) {
      try { node.scrollBy({ top: node.clientHeight, behavior: 'auto' }); } catch (e) { /* 忽略 */ }
    }
  }

  // 三次都没切走：清掉 blocked，隔 4 秒重新判定一次（不再永久锁死）。
  // 同一条视频连续失败 3 轮就停手，避免在"暂停 + 箭头点不动"的场景里每 4 秒反复点一次。
  function giveUpSwitch(video, genAt) {
    if (!video || !video.isConnected) return;
    if (D.gen !== genAt) return;
    st.skipFail = (st.skipFail || 0) + 1;
    diagAdd('giveup', { fails: st.skipFail });
    if (st.skipFail >= 3) {
      st.blocked = false;
      D.log('filter: 本条连续切条失败 ' + st.skipFail + ' 轮，先停手（换片后重试）');
      return;
    }
    st.blocked = false;
    st.passes = 0;
    st.retryAt = Date.now() + SWITCH_RETRY_DELAY;
    D.log('filter: 三次切条失败，' + SWITCH_RETRY_DELAY / 1000 + ' 秒后重试');
    setTimeout(() => {
      if (!video.isConnected || document.hidden) return;
      if (D.gen === genAt) judge(video);
    }, SWITCH_RETRY_DELAY);
  }

  // 只有"强信号"命中的广告才允许在暂停状态下也直接跳：
  // 购物卡片容器 / 官方广告标识 / 电商浮层 / 推广按钮，都是平台结构或固定文案，
  // 不属于暂停层里"相关推荐"那种模棱两可的内容。
  // 弱信号（靠价格 / 购买按钮 / 营销话术凑两条）在暂停时容易误判，仍然等恢复播放再判。
  const STRONG_HIT_RE = /^(购物卡片|广告标识|电商浮层|推广浮层|推广按钮|手动屏蔽|ad)/;

  function next(video, force) {
    // 双保险：用户刚用手势滑回这一条时，之前排队的跳转定时器仍可能打到这儿，
    // 绕过 judge 里的检查。真正切条前再确认一次，命中就放弃本次跳过。
    if (respectBack() && video) {
      const vid = vidOf(video);
      if (vid && noSkip.has(vid)) return;
      if (vid && userBack && userBack.vid === vid && Date.now() - userBack.at < 3000) return;
    }

    // 用户暂停了就别跳：暂停状态下切走视频，观感就是"暂停被取消并划到下一条"。
    // force=true 表示命中的是强信号，允许在暂停状态直接切（否则广告会一直钉在暂停画面上）。
    if (video && video.paused && !force) return;
    // 选择器自检失败时不做破坏性动作，只保留纯视觉改动
    if (D.safeMode === true) { D.log('filter: 安全模式，本次不跳视频'); return; }
    const now = Date.now();
    // 节流不能静默放弃：连续两条广告时，上一条刚跳完 1.2 秒内的这条会被直接丢掉，
    // 而 blocked 已置真，于是"永远不再跳"。改成到点重试。
    if (now - lastSkip < SWITCH_MIN_GAP) {
      const wait = SWITCH_MIN_GAP - (now - lastSkip);
      st.blocked = false;
      D.log('filter: 切条节流，' + wait + 'ms 后重试');
      setTimeout(() => {
        if (video && video.isConnected && D.gen === st.gen) judge(video);
      }, wait);
      return;
    }
    lastSkip = now;

    // 记下这一条的身份，但**先不登记**：只有确认真切走了才登记。
    // 命中即登记的话，切条失败 / 被手动操作打断都会留下一条记录，
    // 之后用户随手向上滚一下就可能被误记进"不再跳过"名单。
    const skipVid = respectBack() ? vidOf(video) : '';

    // 暂停态下抖音的"下一条"箭头是隐藏的、滚动容器也不响应 ——
    // 实测强信号命中后连点三次都没切走。强信号本来就要跳，先恢复播放让切条通道可用。
    if (video && video.paused && force) {
      try {
        const p = video.play();
        if (p && p.catch) p.catch(() => { /* 自动播放被拒时忽略 */ });
      } catch (e) { /* 忽略 */ }
    }

    const genAt = D.gen;
    const step = i => {
      if (!video || !video.isConnected) return;
      switchAttempt(video, i);
      diagAdd('switch', { i, gen: genAt });
      setTimeout(() => {
        if (!video || !video.isConnected || document.hidden) {
          diagAdd('abort', { why: 'gone', i });
          return;
        }
        if (D.gen !== genAt) {
          // 确认真的切走了，才登记"刚被跳过的那条"：用户 6 秒内滑回来才进名单
          if (skipVid) pendingBack = { vid: skipVid, at: Date.now(), gen: D.gen };
          lastDoneAt = Date.now();
          diagAdd('done', { i, use: 'gen' });
          return;                                 // 代次变了 = 真的切走了
        }
        // 用户在这段排队空档里正在连续操作（滚轮还在滚 / 手指没离开）：收手。
        // 必须同时解锁，否则命中后的 blocked 会一直卡到换片。
        // 窗口只要 250ms —— 之前是 900ms，导致"自己划到直播条"也会被当成
        // 用户干预而放弃，硬生生多等 1.2 秒才重试，这就是"第一次跳得慢"。
        if (Date.now() - lastUserAct < 250) {
          D.log('filter: 用户正在操作，放弃本次切条');
          st.blocked = false;
          st.retryAt = Date.now() + 600;
          // 必须自己排下一次：播放态下没有别的入口会再调 judge，
          // 只设 retryAt 等于把这条永久搁置（实测"广告一直不跳"就是这个）。
          clearTimeout(judgeTimer);
          judgeTimer = setTimeout(() => judge(video), 600);
          diagAdd('abort', { why: 'user-act', i });
          return;
        }
        // 换片动画进行中代次可能还没更新，但旧视频已经滚出视口 → 也认为切走了，
        // 否则会在动画中途再滚一屏，一次跳过两条。
        // 但如果是布局瞬时塌成 0（直播/长图卡片偶发），同样要解锁，否则卡死到换片。
        if (D.visibleArea(video) < 10000) {
          diagAdd('abort', { why: 'offscreen', i, area: D.visibleArea(video) });
          st.blocked = false;
          st.retryAt = Date.now() + 1500;
          clearTimeout(judgeTimer);
          judgeTimer = setTimeout(() => judge(video), 1500);
          return;
        }
        if (i + 1 < SWITCH_TRIES) step(i + 1);
        else giveUpSwitch(video, genAt);
      }, SWITCH_RECHECK);
    };
    step(0);
  }

  // 把最近一次判定结果写到 DOM 上：不打开调试、不进隔离世界，也能从外部
  // 一眼看到"当前这条被判成了什么"，排查误判/漏判时最省事（每次判定最多写一次）。
  function publish(reason, cost) {
    try {
      document.documentElement.setAttribute('data-dyc-judge', JSON.stringify({
        gen: D.gen,
        reason: reason || null,
        passes: st.passes,
        blocked: st.blocked,
        cost: cost == null ? null : cost,
        ts: Date.now()
      }));
    } catch (e) { /* 忽略 */ }
  }

  function judge(video) {
    if (!(video instanceof HTMLVideoElement)) return;
    if (!enabled() && !liveEnabled()) return;
    if (!D.route.feed) return;
    if (!video.isConnected) return;
    // 刚切走 1.5 秒内不再判：切换动画期间旧直播容器还挂在 DOM 上，
    // 新视频会被再判一次"直播"，于是重复切条甚至切三次后放弃（实测）。
    if (Date.now() - lastDoneAt < 1500) return;
    // 暂停时不再直接放弃判定：暂停层里确实可能有"相关推荐 / 商品卡"，
    // 所以暂停期间命中只登记待跳（pendingSkip），等恢复播放后再重判一次才跳。
    // 旧版这里直接 return，命中过的那条广告恢复播放时也不会再跳（blocked 已锁死）。
    // 聊天页 / 私信抽屉 / 好友分享弹层里的播放器不参与广告判定：
    // 否则会把弹层里的「查看详情」当成商品卡，去点背后信息流的「下一条」箭头。
    if (D.isOverlayVideo(video)) return;

    // 抖音会把相邻视频预加载在 DOM 里，判错就会把正常视频切走。
    // 传进来的不是当前在播的那条时，改判在播的那条，并让本轮重新开始。
    const cur = D.playingVideo();
    if (cur && cur !== video) {
      // 记录"判定对象被换成在播视频"：这条如果频繁出现，说明传进来的
      // 一直是预加载 / 旧卡片，真实在播的那条反而没被检查。
      diagAdd('redirect', { gen: D.gen, fromPaused: video.paused });
      video = cur;
      // 注意：这里不要清 st。同一代次内播放器重建（换清晰度 / 元素复用）很常见，
      // 一清就会把刚生效的 blocked 一起抹掉，变成"命中 → 再切一次 → 被放弃"的循环，
      // 实测会把首次跳过从 1 秒拖到 2 秒以上。换片由下面的 D.gen 判断负责。
    }
    if (D.isOverlayVideo(video)) return;

    // 用户手动滑回来过的视频：尊重他的意愿，不再自动跳过。
    // 名单只由 onManualBack（真实手势）写入，这里只读，不再按身份隐式认定。
    if (respectBack()) {
      const vid = vidOf(video);
      if (vid) {
        if (noSkip.has(vid)) {
          publish('手动返回过，不再跳过', 0);
          diagAdd('no-skip', { vid: vid.slice(0, 24) });
          return;
        }
        if (userBack && userBack.vid === vid && Date.now() - userBack.at < 3000) {
          publish('用户刚滑回，暂不跳过', 0);
          return;
        }
      }
    }

    // 换了视频就重置判定状态（用代次，不用 duration/src —— 它们经常是 Infinity/空串）
    if (D.gen !== st.gen) {
      clearTimeout(judgeTimer);
      st = { gen: D.gen, passes: 0, blocked: false, last: 0, retryAt: 0, firstAt: 0, skipFail: 0, hitAt: 0 };
    }

    const now = Date.now();
    if (!st.firstAt) st.firstAt = now;
    if (now < st.retryAt) {
      // 放弃切条后设了冷却，但不能只靠外部事件再唤醒：播放态下看门狗不调 judge，
      // 到点没人来，这条就永久不判了。这里自己排一次。
      clearTimeout(judgeTimer);
      judgeTimer = setTimeout(() => judge(video), Math.max(100, st.retryAt - now + 50));
      return;
    }
    if (now - st.last < 200) return;    // 同一视频短时间内别重复扫
    st.last = now;

    // 判定窗口按"时间"而不是"次数"：loadedmetadata / playing / emptied / 2 秒看门狗
    // 都会触发判定，按次数上限会在 2~3 秒内被耗光，导致播放中段才出现的推广浮层永远没机会被看到。
    // 只按时间窗判定，不再限制次数：直播容器经常比 video 晚一两秒才插进来，
    // 原来 12 次（约 4~10 秒）用完就停，正好卡在"容器还没出现"的缝里，
    // 表现为时灵时不灵。
    // 播放态原来只给 12 秒，超过后这条视频再也不查 —— 直播卡片有时要等播放器
    // 初始化、切流完成后才挂上 feed-live 容器，超过 12 秒就彻底漏掉。
    // 现在播放 / 暂停统一给 60 秒：前 12 秒高频（450/800ms），之后降到 2 秒一次。
    const win = 60000;
    if (now - st.firstAt > win) {
      // 窗口用完后不能彻底停判：直播容器、商品卡经常在停留很久之后才挂上来
      // （抖音自动连播时不换代次），彻底停就等于永远不跳。
      // 改成低频续判（3 秒一次），开销可以忽略。
      if (!st.winLogged) {
        st.winLogged = true;
        diagAdd('window-end', snapOf(video));
      }
      clearTimeout(judgeTimer);
      judgeTimer = setTimeout(() => judge(video), 3000);
      return;
    }
    st.passes++;

    // 广告和直播是两个独立开关，谁开着就查谁
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    let reason = enabled() ? detect(video) : '';
    if (!reason && liveEnabled()) reason = liveHit(video);
    const cost = t0 ? Math.round(performance.now() - t0) : null;
    D.log('filter: 检查', reason || '未命中', cost == null ? '' : cost + 'ms');
    publish(reason, cost);

    if (!reason) {
      liveStreak = 0;                   // 回到正常视频，连续直播计数清零
      liveCooldownUntil = 0;
      // 未命中也留痕：只在结构变化（尺寸 / 时长 / 容器 / 是否在播 / 判定对象是否对得上）
      // 或每 2 秒一次时记录，避免 250ms 一次的扫描把环形缓冲刷满。
      const snap = snapOf(video);
      const key = [snap.vw, snap.vh, snap.dur, snap.paused, snap.same, snap.livePlayer, snap.live.join(',')].join('|');
      if (key !== lastMissKey || now - (diag.length ? diag[diag.length - 1].t : 0) > 2000) {
        lastMissKey = key;
        diagAdd('miss', Object.assign({ cost, en: enabled() ? 1 : 0, lv: liveEnabled() ? 1 : 0 }, snap));
      }
      // 命中后如果最终没切走（容器消失 / 误判），blocked 会一直锁到换片，
      // 这条视频之后就再也不会被检查。给一个 3 秒的释放窗口。
      if (st.blocked && Date.now() - (st.hitAt || 0) > 3000) st.blocked = false;
      // 前几次用短间隔（商品卡 / 直播容器常比视频晚一拍），之后每 0.5 秒复核，
      // 12 秒后降到 1 秒一次，直到 60 秒窗口结束。单次扫描只有几毫秒。
      const age = Date.now() - st.firstAt;
      clearTimeout(judgeTimer);
      judgeTimer = setTimeout(() => judge(video), age < 12000 ? (st.passes <= 3 ? 250 : 500) : 1000);
      return;
    }

    // 命中后不重复操作，但不能永久锁死：切条可能被手动操作 / 布局瞬时异常打断，
    // 一旦这里一直 return，这条视频会卡到用户手动划走（代次变化）才会重判 ——
    // 表现就是"第一次没跳，划走再划回来才跳"。给 2.5 秒自动解锁。
    if (st.blocked) {
      if (Date.now() - (st.hitAt || 0) < 2500) return;
      st.blocked = false;
      diagAdd('unblock', { reason, waited: Date.now() - (st.hitAt || 0) });
    }
    st.blocked = true;
    st.hitAt = Date.now();
    D.log('filter: 识别到', reason, '，跳过该视频');
    diagAdd('hit', Object.assign({ reason, cost, paused: video.paused }, snapOf(video)));

    // 连续直播过多时短暂冷却，避免推荐流整屏都是直播时无限快速切条。
    // 冷却从 20 秒压到 10 秒：原来只要连着遇到 5 条直播就会停 20 秒，
    // 用户体感就是"直播忽然不跳了"。
    if (reason.indexOf('直播') !== -1) {
      if (Date.now() < liveCooldownUntil) {
        D.log('filter: 直播冷却中，暂不跳');
        diagAdd('cooldown', { left: liveCooldownUntil - Date.now(), streak: liveStreak });
        return;
      }
      liveStreak++;
      if (liveStreak >= MAX_LIVE_STREAK) {
        liveStreak = 0;
        liveCooldownUntil = Date.now() + 10000;
        D.log('filter: 连续直播过多，暂停 10 秒');
        diagAdd('cooldown-start', { ms: 10000 });
        return;
      }
    } else {
      liveStreak = 0;
      liveCooldownUntil = 0;
    }

    // 命中时视频可能正处于暂停（失焦自动暂停 / 用户手动暂停 / 抖音暂停层）。
    // 强信号（购物卡、官方广告标、电商浮层、推广按钮）直接切，
    // 否则广告会一直钉在暂停画面上；弱信号先登记，等恢复播放后重判再切。
    //
    // 直播也算强信号：直播卡片的 <video> 在拉流 / 初始化阶段经常就是 paused，
    // 自动播放被浏览器策略拦住、失焦暂停也会让它一直停着，
    // 等"恢复播放再跳"往往永远等不到 —— 表现就是直播停在那儿不跳。
    const strong = STRONG_HIT_RE.test(reason) || reason.indexOf('直播') !== -1;
    if (video.paused && !strong) {
      pendingSkip = { gen: D.gen, reason, at: Date.now(), video };
      D.log('filter: 弱信号命中但视频暂停，登记待跳', reason);
      diagAdd('pending', { reason });
      return;
    }
    next(video, strong);
  }

  // 看门狗每 2 秒调用一次：视频恢复播放后补跳之前命中的广告（最多等 60 秒）。
  function retryPending() {
    if (!pendingSkip) return;
    if (D.gen !== pendingSkip.gen || !pendingSkip.video || !pendingSkip.video.isConnected) {
      pendingSkip = null;
      return;
    }
    if (Date.now() - pendingSkip.at > 60000) {
      D.log('filter: 待跳记录超时，放弃');
      pendingSkip = null;
      return;
    }
    const v = pendingSkip.video;
    if (v.paused) return;
    const p = pendingSkip;
    pendingSkip = null;
    // 暂停期间的判定可能被"暂停层里的推荐 / 商品卡"干扰，所以恢复播放后
    // 重置判定窗口、重新判一次，确认还是广告才跳。
    st.blocked = false;
    st.passes = 0;
    st.firstAt = Date.now();
    st.last = 0;
    D.log('filter: 视频恢复播放，重新判定', p.reason);
    judge(v);
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

  // ---------- 头像旁直播小窗：结构快照 ----------
  // 这种小窗只显示几秒就自动消失，等开发者来看时早就没了。
  // 这里在它出现的那一刻把结构记进诊断日志（popup 一键复制），
  // 之后按真实结构补关闭逻辑，不用再靠猜。
  const POPUP_SEL = '[class*="live" i], [data-e2e*="live" i], [class*="preview" i], [class*="float" i], canvas, iframe';
  const popupSeen = new Map();          // 结构签名 -> 最近一次记录时间
  let popupScanAt = 0;

  function popupChainOf(el) {
    const chain = [];
    let node = el;
    for (let i = 0; i < 5 && node && node !== document.body; i++, node = node.parentElement) {
      const cls = String(node.className || '').trim().split(/\s+/).slice(0, 2).filter(Boolean).join('.');
      const e2e = node.getAttribute('data-e2e') || '';
      chain.push(node.tagName + (cls ? '.' + cls : '') + (e2e ? '[' + e2e + ']' : ''));
    }
    return chain;
  }

  // 只扫"画面右侧、小尺寸、可见"的节点，并限制候选数量；
  // 同一结构 10 秒内只记一次，避免小窗常驻时把日志刷满。
  function scanLivePopups(main) {
    const now = Date.now();
    if (now - popupScanAt < 900) return;
    popupScanAt = now;
    let n = 0;
    for (const el of document.querySelectorAll(POPUP_SEL)) {
      if (++n > 60) break;
      if (main && (el === main || el.contains(main) || main.contains(el))) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.width > 380) continue;
      if (r.height < 60 || r.height > 480) continue;
      if (r.left < window.innerWidth * 0.55) continue;    // 头像旁 / 画面右侧
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') < 0.1) continue;
      const sig = el.tagName + '|' + String(el.className || '').slice(0, 50) + '|' +
        Math.round(r.width) + 'x' + Math.round(r.height);
      if (now - (popupSeen.get(sig) || 0) < 10000) continue;
      popupSeen.set(sig, now);
      if (popupSeen.size > 60) {
        for (const [k, t] of popupSeen) if (now - t > 60000) popupSeen.delete(k);
      }
      diagAdd('live-popup', {
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        tag: el.tagName,
        txt: D.textOf(el).slice(0, 60),
        v: el.querySelector('video') ? 1 : 0,
        img: el.querySelector('img') ? 1 : 0,
        cv: el.querySelector('canvas') ? 1 : 0,
        ifr: el.querySelector('iframe') ? 1 : 0,
        btn: closeBtnIn(el.parentElement || el) ? 1 : 0,
        chain: popupChainOf(el)
      });
    }
  }

  // 头像旁 / 右侧的直播预览小窗（实测 166×296）：只显示几秒，露着干扰观看。
  // 这类小窗不能当成"当前视频是直播"去跳过（那会误伤正常视频），
  // 所以单独处理：直接隐藏，并把结构记进诊断日志备查。
  // 只认 [data-e2e="feed-live"] 且小尺寸，全屏直播（1980×871）不受影响。
  let miniScanAt = 0;
  let miniHidden = [];
  let miniDiagAt = 0;

  // 小窗一插进 DOM 就标记，不等 1 秒轮询 —— 否则会先露出来几百毫秒再消失，
  // 这段时间正好压住右侧互动栏，鼠标移上去不出点赞/评论。
  function markMiniNow(el) {
    if (!el || el.nodeType !== 1 || !el.matches) return;
    if (!el.matches('[data-e2e="feed-live"]')) return;
    requestAnimationFrame(() => {
      if (!el.isConnected || el.hasAttribute('data-dyc-mini-hide')) return;
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.width > 420) return;
      if (r.height < 60 || r.height > 640) return;
      el.setAttribute('data-dyc-mini-hide', '');
      miniHidden.push(el);
      // 外层白框同样要收，否则会剩一圈白底 + 右上角的 ×
      const box = miniBoxOf(el);
      if (box) {
        closeMiniBox(box);
        box.setAttribute('data-dyc-mini-hide', '');
        miniHidden.push(box);
      }
      diagAdd('live-mini-hide', {
        why: 'observer',
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        box: box ? [Math.round(box.getBoundingClientRect().width), Math.round(box.getBoundingClientRect().height)] : null,
        chain: popupChainOf(el)
      });
    });
  }

  const miniMo = new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type !== 'childList' || !m.addedNodes.length) continue;
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches('[data-e2e="feed-live"]')) markMiniNow(node);
        else if (node.querySelector) {
          const inner = node.querySelector('[data-e2e="feed-live"]');
          if (inner) markMiniNow(inner);
        }
      }
    }
  });
  miniMo.observe(document.documentElement, { childList: true, subtree: true });

  // 小窗外面那层卡片（白底 + 右上角关闭按钮）。内层 feed-live 透明后，
  // 这层白框仍会留在画面上，所以必须一起处理。
  // 实测这层自己 background 是透明的（白色来自伪元素 / 内层装饰），
  // 所以不能按背景色判断，只能按"比小窗略大、紧包着它"来认。
  function miniBoxOf(el) {
    const er = el.getBoundingClientRect();
    let node = el.parentElement;
    for (let i = 0; i < 3 && node && node !== document.body; i++, node = node.parentElement) {
      const r = node.getBoundingClientRect();
      if (r.width < er.width - 2 || r.width > er.width + 90) continue;
      if (r.height < er.height - 2 || r.height > er.height + 110) continue;
      if (r.width < 80 || r.height < 80) continue;
      return node;
    }
    return null;
  }

  // 优先点卡片自带的关闭按钮：抖音会自己把整张卡片移除，比我们打标记更彻底。
  function closeMiniBox(box) {
    if (!box) return false;
    const br = box.getBoundingClientRect();
    let n = 0;
    const sel = 'button, [role="button"], [class*="close" i], [aria-label*="关闭"], [title*="关闭"]';
    for (const b of box.querySelectorAll(sel)) {
      if (++n > 10) break;
      const r = b.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.width > 60 || r.height > 60) continue;
      // 关闭按钮一般在右上角；不在右上角的不点，避免误触播放 / 跳转
      if (r.left < br.right - 110 || r.top > br.top + 90) continue;
      try { b.click(); return true; } catch (e) { /* 忽略 */ }
    }
    return false;
  }

  function hideLiveMini(main) {
    const now = Date.now();
    if (now - miniScanAt < 500) return 0;
    miniScanAt = now;
    // 先复核已隐藏的：抖音会复用这个容器，一旦放大成全屏直播间必须立刻恢复，
    // 否则直播间会被"透明化"，既不显示也跳不过去。
    miniHidden = miniHidden.filter(el => {
      if (!el.isConnected) return false;
      const r = el.getBoundingClientRect();
      if (r.width > 420 || r.height > 640) {
        el.removeAttribute('data-dyc-mini-hide');
        return false;
      }
      return true;
    });
    let n = 0;
    let scanned = 0;
    let skip = null;
    const list = document.querySelectorAll('[data-e2e="feed-live"]');
    for (const el of list) {
      // 上限从 6 提到 40：抖音会给每张预加载卡片都挂一个 feed-live 占位，
      // 真正的小窗经常排在第 7 个之后，之前直接被截断、永远轮不到。
      if (++n > 40) break;
      if (el.hasAttribute('data-dyc-mini-hide')) {
        // 外层卡片可能在小窗插入的瞬间还没撑开，导致上一轮 box 找不到。
        // 这里每轮补一次，撑开后就能补标上。
        const late = miniBoxOf(el);
        if (late && !late.hasAttribute('data-dyc-mini-hide')) {
          late.setAttribute('data-dyc-mini-hide', '');
          miniHidden.push(late);
          diagAdd('live-mini-hide', {
            why: 'late-box',
            rect: [Math.round(late.getBoundingClientRect().width), Math.round(late.getBoundingClientRect().height)],
            chain: popupChainOf(el)
          });
        }
        continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width < 60 || r.width > 420 || r.height < 60 || r.height > 640) {
        if (!skip) skip = { why: 'size', rect: [Math.round(r.width), Math.round(r.height)] };
        continue;
      }
      if (r.right < 0 || r.left > window.innerWidth || r.bottom < 0 || r.top > window.innerHeight) {
        if (!skip) skip = { why: 'offscreen', rect: [Math.round(r.left), Math.round(r.top)] };
        continue;
      }
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') {
        if (!skip) skip = { why: 'css-hidden', rect: [Math.round(r.width), Math.round(r.height)] };
        continue;
      }
      scanned++;
      if (main && el.contains(main)) {
        if (!skip) skip = { why: 'contains-main', rect: [Math.round(r.width), Math.round(r.height)] };
        continue;
      }
      el.setAttribute('data-dyc-mini-hide', '');
      miniHidden.push(el);
      // 外层的白色卡片一起收掉：只处理内层会留下一圈白底和右上角的 ×
      const box = miniBoxOf(el);
      if (box) {
        closeMiniBox(box);
        box.setAttribute('data-dyc-mini-hide', '');
        miniHidden.push(box);
      }
      diagAdd('live-mini-hide', {
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        box: box ? [Math.round(box.getBoundingClientRect().left), Math.round(box.getBoundingClientRect().top),
          Math.round(box.getBoundingClientRect().width), Math.round(box.getBoundingClientRect().height)] : null,
        chain: popupChainOf(el),
        html: el.outerHTML.replace(/\s+/g, ' ').slice(0, 500)
      });
    }
    // 每 4 秒留一条现场快照：页面上到底有几个 feed-live、为什么一个都没藏成。
    // 没有这条就只能靠猜（例如全部被 visibility:hidden 挡掉、或根本不在全局选择器里）。
    if (now - miniDiagAt > 4000) {
      miniDiagAt = now;
      diagAdd('mini-scan', { total: list.length, hid: miniHidden.length, skip });
    }
    return scanned;
  }

  function closePopups(video) {
    if (!enabled()) return;
    if (!D.route.feed) return;
    const now = Date.now();

    const main = (video instanceof HTMLVideoElement) ? video : D.playingVideo();
    scanLivePopups(main);
    hideLiveMini(main);
    if (now - lastClose < 800) return;                   // 关得太密容易误伤别的东西
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
    // 手动标记后需要立刻把当前这条切走：重置判定窗口再判一次，
    // 否则这条视频的 60 秒窗口可能已经用满，judge 会直接 return。
    forceCheck(video) {
      st.blocked = false;
      st.passes = 0;
      st.firstAt = Date.now();
      st.last = 0;
      st.retryAt = 0;
      judge(video);
    },
    closePopups,
    retryPending,
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
    // 诊断日志：popup 的「复制判定日志」通过 dyc:get-diag 消息取走
    diag() { return diag.slice(); },
    clearDiag() { diag = []; lastMissKey = ''; },
    // 「不再跳过」名单的条数与清空（popup 诊断卡片用）
    noSkipCount() { return noSkip.size; },
    clearNoSkip() {
      const n = noSkip.size;
      noSkip = new Set();
      pendingBack = null;
      userBack = null;
      saveNoSkip();
      D.log('filter: 已清空不再跳过名单', n, '条');
      return n;
    },
    reset() {
      clearTimeout(judgeTimer);
      st = { gen: -1, passes: 0, blocked: false, last: 0, retryAt: 0, firstAt: 0, skipFail: 0, hitAt: 0 };
      lastSkip = 0;
      lastScan = 0;
      liveStreak = 0;
      liveCooldownUntil = 0;
      pendingSkip = null;
      pendingBack = null;
      userBack = null;
      miniHidden.forEach(el => el.removeAttribute('data-dyc-mini-hide'));
      miniHidden = [];
    }
  };
})();
