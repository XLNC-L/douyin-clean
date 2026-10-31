/* 左侧导航：整条隐藏 / 逐项保留 / 保持原样
 *
 * 抖音左侧导航（2026-10 实测）：
 *   <div id="douyin-navigation">
 *     <a>logo</a>
 *     <div>
 *       <div class="…">
 *         <div class="kCzNsmN5">                 <!-- 行容器，带 2px 上边距 -->
 *           <div class="tab-user_self …">        <!-- 每个入口都有 tab-* 语义类 -->
 *             <a href="/user/self">我的</a>
 *           </div>
 *         </div>
 *         …
 *         <footer>…备案 / 协议链接…</footer>       <!-- 也在 #douyin-navigation 里 -->
 *       </div>
 *     </div>
 *   </div>
 * 所以不能直接扫所有 <a>：页脚链接会被当成导航项。这里只认被 tab-* 包裹的链接，
 * 隐藏时向上找到"只含这一个入口"的行容器，连 margin 一起消掉。
 */
(() => {
  'use strict';
  const D = window.__DYC;
  if (!D) return;

  const NAV_SEL = '#douyin-navigation';
  const LINK_SEL = 'a, [role="link"]';
  const TAB_RE = /(^|\s)tab-[A-Za-z0-9_-]+(\s|$)/;
  const HIDE_ATTR = 'data-dyc-nav-hide';
  // 「AI 抖音」入口：不跟导航模式走，任何模式下都强制隐藏。
  // clean() 已经压掉空格，所以 "AI 抖音" / "AI抖音" 都会归一成 "AI抖音"。
  const FORCE_ATTR = 'data-dyc-nav-force';
  // 前缀匹配：直播站的 aria-label 可能带后缀（如「AI抖音搜索」）
  const FORCE_RE = /^ai抖音/i;

  let mo = null;
  let raf = 0;
  let retries = 0;
  let retryTimer = 0;
  let lastNav = null;        // 上一次 apply 时的导航节点：页面重建侧边栏后要能自愈

  const navOf = () => document.querySelector(NAV_SEL);

  // 自定义模式下"一个都不保留"等价于整条隐藏；其他模式不受 keep 影响
  function fullHidden() {
    const s = D.settings.nav;
    return s.mode === 'hide' || (s.mode === 'custom' && !(s.keep || []).length);
  }

  function clean(s) {
    return String(s || '')
      .replace(/\s+/g, '')
      .replace(/[0-9]+$/, '')       // "直播 3" 这类角标
      .slice(0, 12);
  }

  function labelOf(el) {
    const attr = clean(el.getAttribute('aria-label') || el.getAttribute('title') || '');
    return attr || clean(D.textOf(el));
  }

  // 从链接向上找 tab-* 包裹层；页脚链接没有这一层
  function tabWrapOf(el, nav) {
    let node = el.parentElement;
    for (let i = 0; i < 5 && node && node !== nav; i++, node = node.parentElement) {
      const cls = typeof node.className === 'string' ? node.className : '';
      if (TAB_RE.test(cls)) return node;
    }
    // 兜底：直播站（live.douyin.com）的导航项没有 tab-* 类名，
    // 退回"从链接向上找第一个只包含这一个链接的容器"，让逐项保留在那边也能工作。
    node = el.parentElement;
    for (let i = 0; i < 4 && node && node !== nav; i++, node = node.parentElement) {
      if (node.querySelectorAll(LINK_SEL).length === 1) return node;
    }
    return null;
  }

  // 行容器：从 tab-* 向上，只要父层里仍然只有这一个入口就继续爬
  function rowOf(tabWrap, nav) {
    let node = tabWrap;
    while (node.parentElement && node.parentElement !== nav) {
      const p = node.parentElement;
      if (p.querySelectorAll(LINK_SEL).length > 1) break;
      node = p;
    }
    return node;
  }

  // 当前导航入口（不要求可见：整条隐藏时 popup 仍然要列出它们）
  function rows() {
    const nav = navOf();
    if (!nav) return [];
    const out = [];
    const seen = new Set();
    let n = 0;
    for (const el of nav.querySelectorAll(LINK_SEL)) {
      if (++n > 40) break;
      const wrap = tabWrapOf(el, nav);
      if (!wrap) continue;
      const label = labelOf(el);
      if (!label || seen.has(label)) continue;
      seen.add(label);
      out.push({ label, el, wrap, row: rowOf(wrap, nav) });
    }
    return out;
  }

  function clearMarks() {
    document.querySelectorAll('[' + HIDE_ATTR + ']').forEach(el => el.removeAttribute(HIDE_ATTR));
  }

  function clearForced() {
    document.querySelectorAll('[' + FORCE_ATTR + ']').forEach(el => el.removeAttribute(FORCE_ATTR));
  }

  const isForced = label => FORCE_RE.test(String(label || ''));

  // 保留项匹配放宽为"包含"：不同页面的侧边栏文案会变（我的 / 我的作品、直播 / 正在直播），
  // 精确相等会导致"保留项一个都找不到"，进而触发旧的整条放弃逻辑 ——
  // 表现就是切换侧边栏后导航全部又冒出来。
  function keepMatch(label, keep) {
    if (!label) return false;
    for (const k of keep) {
      if (!k) continue;
      if (label === k) return true;
      if (label.length >= 2 && label.indexOf(k) >= 0) return true;
      if (k.length >= 2 && k.indexOf(label) >= 0) return true;
    }
    return false;
  }

  // 优先隐藏整行（连行间距一起收掉）；结构变动、没有 tab-* 包裹时按文案兜底。
  function hideForced() {
    const nav = navOf();
    if (!nav) return;

    for (const it of rows()) {
      if (isForced(it.label)) it.row.setAttribute(FORCE_ATTR, '');
    }

    let n = 0;
    for (const el of nav.querySelectorAll(LINK_SEL)) {
      if (++n > 60) break;
      if (!isForced(labelOf(el))) continue;
      let node = el.parentElement;
      let best = el;
      for (let i = 0; i < 5 && node && node !== nav; i++, node = node.parentElement) {
        const r = node.getBoundingClientRect();
        if (r.width > 0 && r.width < 260 && r.height < 80) best = node;
        else break;
      }
      best.setAttribute(FORCE_ATTR, '');
    }
  }

  // 文案直配兜底：不依赖 tab-* 与行容器推导，只按链接的可读文案决定隐藏。
  // 用于直播站这类导航层级不同的页面；保留项命中时不会误伤（只隐藏没被保留的入口）。
  function hideByText(nav, keep) {
    let n = 0;
    let hid = 0;
    for (const a of nav.querySelectorAll(LINK_SEL)) {
      if (++n > 60) break;
      const label = labelOf(a);
      if (!label) continue;
      if (keepMatch(label, keep) || isForced(label)) continue;
      let node = a;
      let best = a;
      for (let i = 0; i < 4 && node && node !== nav; i++, node = node.parentElement) {
        if (node.querySelectorAll(LINK_SEL).length > 1) break;
        best = node;
      }
      best.setAttribute(HIDE_ATTR, '');
      hid++;
    }
    return hid;
  }

  function hideItems() {
    const nav = navOf();
    if (!nav || D.settings.nav.mode !== 'custom' || fullHidden()) return;

    // AI 抖音这类强制隐藏项不允许被"保留"，否则会留下一条空行
    const keep = new Set((D.settings.nav.keep || []).filter(l => !isForced(l)));
    const list = rows();

    // rows() 认不出结构时（直播站 live.douyin.com 的导航层级不同）退回"按文案直配"：
    // 直接遍历链接，按可读文案判断保留/隐藏，不再依赖 tab-* 包裹层与行容器推导。
    if (!list.length) {
      if (!keep.size) { hideByText(nav, keep); return; }
      const hit = hideByText(nav, keep);
      if (hit) D.log('nav: 退回文案匹配隐藏', hit, '项');
      return;
    }

    // 保底：设置里勾选的入口一个都没命中时，不能整条清空（不同页面侧边栏项不同），
    // 但也不能像旧版那样直接放弃 —— 那正是"切换侧边栏后全部又出现"的原因。
    // 现在改为保留第一项（通常是「精选」），隐藏其余。
    if (keep.size && !list.some(it => keepMatch(it.label, keep))) {
      clearMarks();
      const first = list[0];
      for (const it of list) {
        if (it.row !== first.row) it.row.setAttribute(HIDE_ATTR, '');
      }
      D.log('nav: 保留项缺失，保底保留第一项并隐藏其余');
      return;
    }

    clearMarks();

    // 侧栏底部是备案 / 协议页脚（京ICP 备xxxx号），跟导航板块无关：
    // 逐项保留时一律收掉，不用等它被"非保留分支"的规则顺带隐藏。
    nav.querySelectorAll('footer').forEach(el => el.setAttribute(HIDE_ATTR, ''));

    // 1) 未保留的入口行
    const keepRows = [];
    for (const it of list) {
      if (keepMatch(it.label, keep)) keepRows.push(it.row);
      else it.row.setAttribute(HIDE_ATTR, '');
    }
    if (!keepRows.length) return;

    // 2) 从每个保留行向上，隐藏"不含保留入口"的兄弟分支。
    //    导航里除了功能入口，还塞了「下载 APP」推广和备案 / 协议页脚；
    //    逐项保留时如果只藏按钮，侧栏仍会被这些内容占满。
    for (const row of keepRows) {
      let cur = row;
      while (cur && cur.parentElement && cur.parentElement !== nav) {
        const p = cur.parentElement;
        for (const sib of p.children) {
          if (sib === cur) continue;
          if (keepRows.some(k => sib.contains(k))) continue;
          sib.setAttribute(HIDE_ATTR, '');
        }
        cur = p;
      }
    }

    // 3) 顶层：保留 logo 和包含保留入口的分支，其余（推广 / 页脚）隐藏
    for (const sib of nav.children) {
      if (sib === nav.firstElementChild && sib.tagName === 'A') continue;  // 左上角 logo
      if (sib.tagName === 'A' && !D.textOf(sib)) continue;
      if (keepRows.some(k => sib.contains(k))) continue;
      sib.setAttribute(HIDE_ATTR, '');
    }

    D.log('nav: 逐项保留', Array.from(keep).join('/'), '，其余入口与侧栏内容已隐藏');
  }

  function watch() {
    if (mo) { mo.disconnect(); mo = null; }
    // 整条隐藏时没必要观察；custom 与 off 模式都要盯着导航重渲染，
    // 前者维持逐项保留，后者只维持「AI 抖音」的强制隐藏。
    if (!D.settings || fullHidden()) return;
    const nav = navOf();
    if (!nav) return;
    mo = new MutationObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (D.settings.nav.mode === 'custom' && !fullHidden()) hideItems();
        hideForced();
      });
    });
    // 只观察导航容器的子节点变化；我们只改属性，不会触发自己
    mo.observe(nav, { childList: true, subtree: true });
  }

  function retryLater() {
    // 直播站（live.douyin.com）首屏渲染比信息流慢，导航可能十几秒后才出现；
    // 原来 6 次（6 秒）就放弃，导致"到了直播页精简失效"。放宽到 12 次。
    if (retries >= 12 || retryTimer || fullHidden()) return;
    retries++;
    retryTimer = setTimeout(() => {
      retryTimer = 0;
      if (fullHidden()) return;
      if (navOf()) D.nav.apply();
      else retryLater();
    }, 1000);
  }

  D.nav = {
    apply() {
      const nav = navOf();
      lastNav = nav;
      // 导航精简是全站生效的（我的 / 收藏 / 搜索 / 详情页都保持一致），
      // 不再要求 html.dyc-feed —— 只在刷视频页面生效会表现为"换个页面侧栏又出来了"。
      const hidden = fullHidden();
      document.documentElement.classList.toggle('dyc-nav-hidden', hidden);
      clearMarks();
      hideForced();

      if (nav) {
        retries = 0;
        if (D.settings.nav.mode === 'custom' && !hidden) hideItems();
      } else if (!hidden) {
        retryLater();
      }
      watch();
      D.log('nav: 模式=' + D.settings.nav.mode,
        '保留=' + ((D.settings.nav.keep || []).join('/') || '无'),
        'AI抖音=强制隐藏');

      // 调试探针：外部（CDP / 控制台）不用进隔离世界也能看到 nav 的实际执行情况，
      // 定位"直播站精简失效"这类问题时最省事。
      try {
        document.documentElement.setAttribute('data-dyc-nav-state', JSON.stringify({
          nav: !!nav,
          mode: D.settings.nav.mode,
          keep: (D.settings.nav.keep || []).length,
          rows: (function () { try { return rows().length; } catch (e) { return 'err'; } })(),
          hides: document.querySelectorAll('[data-dyc-nav-hide]').length,
          forced: document.querySelectorAll('[data-dyc-nav-force]').length,
          ts: Date.now()
        }));
      } catch (e) { /* 忽略 */ }
    },

    labels() {
      return rows().map(it => it.label).filter(l => !isForced(l));
    },

    // 页面重建侧边栏（切换侧边导航、SPA 重渲染）后，旧的 MutationObserver 会失效、
    // 标记也会随节点替换一起消失，表现为"换个侧边栏就又全部出现"。
    // main.js 的 2 秒看门狗会调这里：节点变了或标记没了就重新 apply 一次。
    verify() {
      if (D.settings && fullHidden()) return;
      const nav = navOf();
      if (!nav) return;
      if (nav !== lastNav) { this.apply(); return; }
      if (D.settings && D.settings.nav.mode === 'custom') {
        if (!document.querySelectorAll('[' + HIDE_ATTR + ']').length) this.apply();
      }
    },

    reset() {
      if (mo) { mo.disconnect(); mo = null; }
      clearTimeout(retryTimer);
      retryTimer = 0;
      retries = 0;
      lastNav = null;
      clearMarks();
      clearForced();
      document.documentElement.classList.remove('dyc-nav-hidden');
    }
  };
})();
