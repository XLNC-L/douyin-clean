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
  const MAX_LIVE_STREAK = 5;     // 连续跳过这么多条直播后先停一下，避免推荐流全是直播时无限切
  let liveStreak = 0;
  let liveCooldownUntil = 0;     // 直播冷却截止时间：冷却期内不再跳直播，也不重判
  // 抖音复用同一个 <video> 元素播放所有视频，判定状态不能挂在元素上：
  // 元素上的计数一旦用满、或已判成广告，后面所有视频都会被直接放过。
  // 也不能用 duration / currentSrc 当身份：抖音大量视频是 MSE 流，
  // duration 常为 Infinity、currentSrc 常为空串，所有这类视频会撞成同一个 key，
  // 判定次数攒满后整条推荐流都不再检查（历史 bug，表现为"广告从不跳"）。
  // 现在统一用 main.js 维护的代次 D.gen：每换一条视频 +1。
  let st = { gen: -1, passes: 0, blocked: false, last: 0, retryAt: 0, firstAt: 0, skipFail: 0 };
  let lastSkip = 0;
  // 命中但视频处于暂停状态时的"待跳"记录：暂停中不切走（暂停层里常带推荐 / 商品卡，
  // 切走会让用户觉得"暂停被取消"），但也不能像旧版那样直接放弃并永久 blocked。
  // 恢复播放后由 main.js 的 2 秒看门狗调用 retryPending() 补跳。
  let pendingSkip = null;

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

  // 切下一条。三段式：尝试 -> 复核 -> 升级；三次都失败时不再永久放弃。
  // 旧版的 bug：第三次尝试后直接 return，而 blocked 已经置 true，
  // 于是一条"点不动"的视频会一直播到用户手动划走，所有后续判定都被 blocked 挡掉。
  // 第三层也不再发合成 KeyboardEvent：isTrusted=false，抖音的事件委托不接受，等于没有兜底。
  const SWITCH_TRIES = 3;
  const SWITCH_RECHECK = 800;        // 每次尝试后多久复核（抖音换片通常在几百毫秒内完成）
  const SWITCH_MIN_GAP = 900;        // 两次切条之间的最小间隔
  const SWITCH_RETRY_DELAY = 3000;   // 三次都失败后隔多久重新判定

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

  function switchAttempt(video, i) {
    // 1) 原生"下一条"箭头：和用户点一样走抖音自己的能力
    if (i === 0) {
      const arrow = document.querySelector(D.SEL.nextArrow);
      if (arrow && arrow.getBoundingClientRect().width > 0) {
        try { arrow.click(); } catch (e) { /* 忽略 */ }
        return;
      }
    }
    // 2) 滚动容器滚一屏；第二次多滚 30%，防止 scroll-snap 又吸回原位
    const node = scrollTarget(video);
    if (node) {
      try { node.scrollBy({ top: node.clientHeight * (i >= 1 ? 1.3 : 1.0), behavior: 'auto' }); } catch (e) { /* 忽略 */ }
      return;
    }
    // 3) 找不到容器时兜底滚窗口
    try { window.scrollBy({ top: window.innerHeight, behavior: 'auto' }); } catch (e) { /* 忽略 */ }
  }

  // 三次都没切走：清掉 blocked，隔 4 秒重新判定一次（不再永久锁死）。
  // 同一条视频连续失败 3 轮就停手，避免在"暂停 + 箭头点不动"的场景里每 4 秒反复点一次。
  function giveUpSwitch(video, genAt) {
    if (!video || !video.isConnected) return;
    if (D.gen !== genAt) return;
    st.skipFail = (st.skipFail || 0) + 1;
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
  // 购物卡片容器 / 官方广告标识 / 电商浮层 / 推广按钮 / 店铺账号，都是平台结构或固定文案，
  // 不属于暂停层里"相关推荐"那种模棱两可的内容。
  // 弱信号（靠价格 / 购买按钮 / 营销话术凑两条）在暂停时容易误判，仍然等恢复播放再判。
  const STRONG_HIT_RE = /^(购物卡片|广告标识|电商浮层|推广浮层|推广按钮|店铺账号|手动屏蔽|ad)/;

  function next(video, force) {
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

    const genAt = D.gen;
    const step = i => {
      if (!video || !video.isConnected) return;
      switchAttempt(video, i);
      setTimeout(() => {
        if (!video || !video.isConnected || document.hidden) return;
        if (D.gen !== genAt) return;              // 代次变了 = 真的切走了
        // 换片动画进行中代次可能还没更新，但旧视频已经滚出视口 → 也认为切走了，
        // 否则会在动画中途再滚一屏，一次跳过两条。
        if (D.visibleArea(video) < 10000) return;
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
      video = cur;
      st.gen = -1;
    }
    if (D.isOverlayVideo(video)) return;

    // 换了视频就重置判定状态（用代次，不用 duration/src —— 它们经常是 Infinity/空串）
    if (D.gen !== st.gen) st = { gen: D.gen, passes: 0, blocked: false, last: 0, retryAt: 0, firstAt: 0, skipFail: 0 };

    const now = Date.now();
    if (!st.firstAt) st.firstAt = now;
    if (now < st.retryAt) return;       // 上一轮三次都没切走，等冷却结束再判
    if (now - st.last < 350) return;    // 同一视频短时间内别重复扫
    st.last = now;

    // 判定窗口按"时间"而不是"次数"：loadedmetadata / playing / emptied / 2 秒看门狗
    // 都会触发判定，按次数上限会在 2~3 秒内被耗光，导致播放中段才出现的推广浮层永远没机会被看到。
    // 暂停态下没有媒体事件，只能靠看门狗每 6 秒补判，所以窗口放宽到 60 秒（画面不会变，扫描量可控）。
    const win = video.paused ? 60000 : 12000;
    const maxPasses = video.paused ? 20 : 12;
    if (now - st.firstAt > win || st.passes >= maxPasses) return;
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
      // 前几次用短间隔（商品卡/浮层常比视频晚一拍），之后每 1.2 秒复核，
      // 直到 12 秒窗口结束。旧的 0.9/3 秒节奏会让"广告已经出现一两秒才被判到"。
      if (Date.now() - st.firstAt < 12000) setTimeout(() => judge(video), st.passes <= 3 ? 500 : 1200);
      return;
    }

    if (st.blocked) return;
    st.blocked = true;
    D.log('filter: 识别到', reason, '，跳过该视频');

    // 连续直播过多时进入 20 秒冷却，期间既不跳也不重判；
    // 旧版把 streak 归零后仍继续判下一条，表现为"每 5 条直播必漏 1 条"。
    if (reason.indexOf('直播') !== -1) {
      if (Date.now() < liveCooldownUntil) {
        D.log('filter: 直播冷却中，暂不跳');
        return;
      }
      liveStreak++;
      if (liveStreak >= MAX_LIVE_STREAK) {
        liveStreak = 0;
        liveCooldownUntil = Date.now() + 20000;
        D.log('filter: 连续直播过多，暂停 20 秒');
        return;
      }
    } else {
      liveStreak = 0;
      liveCooldownUntil = 0;
    }

    // 命中时视频可能正处于暂停（失焦自动暂停 / 用户手动暂停 / 抖音暂停层）。
    // 强信号（购物卡、官方广告标、电商浮层、推广按钮、店铺账号）直接切，
    // 否则广告会一直钉在暂停画面上；弱信号先登记，等恢复播放后重判再切。
    const strong = STRONG_HIT_RE.test(reason);
    if (video.paused && !strong) {
      pendingSkip = { gen: D.gen, reason, at: Date.now(), video };
      D.log('filter: 弱信号命中但视频暂停，登记待跳', reason);
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

  function closePopups(video) {
    if (!enabled()) return;
    if (!D.route.feed) return;
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
    // 手动标记后需要立刻把当前这条切走：重置判定窗口再判一次，
    // 否则这条视频的 12 秒窗口可能已经用满，judge 会直接 return。
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
    reset() {
      st = { gen: -1, passes: 0, blocked: false, last: 0, retryAt: 0, firstAt: 0, skipFail: 0 };
      lastSkip = 0;
      lastScan = 0;
      liveStreak = 0;
      liveCooldownUntil = 0;
      pendingSkip = null;
    }
  };
})();
