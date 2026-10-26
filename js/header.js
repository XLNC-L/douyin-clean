/* 顶栏图标精简：只保留 账户头像 / 通知 / 消息
 *
 * 抖音顶栏是哈希 class，不能写死选择器，所以：
 * 1) 先从右上角的头像图片往上找出"图标组"容器；
 * 2) 容器内按 aria-label/title/文本 判断：命中通知/消息/头像的保留，
 *    命中 HIDE_WORDS 的隐藏；
 * 3) 图标没有文字标签时，退化为"保留最右侧三个图标"，其余隐藏；
 * 4) 只做一次性扫描（启动 + 有上限的重试），不做常驻监听。
 */
(() => {
  const D = window.__DYC;
  if (!D) return;

  const hidden = [];

  function reset() {
    hidden.forEach(el => el.removeAttribute('data-dyc-hide'));
    hidden.length = 0;
  }

  function labelOf(el) {
    let s = '';
    if (el.getAttribute) {
      s = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '');
    }
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t && t.length <= 16) s += ' ' + t;
    return s.replace(/\s+/g, ' ').trim();
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

  // 从右上角"头像"往上找图标组容器
  function findCluster() {
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
    el.setAttribute('data-dyc-hide', '');
    hidden.push(el);
  }

  D.header = {
    apply() {
      reset();
      if (!D.settings || D.settings.header === false) return false;
      if (!document.documentElement.classList.contains('dyc-feed')) return false;

      const cluster = findCluster();
      if (!cluster) return false;

      const kids = Array.from(cluster.children).filter(k => {
        const r = k.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (kids.length < 3 || kids.length > 18) return false;

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

      D.log('header: 顶栏保留入口', kept, '个，隐藏', hidden.length, '个');
      return true;
    },

    applySettings() {
      if (!D.settings || D.settings.header === false) {
        reset();
        return;
      }
      this.apply();
    },

    reset,
  };
})();
