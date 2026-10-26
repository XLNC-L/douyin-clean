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

  function render() {
    $$('input[data-key]').forEach(el => {
      el.checked = !!settings[el.dataset.key];
    });
    $$('input[name="navMode"]').forEach(el => {
      el.checked = el.value === settings.nav.mode;
    });
    $$('input[name="headerMode"]').forEach(el => {
      el.checked = el.value === settings.header.mode;
    });
    $('#progressStyle').hidden = !settings.progress;
    renderColor();
    $('#navCustom').hidden = settings.nav.mode !== 'custom';
    $('#headerCustom').hidden = settings.header.mode !== 'custom';
    renderNav();
    renderHeader();
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
      hint.textContent = connected
        ? '当前页面没有识别到左侧导航项；切换模式后刷新抖音页面再试。'
        : '打开抖音网页版并刷新后，这里会列出可保留的导航项；也可以直接使用「仅保留我的」。';
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
    hint.textContent = '未勾选的入口会被隐藏，改动即时生效；一个都不勾选时整条导航隐藏。「AI 抖音」入口始终隐藏。';
  }

  function renderHeader() {
    const list = $('#headerList');
    const hint = $('#headerHint');
    list.textContent = '';

    if (!headerItems.length) {
      hint.textContent = connected
        ? '当前页面没有识别到可自定义的顶栏图标；打开抖音视频页并刷新后再试。'
        : '打开抖音网页版并刷新后，这里会列出可保留的顶栏图标。';
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
        save();
      });

      const text = document.createElement('span');
      text.textContent = label;

      chip.append(cb, text);
      list.append(chip);
    }
    hint.textContent = '未勾选的图标会被隐藏，改动即时生效；一个都不勾选时只保留头像。';
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

  function bind() {
    $$('input[data-key]').forEach(el => {
      el.addEventListener('change', () => {
        settings[el.dataset.key] = el.checked;
        // 进度条开关会带出 / 收起颜色设置块
        if (el.dataset.key === 'progress') render();
        save();
      });
    });

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

    $$('input[name="headerMode"]').forEach(el => {
      el.addEventListener('change', () => {
        if (!el.checked) return;
        settings.header.mode = el.value;
        render();
        save();
      });
    });

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
      setStatus('已连接当前抖音页面');
      render();
    } catch (e) {
      connected = false;
      setStatus('当前标签页未连接，请在抖音页面刷新后重试');
      render();
    }
  }

  (async () => {
    settings = normalize(await readStored());
    $('#ver').textContent = 'v' + chrome.runtime.getManifest().version;
    render();
    bind();
    await readPage();
  })();
})();
