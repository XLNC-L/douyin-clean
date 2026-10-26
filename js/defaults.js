/* 设置默认值与归一化：内容脚本与 popup 共用同一份 schema，避免两边漂移。
 * 只挂到全局，不做任何 DOM / storage 操作。
 */
(() => {
  'use strict';
  const DEFAULTS = {
    quality: true,          // 自动最高清晰度
    filter: true,           // 广告 / 带货过滤 + 直播小窗清理
    pause: true,            // 失焦自动暂停
    overlay: true,          // 标题 / 互动栏自动隐藏
    header: true,           // 顶栏图标精简
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
    return {
      quality: r.quality !== false,
      filter: r.filter !== false,
      pause: r.pause !== false,
      overlay: r.overlay !== false,
      header: r.header !== false,
      nav: { mode, keep }
    };
  }

  if (typeof window !== 'undefined') {
    window.__DYC_DEFAULTS = DEFAULTS;
    window.__DYC_NORMALIZE = normalize;
  }
})();
