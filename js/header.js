/* 顶栏图标精简：默认精简 / 自定义保留 / 保持原样
 *
 * 抖音顶栏是哈希 class，不能写死选择器，所以：
 * 1) 先从右上角的头像图片往上找出"图标组"容器；
 * 2) 默认精简：容器内按 aria-label/title/文本 判断，命中通知/消息/头像的保留，
 *    其余隐藏；图标没有文字标签时退化为"保留最右侧三个"；
 * 3) 自定义保留：按文案只保留用户勾选的图标（头像始终保留），
 *    勾选列表由 popup 通过 labels() 现取；
 * 4) 只做一次性扫描（启动 + 有上限的重试），不做常驻监听。
 */
(() => {
  const D = window.__DYC;
  if (!D) return;

  const HIDE_ATTR = 'data-dyc-hide';
  const hidden = [];

  function modeOf() {
    const h = D.settings && D.settings.header;
    return (h && h.mode) || 'simple';
  }

  function reset() {
    hidden.forEach(el => el.removeAttribute(HIDE_ATTR));
    hidden.length = 0;
  }

  // 顶栏文案常带角标（例如"消息1"），去掉结尾数字后才能和设置里的文案对上
  function clean(s) {
    return String(s || '')
      .replace(/\s+/g, '')
      .replace(/[0-9]+$/, '')
      .slice(0, 16);
  }

  function labelOf(el) {
    if (!el.getAttribute) return '';
    const attr = clean((el.getAttribute('aria-label') || '') + (el.getAttribute('title') || ''));
    return attr || clean(D.textOf(el));
  }

  function isAvatar(el) {
    if (el.matches('a[href*="/user/"]') || el.querySelector('a[href*="/user/"]')) return true;
    const img = el.querySelector('img');
    if (!img) return false;
    const r = img.getBoundingClientRect();
    if (r.width < 24 || r.width > 64) return false;
    const radius = getComputedStyle(img).borderRadius || '';
    return /%|px/.test(radius) && parseFloat(radius) >= 12;
  }

  // 顶栏右侧的图标组容器。
  // ① 优先按语义标记定位：顶栏的「通知 / 消息」入口一定在图标组里，
  //    比"找一个圆形头像"可靠得多 —— 未登录时根本没有头像，旧逻辑会直接放弃。
  // ② 找不到时退回原来的"从右上角圆形头像往上找"。
  function findCluster() {
    for (const sel of ['[data-e2e="im-entry"]', '[data-e2e="notice-entry"]']) {
      const anchor = document.querySelector(sel);
      if (!anchor) continue;
      let best = null;
      let node = anchor.parentElement;
      for (let i = 0; i < 6 && node && node !== document.body; i++, node = node.parentElement) {
        const r = node.getBoundingClientRect();
        if (!(r.height > 0 && r.height < 80 && r.top < 96)) break;
        if (r.width > 0 && r.width < 460) best = node;
        else break;
      }
      if (best && best.children.length >= 3) return best;
    }

    const vw = window.innerWidth;
    const imgs = document.querySelectorAll('img');
    let anchor = null;
    for (const img of imgs) {
      const r = img.getBoundingClientRect();
      if (r.width < 24 || r.width > 64 || r.top < 0 || r.top >= 96 || r.right <= vw - 260) continue;
      const radius = getComputedStyle(img).borderRadius || '';
      if (!/%|px/.test(radius) || parseFloat(radius) < 12) continue; // 只认圆形头像，避开装饰图
      anchor = img;
      break;
    }
    if (!anchor) return null;

    let node = anchor.parentElement;
    for (let i = 0; i < 5 && node; i++, node = node.parentElement) {
      const r = node.getBoundingClientRect();
      if (r.height > 0 && r.height < 80 && r.top < 96 && node.children.length >= 3) return node;
    }
    return null;
  }

  function markHidden(el) {
    el.setAttribute(HIDE_ATTR, '');
    hidden.push(el);
  }

  // 顶栏里可自定义的项：去掉大头像、搜索框这类大块，只留带文案的图标按钮
  function itemsOf(kids) {
    const out = [];
    const seen = new Set();
    kids.forEach(k => {
      const r = k.getBoundingClientRect();
      if (r.width > 110 || r.height > 72) return;   // 搜索框 / 大块不参与
      if (isAvatar(k)) return;                      // 头像始终保留
      const label = labelOf(k);
      if (!label || seen.has(label)) return;
      seen.add(label);
      out.push({ label, el: k });
    });
    return out;
  }

  function applySimple(kids) {
    const labels = kids.map(labelOf);
    const useLabels = labels.filter(Boolean).length >= 2;

    // 没有可用标签时的兜底：保留最右侧三个
    const rightmost = new Set(
      kids.slice().sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right).slice(0, 3)
    );

    let kept = 0;
    kids.forEach((k, i) => {
      const r = k.getBoundingClientRect();
      if (r.width > 110 || r.height > 72) { kept++; return; } // 搜索框等大块不处理
      if (isAvatar(k)) { kept++; return; }

      const l = labels[i];
      const cls = typeof k.className === 'string' ? k.className : '';
      if (D.KEEP_RE.test(l) || D.KEEP_RE.test(cls)) { kept++; return; }

      // 有可读标签但不是保留入口：直接隐藏
      if (useLabels && l) {
        markHidden(k);
        return;
      }

      if (rightmost.has(k)) { kept++; return; }
      markHidden(k);
    });
    return kept;
  }

  function applyCustom(kids) {
    const keep = new Set((D.settings.header && D.settings.header.keep) || []);
    const list = itemsOf(kids);

    // 保底：勾选的项一个都没在顶栏里找到（抖音改版 / 还没渲染完）时不动手，
    // 避免把通知、消息等入口一次性全隐藏掉。一个都没勾选时才是"只留头像"。
    if (keep.size && !list.some(it => keep.has(it.label))) {
      D.log('header: 保留项', Array.from(keep).join('/'), '不在当前顶栏里，本次不隐藏');
      return 0;
    }

    let kept = 0;
    kids.forEach(k => {
      const r = k.getBoundingClientRect();
      if (r.width > 110 || r.height > 72) { kept++; return; }
      if (isAvatar(k)) { kept++; return; }

      const l = labelOf(k);
      if (l && keep.has(l)) { kept++; return; }
      markHidden(k);
    });
    return kept;
  }

  D.header = {
    apply() {
      reset();
      if (modeOf() === 'off') return false;
      // 顶栏精简同样全站生效（我的 / 收藏 / 搜索等页面），不再限定刷视频页面

      const cluster = findCluster();
      if (!cluster) return false;

      const kids = Array.from(cluster.children).filter(k => {
        const r = k.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (kids.length < 3 || kids.length > 18) return false;

      const kept = modeOf() === 'custom' ? applyCustom(kids) : applySimple(kids);
      D.log('header: 模式=' + modeOf(), '保留入口', kept, '个，隐藏', hidden.length, '个');
      return true;
    },

    // popup 用的候选项：必须包含当前被隐藏的图标，所以先临时摘掉标记再量尺寸。
    // 整个函数同步执行，浏览器不会在中间绘制，不会看到闪烁。
    labels() {
      const cluster = findCluster();
      if (!cluster) return [];
      const marks = hidden.slice();
      marks.forEach(el => el.removeAttribute(HIDE_ATTR));

      const kids = Array.from(cluster.children).filter(k => {
        const r = k.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const labels = itemsOf(kids).map(it => it.label);

      marks.forEach(el => el.setAttribute(HIDE_ATTR, ''));
      return labels;
    },

    applySettings() {
      if (modeOf() === 'off') {
        reset();
        return;
      }
      this.apply();
    },

    reset,
  };
})();
