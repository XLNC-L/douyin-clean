/* 抖音净播 · 设置面板逻辑
 *
 * 设置写入 chrome.storage.sync，内容脚本监听 onChanged 后即时应用，不需要刷新页面。
 * 左侧导航的候选项从当前抖音标签页的内容脚本读取（打开面板时现取）。
 */
(() => {
  'use strict';
  const DEFAULTS = window.__DYC_DEFAULTS;
  const normalize = window.__DYC_NORMALIZE;
  if (!DEFAULTS || !normalize) return;

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  let settings = normalize(DEFAULTS);
  let navItems = [];
  let headerItems = [];
  let connected = false;
  let toastTimer = 0;

  function setStatus(text) {
    $('#status').textContent = text;
  }

  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 1400);
  }

  // 直播间精简的子项默认收起，点标题行的向下箭头展开；打开总开关时自动展开一次
  let liveOpen = false;

  function render() {
    $$('input[data-key]').forEach(el => {
      el.checked = !!settings[el.dataset.key];
    });
    $$('input[data-ui]').forEach(el => {
      el.checked = !!(settings.uiHide && settings.uiHide[el.dataset.ui]);
    });
    $$('input[name="navMode"]').forEach(el => {
      el.checked = el.value === settings.nav.mode;
    });
    $('#progressStyle').hidden = !settings.progress;
    $('#qualityCapRow').hidden = !settings.quality;
    $('#qualityCap').value = settings.qualityCap || 'max';
    renderColor();
    $('#navCustom').hidden = settings.nav.mode !== 'custom';
    $('#liveCustom').hidden = settings.liveClean === false || !liveOpen;
    $('#liveToggle').setAttribute('aria-expanded', String(!$('#liveCustom').hidden));
    $('#headerCustom').hidden = settings.header.mode === 'off';
    renderNav();
    renderLive();
    renderHeader();
    renderUiDeps();
    syncAll();
  }

  // 顶栏整条隐藏后，「搜索框」开关没有意义：灰显并禁用，避免误以为还能单独控制。
  function renderUiDeps() {
    const uh = settings.uiHide || {};
    const topbarHide = uh.topbar === true;
    $$('input[data-ui="search"]').forEach(el => {
      // 顶栏隐藏时统一显示为未勾选（顶栏本来就不在了），并禁用
      if (topbarHide) el.checked = false;
      el.disabled = topbarHide;
      const chip = el.closest('.chip');
      if (chip) chip.classList.toggle('is-disabled', topbarHide);
    });
  }

  // 两个折叠分组（页面元素 / 评论区）各自的总开关：全选勾上、部分选中半选。
  // 带 data-cm 的归「评论区」，其余归「页面元素」；被禁用的项（顶栏隐藏时的搜索框）不参与计数。
  function syncAll() {
    const boxes = $$('input[data-ui]');
    const set = (sel, list) => {
      const el = $(sel);
      if (!el) return;
      const usable = list.filter(b => !b.disabled);
      const on = usable.filter(b => b.checked).length;
      el.checked = usable.length > 0 && on === usable.length;
      el.indeterminate = on > 0 && on < usable.length;
    };
    set('#uiAll', boxes.filter(b => !b.hasAttribute('data-cm')));
    set('#cmAll', boxes.filter(b => b.hasAttribute('data-cm')));
  }

  function renderColor() {
    const color = settings.progressColor;
    const input = $('#progressColor');
    if (input && input.value.toLowerCase() !== color) input.value = color;
    $('#progressHex').textContent = color.toUpperCase();
    $$('#colorPresets .swatch').forEach(el => {
      el.setAttribute('aria-pressed', el.dataset.color === color ? 'true' : 'false');
    });
  }

  function renderNav() {
    const list = $('#navList');
    const hint = $('#navHint');
    list.textContent = '';

    if (!navItems.length) {
      // 当前标签不是抖音页时，用常见导航项兜底，避免「自定义」区空白
      if (connected) {
        hint.textContent = '当前页面没有识别到左侧导航项；先用下面的常见入口勾选，刷新抖音页后生效。';
      } else {
        hint.textContent = '打开抖音网页版并刷新后，这里会列出可保留的导航项；也可以先按常见入口勾选。';
      }
      for (const label of ['首页', '推荐', '关注', '朋友', '我的', '收藏', '观看历史']) {
        const chip = document.createElement('label');
        chip.className = 'chip';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = settings.nav.keep.indexOf(label) !== -1;
        cb.addEventListener('change', () => {
          const keepSet = new Set(settings.nav.keep);
          if (cb.checked) keepSet.add(label);
          else keepSet.delete(label);
          settings.nav.keep = Array.from(keepSet);
          settings.nav.mode = 'custom';
          save();
        });
        const span = document.createElement('span');
        span.textContent = label;
        chip.append(cb, span);
        list.append(chip);
      }
      return;
    }

    for (const label of navItems) {
      const chip = document.createElement('label');
      chip.className = 'chip';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = settings.nav.keep.indexOf(label) !== -1;
      cb.addEventListener('change', () => {
        const keep = new Set(settings.nav.keep);
        if (cb.checked) keep.add(label);
        else keep.delete(label);
        settings.nav.keep = Array.from(keep);
        save();
      });

      const text = document.createElement('span');
      text.textContent = label;

      chip.append(cb, text);
      list.append(chip);
    }
    hint.textContent = '未勾选的入口会被隐藏，改动即时生效；一个都不勾选时整条导航隐藏。侧栏底部的备案 / 协议信息（如京ICP）默认隐藏，「AI 抖音」入口始终隐藏。';
  }

  function renderLive() {
    const parts = settings.liveParts || {};
    $$('#liveList input[data-live-part]').forEach(el => {
      el.checked = parts[el.dataset.livePart] !== false;
    });
  }

  function renderHeader() {
    const on = settings.header.mode !== 'off';
    $('#headerSimple').checked = on;

    const list = $('#headerList');
    const hint = $('#headerHint');
    if (!list) return;
    list.textContent = '';
    if (!on) return;

    if (!headerItems.length) {
      // 当前标签不是抖音页（或还没识别到顶栏）时，用常见入口兜底，
      // 免得「自定义」区一片空白，看起来像功能没了。
      const defaults = ['通知', '消息', '投稿', '壁纸', '客户端', '充钻石'];
      if (connected) {
        hint.textContent = '当前页面没有识别到顶栏图标；先用下面的常见入口勾选，刷新抖音页后生效。';
      } else {
        hint.textContent = '打开抖音网页版并刷新后，这里会列出可保留的顶栏图标；也可以先按常见入口勾选。';
      }
      for (const label of defaults) {
        const chip = document.createElement('label');
        chip.className = 'chip';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = settings.header.keep.indexOf(label) !== -1;
        cb.addEventListener('change', () => {
          const keepSet = new Set(settings.header.keep);
          if (cb.checked) keepSet.add(label);
          else keepSet.delete(label);
          settings.header.keep = Array.from(keepSet);
          settings.header.mode = 'custom';
          save();
        });
        chip.appendChild(cb);
        const span = document.createElement('span');
        span.textContent = label;
        chip.appendChild(span);
        list.appendChild(chip);
      }
      return;
    }

    for (const label of headerItems) {
      const chip = document.createElement('label');
      chip.className = 'chip';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = settings.header.keep.indexOf(label) !== -1;
      cb.addEventListener('change', () => {
        const keep = new Set(settings.header.keep);
        if (cb.checked) keep.add(label);
        else keep.delete(label);
        settings.header.keep = Array.from(keep);
        settings.header.mode = 'custom';
        save();
      });

      const text = document.createElement('span');
      text.textContent = label;

      chip.append(cb, text);
      list.append(chip);
    }
    hint.textContent = '未勾选的图标会被隐藏，头像始终保留；一个都不勾选时只留头像。改动即时生效。';
  }

  // 立即写 storage：面板随时可能被点外面关掉，延迟保存会丢改动
  function save() {
    settings = normalize(settings);
    try {
      chrome.storage.sync.set({ settings }, () => {
        if (chrome.runtime.lastError) {
          toast('保存失败：' + chrome.runtime.lastError.message);
          return;
        }
        toast('已保存');
      });
    } catch (e) {
      toast('保存失败，请重新打开扩展');
    }
  }

  // 手动屏蔽规则库（存 local，不占 sync 配额）
  const RULE_KEY = 'dycBlockRules';

  async function getRules() {
    const res = await chrome.storage.local.get(RULE_KEY);
    const r = res && res[RULE_KEY];
    return {
      topics: Array.isArray(r && r.topics) ? r.topics : [],
      authors: Array.isArray(r && r.authors) ? r.authors : [],
      keywords: Array.isArray(r && r.keywords) ? r.keywords : []
    };
  }

  async function putRules(r) {
    await chrome.storage.local.set({ [RULE_KEY]: r });
  }

  async function refreshRules() {
    const el = $('#ruleDesc');
    const list = $('#ruleList');
    if (!el) return;
    try {
      const r = await getRules();
      const n = r.topics.length + r.authors.length + r.keywords.length;
      el.textContent = n
        ? ('关键词 ' + r.keywords.length + ' / 话题 ' + r.topics.length + ' / 作者 ' + r.authors.length)
        : '暂无规则';
      if (!list) return;
      list.textContent = '';
      // 关键词按原样展示，话题加 #，作者加 @；每条后面带一个删除按钮
      const addItem = (kind, value, label) => {
        const item = document.createElement('span');
        item.className = 'rule-item';
        const text = document.createElement('span');
        text.textContent = label;
        const del = document.createElement('button');
        del.type = 'button';
        del.title = '删除';
        del.textContent = '×';
        del.addEventListener('click', async () => {
          const cur = await getRules();
          cur[kind] = cur[kind].filter(v => v !== value);
          await putRules(cur);
          await refreshRules();
        });
        item.append(text, del);
        list.append(item);
      };
      r.keywords.forEach(k => addItem('keywords', k, k));
      r.topics.forEach(t => addItem('topics', t, '#' + t));
      r.authors.forEach(a => addItem('authors', a, '@' + a));
    } catch (e) {
      el.textContent = '读取失败';
    }
  }

  // 输入以 # 开头按话题存（匹配时要求文案里出现同名话题），否则按文案关键词存（子串匹配）
  async function addRule() {
    const inp = $('#ruleInput');
    if (!inp) return;
    const raw = String(inp.value || '').trim();
    if (!raw) return;
    const r = await getRules();
    if (raw.startsWith('#')) {
      const t = raw.replace(/^#+/, '').replace(/\s+/g, '');
      if (!t) { toast('请填写话题名称'); return; }
      if (r.topics.indexOf(t) < 0) r.topics.push(t);
    } else if (r.keywords.indexOf(raw) < 0) {
      r.keywords.push(raw);
    }
    await putRules(r);
    inp.value = '';
    await refreshRules();
    toast('已添加屏蔽规则');
  }

  function bind() {
    $$('input[data-key]').forEach(el => {
      el.addEventListener('change', () => {
        settings[el.dataset.key] = el.checked;
        // 进度条 / 直播间精简的开关会带出 / 收起对应的设置块
        if (el.dataset.key === 'progress' || el.dataset.key === 'liveClean') {
          if (el.dataset.key === 'liveClean') liveOpen = el.checked;
          render();
        }
        save();
      });
    });

    $('#qualityCap').addEventListener('change', () => {
      settings.qualityCap = $('#qualityCap').value;
      save();
    });

    // 页面元素：勾选 = 隐藏，取消 = 恢复显示
    $$('input[data-ui]').forEach(el => {
      el.addEventListener('change', () => {
        settings.uiHide = settings.uiHide || {};
        settings.uiHide[el.dataset.ui] = el.checked;
        // 「顶栏」决定「搜索框」能不能单独控制：勾上就灰显，取消就恢复，
        // 必须立即重算，否则要关掉面板再打开才更新。
        if (el.dataset.ui === 'topbar') renderUiDeps();
        syncAll();
        save();
      });
    });

    // 折叠分组（页面元素 / 评论区）：箭头展开收起 + 总开关一键全选/全不选
    function bindFold(toggleSel, foldSel, allSel, filter) {
      const fold = $(foldSel);
      const toggle = $(toggleSel);
      if (fold && toggle) {
        toggle.addEventListener('click', () => {
          const open = fold.hidden;
          fold.hidden = !open;
          toggle.setAttribute('aria-expanded', String(open));
        });
      }
      const all = $(allSel);
      if (!all) return;
      all.addEventListener('change', () => {
        const v = all.checked;
        settings.uiHide = settings.uiHide || {};
        $$('input[data-ui]').filter(filter).forEach(el => {
          el.checked = v;
          settings.uiHide[el.dataset.ui] = v;
        });
        renderUiDeps();
        syncAll();
        save();
      });
    }
    bindFold('#uiToggle', '#uiFold', '#uiAll', el => !el.hasAttribute('data-cm'));
    bindFold('#cmToggle', '#cmFold', '#cmAll', el => el.hasAttribute('data-cm'));

    // 直播间精简：标题行右侧的向下箭头展开 / 收起板块选项
    const liveToggle = $('#liveToggle');
    if (liveToggle) {
      liveToggle.addEventListener('click', () => {
        if (settings.liveClean === false) return;
        liveOpen = !liveOpen;
        $('#liveCustom').hidden = !liveOpen;
        liveToggle.setAttribute('aria-expanded', String(liveOpen));
      });
    }

    const colorInput = $('#progressColor');
    colorInput.addEventListener('input', () => {
      // 拖动取色器时只更新预览，避免高频写 chrome.storage
      settings.progressColor = colorInput.value.toLowerCase();
      renderColor();
    });
    colorInput.addEventListener('change', () => {
      settings.progressColor = colorInput.value.toLowerCase();
      renderColor();
      save();
    });

    $$('#colorPresets .swatch').forEach(el => {
      el.addEventListener('click', () => {
        settings.progressColor = el.dataset.color;
        renderColor();
        save();
      });
    });

    $$('input[name="navMode"]').forEach(el => {
      el.addEventListener('change', () => {
        if (!el.checked) return;
        settings.nav.mode = el.value;
        render();
        save();
      });
    });

    $('#headerSimple').addEventListener('change', () => {
      // 开关打开 = 按勾选项精简（custom），关闭 = 完全保持原样
      settings.header.mode = $('#headerSimple').checked ? 'custom' : 'off';
      render();
      save();
    });

    const headerDefaults = $('#headerDefaults');
    if (headerDefaults) {
      headerDefaults.addEventListener('click', () => {
        settings.header.mode = 'custom';
        settings.header.keep = ['通知', '消息'];
        render();
        save();
        toast('已恢复推荐：通知、消息与头像');
      });
    }

    $$('#liveList input[data-live-part]').forEach(el => {
      el.addEventListener('change', () => {
        settings.liveParts = settings.liveParts || {};
        settings.liveParts[el.dataset.livePart] = el.checked;
        save();
      });
    });

    const repo = $('#repoLink');
    if (repo) {
      repo.addEventListener('click', e => {
        e.preventDefault();
        chrome.tabs.create({ url: repo.href });
      });
    }

    $('#onlyMine').addEventListener('click', () => {
      settings.nav.mode = 'custom';
      settings.nav.keep = ['我的'];
      render();
      save();
      toast('已保留「我的」，其余入口隐藏');
    });

    $('#reset').addEventListener('click', () => {
      settings = normalize(DEFAULTS);
      render();
      save();
      toast('已恢复默认');
    });

    const clearBtn = $('#clearRules');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        try {
          await chrome.storage.local.set({ [RULE_KEY]: { topics: [], authors: [], keywords: [] } });
          await refreshRules();
          toast('已清空屏蔽规则');
        } catch (e) {
          toast('清空失败，请重新打开扩展');
        }
      });
    }

    const ruleAdd = $('#ruleAdd');
    if (ruleAdd) ruleAdd.addEventListener('click', addRule);
    const ruleInput = $('#ruleInput');
    if (ruleInput) {
      ruleInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addRule();
        }
      });
    }

  }

  async function readStored() {
    try {
      const res = await chrome.storage.sync.get({ settings: DEFAULTS });
      return res && res.settings;
    } catch (e) {
      return DEFAULTS;
    }
  }

  async function readPage() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || tab.id == null) {
        setStatus('没有可用的当前标签页');
        return;
      }
      const state = await chrome.tabs.sendMessage(tab.id, { type: 'dyc:get-state' });
      connected = true;
      navItems = (state && Array.isArray(state.navItems)) ? state.navItems.slice(0, 30) : [];
      headerItems = (state && Array.isArray(state.headerItems)) ? state.headerItems.slice(0, 20) : [];
      $('#ver').textContent = 'v' + (state && state.version ? state.version : chrome.runtime.getManifest().version);
      document.body.dataset.conn = 'on';
      setStatus('已连接当前抖音页面');
      render();
    } catch (e) {
      connected = false;
      document.body.dataset.conn = 'off';
      setStatus('当前标签页未连接，请在抖音页面刷新后重试');
      render();
    }
  }

  (async () => {
    settings = normalize(await readStored());
    $('#ver').textContent = 'v' + chrome.runtime.getManifest().version;
    render();
    bind();
    await refreshRules();
    await readPage();
  })();
})();
