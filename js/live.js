/* 直播站精简（live.douyin.com）
 *
 * 直播站的结构几乎全是哈希类名（`Wn6sF12t` 之类），不能靠 class 定位。
 * 所以这里只用两类稳定线索：
 *   ① 语义标记：`data-e2e="gifts-container" / gifts-switch / recharge-btn /
 *      hour-rank-entrance / game-rank-entrance / exhibition-banner / page-footer`；
 *   ② 固定文案 + 几何：像顶栏的「充钻石 / 客户端 / 壁纸 / 投稿」、提示卡的
 *      「抖音APP」，都是短文案 + 小尺寸，再用尺寸条件收拢到按钮/卡片容器。
 * 命中后打 `data-dyc-live-hide`，由 css/content.css 隐藏（不删节点，可随时还原）。
 *
 * 刻意不动的部分：
 *   - 右侧聊天区与「在线观众」榜：隐藏榜单容器会连带聊天区布局异常（真机试过，
 *     右侧整片变空白），宁可保留；
 *   - 主播信息条、播放器控制、退出直播间按钮：删了就没法正常看/退出了。
 *
 * 性能：只有 live 站、开关开着时才动作；apply 时各规则最多扫一次，
 * 页面重渲染后由 main.js 的 2 秒看门狗调 verify() 补标。
 */
(() => {
  const D = window.__DYC;
  if (!D) return;

  const HIDE_ATTR = 'data-dyc-live-hide';
  const GIFT_E2E = ['gifts-container', 'gifts-switch', 'recharge-btn'];
  const RANK_E2E = ['hour-rank-entrance', 'game-rank-entrance', 'exhibition-banner'];
  // 顶栏里的宣传入口（通知 / 消息 / 头像不在其中，保持原样）
  const HEAD_WORDS = ['充钻石', '客户端', '壁纸', '投稿'];
  const PROMO_WORDS = ['抖音APP', '抖音App', '下载抖音', '扫码下载'];

  let marks = [];

  const onLive = () => location.hostname.indexOf('live.douyin.com') >= 0;
  const onRoom = () => onLive() && !!document.querySelector('[data-e2e="living-container"]');
  const enabled = () => !D.settings || D.settings.liveClean !== false;

  function hide(el) {
    if (!el || el.nodeType !== 1) return;
    if (el.hasAttribute(HIDE_ATTR)) return;
    el.setAttribute(HIDE_ATTR, '');
    marks.push(el);
  }

  function clear() {
    marks.forEach(el => el.removeAttribute(HIDE_ATTR));
    marks = [];
  }

  // 在 root 里按短文案找小元素，再向上收拢到不超过 maxW / maxH 的那层容器
  function hideByWords(root, words, maxW, maxH, limit) {
    if (!root) return;
    let n = 0;
    for (const el of root.querySelectorAll('div, span, a, p')) {
      if (++n > (limit || 240)) break;
      if (el.childElementCount > 3) continue;
      const t = D.textOf(el);
      if (!t || t.length > 16) continue;
      if (!words.some(w => t.indexOf(w) !== -1)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (r.width > maxW * 2 || r.height > maxH * 2) continue;
      let box = el;
      while (box.parentElement && box.parentElement !== root) {
        const pr = box.parentElement.getBoundingClientRect();
        if (pr.width > maxW || pr.height > maxH) break;
        box = box.parentElement;
      }
      hide(box);
    }
  }

  // 底部礼物栏 + 充值：从礼物列表向上收拢到"贴着底边、几乎整屏宽"的那一条
  function hideGiftBar() {
    let anchor = null;
    for (const e2e of GIFT_E2E) {
      anchor = document.querySelector('[data-e2e="' + e2e + '"]');
      if (anchor) break;
    }
    if (!anchor) return;
    let n = anchor;
    let best = anchor;
    for (let i = 0; i < 4 && n && n !== document.body; i++, n = n.parentElement) {
      const r = n.getBoundingClientRect();
      if (r.width > window.innerWidth * 0.7 && r.height >= 50 && r.height <= 150 &&
          r.top > window.innerHeight * 0.78) {
        best = n;
      }
    }
    hide(best);
  }

  // 顶部榜单入口（小时榜 / 游戏榜 / 展位 banner）：语义标记，直接隐藏
  function hideRankEntrance() {
    for (const e2e of RANK_E2E) {
      document.querySelectorAll('[data-e2e="' + e2e + '"]').forEach(hide);
    }
  }

  // 首页顶栏的「充钻石 / 客户端 / 壁纸 / 投稿」：只按文案 + 尺寸，不动通知 / 消息 / 头像
  function hideHeadExtras() {
    const head = document.querySelector('.live-head, header');
    if (!head) return;
    hideByWords(head, HEAD_WORDS, 170, 64, 240);
  }

  // 页脚（广告投放 / 协议 / 热门标签）：整块没有观看价值
  function hideFooter() {
    document.querySelectorAll('[data-e2e="page-footer"]').forEach(hide);
  }

  // 「手机在看的直播？」这类引导下载 App 的浮卡
  function hideAppPromo() {
    hideByWords(document.body, PROMO_WORDS, 480, 220, 400);
  }

  function apply() {
    const html = document.documentElement;
    if (!onLive()) {
      clear();
      html.classList.remove('dyc-live');
      return;
    }
    html.classList.add('dyc-live');
    clear();
    if (!enabled()) {
      D.log('live: 直播站精简已关闭');
      return;
    }
    hideHeadExtras();
    hideFooter();
    hideGiftBar();
    hideRankEntrance();
    if (onRoom()) hideAppPromo();
    try {
      html.setAttribute('data-dyc-live-state', JSON.stringify({
        room: onRoom(), n: marks.length, ts: Date.now()
      }));
    } catch (e) { /* 忽略 */ }
    D.log('live: 已精简', marks.length, '个区域');
  }

  // 播放器重渲染会把标记冲掉：只在关键锚点还在、但没被标记时补一次，开销很小
  function verify() {
    if (!onLive() || !enabled()) return;
    if (!document.documentElement.classList.contains('dyc-live')) {
      apply();
      return;
    }
    if (onRoom()) {
      for (const e2e of GIFT_E2E) {
        const el = document.querySelector('[data-e2e="' + e2e + '"]');
        if (el && !el.closest('[' + HIDE_ATTR + ']')) {
          apply();
          return;
        }
      }
      // 榜单入口比播放器晚一拍渲染：这里也要盯一眼，否则首次 apply 会漏掉
      for (const e2e of RANK_E2E) {
        const el = document.querySelector('[data-e2e="' + e2e + '"]');
        if (el && !el.closest('[' + HIDE_ATTR + ']')) {
          apply();
          return;
        }
      }
    }
    const footer = document.querySelector('[data-e2e="page-footer"]');
    if (footer && !footer.closest('[' + HIDE_ATTR + ']')) apply();
  }

  D.live = {
    apply,
    verify,
    get count() { return marks.length; }
  };
})();
