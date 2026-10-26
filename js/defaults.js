/* 设置默认值与归一化：内容脚本与 popup 共用同一份 schema，避免两边漂移。
 * 只挂到全局，不做任何 DOM / storage 操作。
 */
(() => {
  'use strict';
  const DEFAULTS = {
    quality: true,          // 自动最高清晰度
    filter: true,           // 广告 / 带货过滤 + 直播小窗清理
    live: true,             // 推荐流中的直播间自动跳过
    pause: true,            // 失焦自动暂停
    overlay: true,          // 标题 / 互动栏自动隐藏
    header: {
      mode: 'simple',       // simple=默认精简（头像/通知/消息）| custom=自定义保留 | off=保持原样
      keep: ['通知', '消息'] // custom 模式下要保留的图标文案
    },
    nav: {
      mode: 'hide',         // hide=整条隐藏 | custom=逐项保留 | off=保持原样
      keep: ['我的']        // custom 模式下要保留的导航项文案
    }
  };

  // 存储里的值可能缺字段、类型不对，统一收敛到已知 schema
  function normalize(raw) {
    const r = (raw && typeof raw === 'object') ? raw : {};
    const nav = (r.nav && typeof r.nav === 'object') ? r.nav : {};
    const mode = (nav.mode === 'custom' || nav.mode === 'off') ? nav.mode : 'hide';
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

    return {
      quality: r.quality !== false,
      filter: r.filter !== false,
      live: r.live !== false,
      pause: r.pause !== false,
      overlay: r.overlay !== false,
      header: { mode: headerMode, keep: headerKeep },
      nav: { mode, keep }
    };
  }

  if (typeof window !== 'undefined') {
    window.__DYC_DEFAULTS = DEFAULTS;
    window.__DYC_NORMALIZE = normalize;
  }
})();
