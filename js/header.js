/* 顶栏图标精简：默认精简 / 自定义保留 / 保持原样
 *
 * 抖音顶栏是哈希 class，不能写死选择器，所以：
 * 1) 先从右上角的头像画出"图标组"容器；
 * 2) 默认精简：容器内按 aria-label/title/文本 判断，命中通知/消息/头像的保留，
 *    其余隐藏；图标没有文字标签时退化为"保留最右侧三个"；
 * 3) 自定义保留：按文案只保留用户勾选的图标（头像始终保留），
 *    勾选列表由 popup 通过 labels() 现取；
 * 4) 顶栏精简对所有页面生效（推荐、关注、朋友、搜索、个人主页……），
 *    不再只限于视频流页面；页面晚渲染时用有上限的重试 + 局部观察补上。
 * 5) 观察范围只到"找到的那一组图标"，不做整页监听。
 */
(() => {
  const D = window.__DYC;
  if (!D) return;

  const HIDE_ATTR = 'data-dyc-hide';
  const hidden = [];

  let mo = null;
  let moTarget = null;
  let raf = 0;
  let retries = 0;
  let retryTimer = 0;

  function modeOf() {
    const h = D.settings && D.settings.header;
    return (h && h.mode) || 'simple';
  }

  function stopWatch() {
    if (mo) { mo.disconnect(); mo = null; }
    moTarget = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  function clearMarks() {
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
    if (r.width < 20 || r.width > 64) return false;
    const radius = getComputedStyle(img).borderRadius || '';
    return /%|px/.test(radius) && parseFloat(radius) >= 12;
  }

  // 右上角的头像候选：贴在顶栏右侧、圆形、尺寸 20~64
  function avatarAnchors() {
    const vw = window.innerWidth;
    const out = [];
    let n = 0;
    for (const img of document.querySelectorAll('img')) {
      if (++n > 300) break;
      const r = img.getBoundingClientRect();
      if (r.width < 20 || r.width > 64 || r.height < 20 || r.height > 64) continue;
      if (r.top < 0 || r.top > 80 || r.bottom > 100) continue;
      if (r.right <= vw - 300) continue;
      const radius = getComputedStyle(img).borderRadius || '';
      if (!/%|px/.test(radius) || parseFloat(radius) < 12) continue;
      out.push(img);
    }
    if (!out.length) {
      for (const el of document.querySelectorAll('[data-e2e*="avatar" i]')) {
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.width > 64 || r.height < 20 || r.height > 64) continue;
        if (r.top < 0 || r.top > 80 || r.right <= vw - 300) continue;
        out.push(el);
      }
    }
    return out;
  }

  // 从右上角"头像"往上找出图标组容器
  function findCluster() {
    const anchors = avatarAnchors();
    for (const anchor of anchors) {
      let node = anchor.parentElement;
      let fallback = null;
      for (let i = 0; i < 6 && node && node !== document.body; i++, node = node.parentElement) {
        const r = node.getBoundingClientRect();
        if (r.height <= 0 || r.height >= 90 || r.top > 100) continue;
        if (r.width > window.innerWidth * 0.8) break;
        const kids = visibleKids(node);
        if (kids.length >= 3) return node;
        if (kids.length >= 2 && !fallback) fallback = node;
      }
      if (fallback) return fallback;
    }
    return null;
  }

  function visibleKids(cluster) {
    return Array.from(cluster.children).filter(k => {
      const r = k.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
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

  function watch(cluster) {
    if (mo && moTarget === cluster) return;
    stopWatch();
    moTarget = cluster;
    if (!cluster) return;
    // 只盯找到的这一组图标：页面重渲染时补标，不观察整页
    mo = new MutationObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        apply();
      });
    });
    mo.observe(cluster, { childList: true, subtree: true });
  }

  // 顶栏常常比内容晚渲染：有上限地补几次，失败也不会无限重试
  function retryLater() {
    if (retries >= 10 || retryTimer) return;
    retries++;
    retryTimer = setTimeout(() => {
      retryTimer = 0;
      apply();
    }, 700);
  }

  function apply() {
    clearTimeout(retryTimer);
    retryTimer = 0;
    clearMarks();
    if (modeOf() === 'off') {
      stopWatch();
      retries = 0;
      return false;
    }

    const cluster = findCluster();
    if (!cluster) { retryLater(); return false; }

    const kids = visibleKids(cluster);
    if (kids.length < 2 || kids.length > 18) { retryLater(); return false; }

    const kept = modeOf() === 'custom' ? applyCustom(kids) : applySimple(kids);
    retries = 0;
    watch(cluster);
    D.log('header: 模式=' + modeOf(), '页面=' + location.pathname,
      '保留入口', kept, '个，隐藏', hidden.length, '个');
    return true;
  }

  D.header = {
    apply,
    // popup 用的候选项：必须包含当前被隐藏的图标，所以先临时摘掉标记再量尺寸。
    // 整个函数同步执行，浏览器不会在中间绘制，不会看到闪烁。
    labels() {
      const cluster = findCluster();
      if (!cluster) return [];
      const marks = hidden.slice();
      marks.forEach(el => el.removeAttribute(HIDE_ATTR));

      const labels = itemsOf(visibleKids(cluster)).map(it => it.label);

      marks.forEach(el => el.setAttribute(HIDE_ATTR, ''));
      return labels;
    },

    applySettings() {
      if (modeOf() === 'off') {
        this.reset();
        return;
      }
      apply();
    },

    reset() {
      stopWatch();
      clearTimeout(retryTimer);
      retryTimer = 0;
      retries = 0;
      clearMarks();
    },
  };
})();
