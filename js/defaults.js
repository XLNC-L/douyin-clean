/* 设置默认值与归一化：内容脚本与 popup 共用同一份 schema，避免两边漂移。
 * 只挂到全局，不做任何 DOM / storage 操作。
 */
(() => {
  'use strict';
  const DEFAULTS = {
    quality: true,          // 自动最高清晰度
    // 清晰度上限：'max' 不限 / '1080' 最高 1080P / '720' 最高 720P。
    // 默认最高；弱网或低配机可以压到 1080，避免 4K 换流带来的卡顿。
    qualityCap: 'max',
    filter: true,           // 广告 / 带货过滤 + 直播小窗清理
    live: true,             // 推荐流中的直播间自动跳过
    respectBack: true,      // 手动滑回被跳过的广告 / 直播后，这一条不再自动跳过
    pause: true,            // 失焦自动暂停
    overlay: true,          // 标题 / 互动栏自动隐藏
    hideGame: true,         // 隐藏左下角游戏推广卡片（暂停时出现的也一起隐藏）
    noDoubleLike: true,     // 屏蔽双击视频画面点赞
    liveClean: true,        // 直播间精简（礼物栏 / 榜单 / 观众榜等）
    // 直播间精简的分区开关，面板里可以逐项取消
    liveParts: {
      head: true,           // 直播站顶栏的推广入口（充钻石 / 客户端 / 壁纸 / 投稿）
      gifts: true,          // 直播间底部礼物栏（含更多 / 充值）
      ranks: true,          // 顶部榜单入口（小时榜 / 游戏榜 / 展位横幅）
      footer: true,         // 直播站首页页脚
      promo: true           // 「手机在看的直播？」这类下载 App 浮卡
    },
    // 上下切换箭头只提供「隐藏」开关（uiHide.arrows），不做位置接管。
    progress: true,         // 视频底部进度细线
    progressColor: '#fe2c55', // 进度细线颜色（6 位 hex）
    header: {
      mode: 'simple',       // simple=默认精简（头像/通知/消息）| custom=自定义保留 | off=保持原样
      keep: ['通知', '消息'] // custom 模式下要保留的图标文案
    },
    nav: {
      mode: 'hide',         // hide=整条隐藏 | drawer=抽屉（左边缘悬停滑出）| custom=逐项保留 | off=保持原样
      keep: ['我的']        // custom 模式下要保留的导航项文案
    },
    // 推荐视频页可隐藏元素。true = 隐藏（默认全部显示，保持抖音原样）。
    // 每一项对应 html 上的 dyc-h-<key>，CSS 只做视觉隐藏，不影响播放与切条。
    uiHide: {
      topbar: false,        // 整条顶栏（含搜索框，隐藏后画面同时上移撑满）
      search: false,        // 顶栏搜索框（只灰显禁用，不塌陷）
      author: false,        // 左下作者头像 / 昵称 / 时间
      desc: false,          // 左下标题与话题
      product: false,       // 左下商品 / 购物卡
      digg: false,          // 互动栏：点赞
      comment: false,       // 互动栏：评论入口（只藏按钮，评论功能与面板不受影响）
      collect: false,       // 互动栏：收藏
      share: false,         // 互动栏：分享
      more: false,          // 互动栏：更多
      music: false,         // 互动栏：听抖音
      avatar: false,        // 互动栏：作者头像与关注
      recommend: false,     // 「共 N 人推荐」标签
      controls: false,      // 底部播放控制条
      progress: false,      // 播放器原生进度条
      arrows: false,        // 左右切换箭头
      ai: false,            // 文案下方的 AI 按钮（文案随视频变化）
      // 评论区顶部：每一项独立开关（右上角关闭按钮始终保留）
      cmai: false,          // 顶部 tab：AI
      cmworks: false,       // 顶部 tab：TA的作品
      cmcomment: false,     // 顶部 tab：评论
      cmmix: false,         // 顶部 tab：合集
      cmrec: false,         // 顶部 tab：相关推荐
      cmhot: false,         // 顶部 tab：热点
      cmsearch: false       // 「大家都在搜：xxx」推荐行
    }
  };

  // 存储里的值可能缺字段、类型不对，统一收敛到已知 schema
  function normalize(raw) {
    const r = (raw && typeof raw === 'object') ? raw : {};
    const nav = (r.nav && typeof r.nav === 'object') ? r.nav : {};
    const mode = (nav.mode === 'custom' || nav.mode === 'off' || nav.mode === 'drawer')
      ? nav.mode : 'hide';
    const keep = Array.isArray(nav.keep)
      ? nav.keep
        .filter(s => typeof s === 'string' && s && s.length <= 24)
        .slice(0, 30)
      : DEFAULTS.nav.keep.slice();

    // header 旧版是布尔值：true=默认精简、false=保持原样，这里做兼容迁移
    const hdr = r.header;
    const h = (hdr && typeof hdr === 'object') ? hdr : {};
    const headerMode = hdr === false ? 'off'
      : hdr === true ? 'simple'
        : (h.mode === 'custom' || h.mode === 'off') ? h.mode : 'simple';
    const headerKeep = Array.isArray(h.keep)
      ? h.keep
        .filter(s => typeof s === 'string' && s && s.length <= 24)
        .slice(0, 20)
      : DEFAULTS.header.keep.slice();

    // 颜色只接受 6 位 hex，避免把任意字符串写进 CSS 变量
    const rawColor = typeof r.progressColor === 'string' ? r.progressColor.trim().toLowerCase() : '';
    const progressColor = /^#[0-9a-f]{6}$/.test(rawColor)
      ? rawColor
      : DEFAULTS.progressColor;

    const lp = (r.liveParts && typeof r.liveParts === 'object') ? r.liveParts : {};

    const cap = ['max', '1080', '720'].indexOf(r.qualityCap) !== -1 ? r.qualityCap : 'max';

    const uh = (r.uiHide && typeof r.uiHide === 'object') ? r.uiHide : {};
    const uiHide = {};
    for (const k of Object.keys(DEFAULTS.uiHide)) uiHide[k] = uh[k] === true;
    // 旧版「评论区顶部」是单个总开关（commenttop），现在拆成 7 个独立项：
    // 旧值为 true 且新字段没设置过时，一次性全部打开。
    if (uh.commenttop === true) {
      for (const k of ['cmai', 'cmworks', 'cmcomment', 'cmmix', 'cmrec', 'cmhot', 'cmsearch']) {
        if (uh[k] === undefined) uiHide[k] = true;
      }
    }

    return {
      quality: r.quality !== false,
      qualityCap: cap,
      filter: r.filter !== false,
      live: r.live !== false,
      pause: r.pause !== false,
      overlay: r.overlay !== false,
      hideGame: r.hideGame !== false,
      noDoubleLike: r.noDoubleLike !== false,
      respectBack: r.respectBack !== false,
      liveClean: r.liveClean !== false,
      liveParts: {
        head: lp.head !== false,
        gifts: lp.gifts !== false,
        ranks: lp.ranks !== false,
        footer: lp.footer !== false,
        promo: lp.promo !== false
      },
      progress: r.progress !== false,
      progressColor,
      header: { mode: headerMode, keep: headerKeep },
      nav: { mode, keep },
      uiHide
    };
  }

  if (typeof window !== 'undefined') {
    window.__DYC_DEFAULTS = DEFAULTS;
    window.__DYC_NORMALIZE = normalize;
  }
})();
