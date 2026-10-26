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

  let mo = null;
  let raf = 0;
  let retries = 0;
  let retryTimer = 0;

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

  function hideItems() {
    const nav = navOf();
    if (!nav || D.settings.nav.mode !== 'custom' || fullHidden()) return;

    const keep = new Set(D.settings.nav.keep || []);
    const list = rows();
    if (!list.length) return;

    // 保底：设置里勾选的入口一个都没找到时，不隐藏任何项，
    // 避免因为抖音改版 / 页面还没渲染完而把整条导航清空。
    if (keep.size && !list.some(it => keep.has(it.label))) {
      clearMarks();
      D.log('nav: 保留项', Array.from(keep).join('/'), '不在当前导航里，本次不隐藏');
      return;
    }

    clearMarks();

    // 1) 未保留的入口行
    const keepRows = [];
    for (const it of list) {
      if (keep.has(it.label)) keepRows.push(it.row);
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
    if (!D.settings || D.settings.nav.mode !== 'custom' || fullHidden()) return;
    const nav = navOf();
    if (!nav) return;
    mo = new MutationObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        hideItems();
      });
    });
    // 只观察导航容器的子节点变化；我们只改属性，不会触发自己
    mo.observe(nav, { childList: true, subtree: true });
  }

  function retryLater() {
    if (retries >= 6 || retryTimer || fullHidden()) return;
    retries++;
    retryTimer = setTimeout(() => {
      retryTimer = 0;
      if (D.settings.nav.mode !== 'custom' || fullHidden()) return;
      if (navOf()) apply();
      else retryLater();
    }, 1000);
  }

  D.nav = {
    apply() {
      const nav = navOf();
      if (!document.documentElement.classList.contains('dyc-feed')) {
        clearMarks();
        return;
      }
      const hidden = fullHidden();
      document.documentElement.classList.toggle('dyc-nav-hidden', hidden);
      clearMarks();

      if (nav && D.settings.nav.mode === 'custom' && !hidden) {
        retries = 0;
        hideItems();
      } else if (!nav && D.settings.nav.mode === 'custom' && !hidden) {
        retryLater();
      }
      watch();
      D.log('nav: 模式=' + D.settings.nav.mode,
        '保留=' + ((D.settings.nav.keep || []).join('/') || '无'));
    },

    labels() {
      return rows().map(it => it.label);
    },

    reset() {
      if (mo) { mo.disconnect(); mo = null; }
      clearTimeout(retryTimer);
      retryTimer = 0;
      retries = 0;
      clearMarks();
      document.documentElement.classList.remove('dyc-nav-hidden');
    }
  };
})();
