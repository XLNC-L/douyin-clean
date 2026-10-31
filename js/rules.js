/* 手动屏蔽规则库（第 2 项）
 *
 * 为什么需要：品牌二创 / 原生广告这类内容，抖音自己不打广告标、没有购物车、没有预约按钮，
 * 纯语义规则去判必然误伤（比如"#原神创作者激励计划"下大量优质二创会被一起跳掉）。
 * 手动标记是唯一零误伤的路径，而且样本会越攒越准。
 *
 * 交互：在看视频时按 Alt + Shift + X
 *   - 第一次：把当前视频的「话题集合 + 作者 ID」写进本地规则库，并立刻跳过这条；
 *   - 再按一次（话题/作者已在库里）：取消屏蔽。
 *   - 右下角有一个 2 秒的提示，避免"按了没反应"。
 *
 * 存储：chrome.storage.local（不占 sync 配额，样本多也不会超限）；改动通过 onChanged 实时生效。
 */
(() => {
  'use strict';
  const D = window.__DYC;
  if (!D) return;

  const KEY = 'dycBlockRules';
  const MAX = 200;
  let rules = { topics: [], authors: [] };

  const norm = s => String(s || '').replace(/\s+/g, '').trim();
  const uniq = arr => Array.from(new Set(arr.filter(Boolean)));

  function load() {
    try {
      chrome.storage.local.get(KEY, obj => {
        const r = obj && obj[KEY];
        if (!r || typeof r !== 'object') return;
        const topics = Array.isArray(r.topics) ? r.topics : [];
        const authors = Array.isArray(r.authors) ? r.authors : [];
        rules = {
          topics: topics.filter(s => typeof s === 'string' && s).slice(0, MAX),
          authors: authors.filter(s => typeof s === 'string' && s).slice(0, MAX)
        };
      });
    } catch (e) { /* 忽略 */ }
  }

  function save() {
    try { chrome.storage.local.set({ [KEY]: rules }); } catch (e) { /* 忽略 */ }
  }

  function cardOf(video) {
    if (!video) return null;
    return video.closest('[data-e2e="feed-active-video"], [data-e2e="feed-item"], .slider-video');
  }

  function descOf(card) {
    return card ? card.querySelector('.video-info-detail, [data-e2e*="video-desc"], [data-e2e*="video-info"]') : null;
  }

  function topicsOf(card) {
    const el = descOf(card);
    const text = D.textOf(el || card);
    const out = [];
    const re = /#([^#，,。.!！?？\s]{1,24})/g;
    let m;
    while ((m = re.exec(text))) out.push(norm(m[1]));
    return uniq(out).slice(0, 12);
  }

  function authorOf(card) {
    if (!card) return '';
    const a = card.querySelector('a[href*="/user/"]');
    if (a) {
      const href = a.getAttribute('href') || '';
      const m = /\/user\/([A-Za-z0-9_-]{10,})/.exec(href);
      if (m) return m[1];
    }
    const nick = card.querySelector('[data-e2e="feed-video-nickname"]');
    return nick ? norm(D.textOf(nick)).replace(/^@/, '') : '';
  }

  function infoOf(video) {
    const card = cardOf(video);
    if (!card) return null;
    return { card, topics: topicsOf(card), author: authorOf(card) };
  }

  // 命中返回原因字符串（供 filter 当作强信号），否则空串
  function match(card) {
    if (!card) return '';
    if (!rules.topics.length && !rules.authors.length) return '';
    const desc = descOf(card);
    const text = D.textOf(desc || card);
    for (const t of rules.topics) {
      if (t && text.indexOf('#' + t) >= 0) return '手动屏蔽(话题#' + t + ')';
    }
    const author = authorOf(card);
    if (author && rules.authors.indexOf(author) >= 0) return '手动屏蔽(作者)';
    return '';
  }

  function toast(msg) {
    try {
      let el = document.getElementById('dyc-rule-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'dyc-rule-toast';
        el.style.cssText = 'position:fixed;right:24px;bottom:88px;z-index:2147483000;' +
          'padding:9px 13px;border-radius:8px;background:rgba(0,0,0,.84);color:#fff;' +
          'font-size:13px;line-height:1.45;max-width:340px;box-shadow:0 6px 18px rgba(0,0,0,.38);' +
          'transition:opacity .18s ease;opacity:0;pointer-events:none';
        document.body.appendChild(el);
      }
      el.textContent = msg;
      el.style.opacity = '1';
      clearTimeout(el._dycT);
      el._dycT = setTimeout(() => { el.style.opacity = '0'; }, 2200);
    } catch (e) { /* 忽略 */ }
  }

  function toggle() {
    const v = D.playingVideo();
    const info = infoOf(v);
    if (!info) { toast('没找到当前视频，先刷到视频再按'); return; }

    const dupTopics = info.topics.filter(t => rules.topics.indexOf(t) >= 0);
    const dupAuthor = !!info.author && rules.authors.indexOf(info.author) >= 0;

    if (dupTopics.length || dupAuthor) {
      rules.topics = rules.topics.filter(t => dupTopics.indexOf(t) < 0);
      rules.authors = rules.authors.filter(a => a !== info.author);
      save();
      toast('已取消屏蔽：' + (dupTopics.length ? '#' + dupTopics.join(' #') : '') +
        (dupAuthor ? ' @' + info.author : ''));
      return;
    }

    if (info.topics.length) rules.topics = uniq(rules.topics.concat(info.topics)).slice(-MAX);
    if (info.author) rules.authors = uniq(rules.authors.concat([info.author])).slice(-MAX);
    save();

    const parts = [];
    if (info.topics.length) parts.push('话题 #' + info.topics.slice(0, 3).join(' #'));
    if (info.author) parts.push('作者 @' + info.author);
    toast('已屏蔽 ' + (parts.join('、') || '（这条没有话题，按作者屏蔽）') +
      '，之后自动跳过；再按 Alt+Shift+X 可取消');

    // 立刻把当前这条切走（走 filter 的强信号路径，暂停状态也能跳）。
    // 用 forceCheck：这条视频的判定窗口可能已经用满，checkAd 会被窗口挡住。
    if (D.filter && D.filter.forceCheck) D.filter.forceCheck(v);
    else if (D.filter && D.filter.checkAd) setTimeout(() => D.filter.checkAd(v), 0);
  }

  window.addEventListener('keydown', e => {
    if (!e.altKey || !e.shiftKey || e.key.toLowerCase() !== 'x') return;
    if (!D.route || !D.route.feed) return;
    e.preventDefault();
    toggle();
  }, { passive: false });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[KEY]) return;
      const r = changes[KEY].newValue;
      if (!r || typeof r !== 'object') { rules = { topics: [], authors: [] }; return; }
      rules = {
        topics: Array.isArray(r.topics) ? r.topics.slice(0, MAX) : [],
        authors: Array.isArray(r.authors) ? r.authors.slice(0, MAX) : []
      };
    });
  } catch (e) { /* 忽略 */ }

  load();

  D.rules = {
    match,
    toggle,
    infoOf,
    toast,
    get: () => rules
  };
})();
