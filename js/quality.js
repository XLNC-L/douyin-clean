/* 自动最高清晰度 v1.6.1
 *
 * 实测结构（2026-10 抖音新版播放器，容器从 .xgplayer 更名为 .douyin-player，
 * 组件从 <xg-icon class="xgplayer-playclarity-setting"> 更名为
 * <dy-icon class="douyin-player-playclarity-setting">，内部结构不变）：
 *   <dy-icon class="douyin-player-playclarity-setting">
 *     <div class="gear">
 *       <div class="virtual">                    <!-- 档位常驻 DOM，菜单关闭时也读得到 -->
 *         <div class="item selected">...<span>高清 1080P</span>...</div>
 *         <div class="item">高清 720P</div>
 *         <div class="item">智能</div>
 *       </div>
 *       <div class="btn btnV2" data-popupid="...">高清 1080P</div>
 *     </div>
 *   </dy-icon>
 * 兼容旧版 .xgplayer / .xgplayer-playclarity-setting 选择器。
 *
 * 历次实测要点：
 *   1) 点击用原生 HTMLElement.click()，走 app 自己的事件委托链（合成坐标事件不被接受）；
 *   2) 点击后一律用 <video> 的 videoWidth/videoHeight（真实解码分辨率）复验，不以菜单文字为准；
 *   3) 某档点完分辨率反而变低 = 该档不可用并触发顺延降级，立即点回原档止损；
 *   4) 单条视频只做一轮，不无限点、不抖动；真正实测到 4K 才对本条视频停手（换下一条会重新判断）；
 *   5) 4K 换流比低档慢得多，等待期间绝不能转去点别的档（会把换流打断）。
 */
(() => {
  const D = window.__DYC;
  if (!D) return;

  const R4K = 10;              // 4K 的档位分值
  // popup 设置：关闭后不再调度、不再开档位菜单（正在进行的一轮会自行收尾）
  const enabled = () => !D.settings || D.settings.quality !== false;
  let got4K = false;           // 【当前这条视频】已实测到 4K，本轮不再调整
  let timer = 0;
  let running = false;
  let lastRun = 0;             // 上次调度的时刻（节流用）
  let lastDone = 0;            // 上轮评估结束的时刻
  let curVideo = null;
  let job = 0;                 // 每次调度递增，旧任务自动作废
  let pending = false;         // 切换过程中收到的新调度：等这一轮结束再补
  let qGen = -1;               // 上次处理过的视频代次（见 core.js 的 D.gen）
  let maxedGen = -1;           // 已经确认"这条视频已是最高档"的代次，不再重复评估
  let queuedGen = -1;          // 已经为哪个代次排过队（防止同一条视频被反复排队、把排队中的任务作废）
  const dead = new Map();      // 档位文本 -> 冷却截止时间（点过但没生效的档不再反复点）

  const isDead = txt => {
    const t = dead.get(txt);
    return !!t && Date.now() < t;
  };
  const markDead = txt => dead.set(txt, Date.now() + 30000);

  // 以分辨率为准，兼顾中文档位名（D.textOf 会压掉空格，所以只匹配数字和关键字）
  // 注意：数字必须优先于"高清/标清"这类文字判断，否则"高清 720P"会被当成 1080P 同档。
  function rank(t) {
    if (!t) return 0;
    const s = String(t).toUpperCase();
    if (/4K|2160/.test(s)) return 10;
    if (/2K|1440/.test(s)) return 9;
    if (/蓝光|超清/.test(t)) return 8;
    if (/1080/.test(s)) return 7;
    if (/720/.test(s)) return 6;
    if (/540|480/.test(s)) return 5;
    if (/标清/.test(t)) return 4;
    if (/高清/.test(t)) return 7;
    if (/流畅|360/.test(s)) return 3;
    if (/智能|自动|AUTO|SMART/.test(s)) return 1;
    return 0;
  }

  // 档位对应的标称长边。抖音竖屏为主，"720P" 的视频是 720×1280，
  // 所以用 max(videoWidth, videoHeight) 判断比看宽高更稳。
  function nominal(t) {
    const s = String(t).toUpperCase();
    if (/4K|2160/.test(s)) return 3840;
    if (/2K|1440/.test(s)) return 2560;
    if (/1080/.test(s)) return 1920;
    if (/720/.test(s)) return 1280;
    if (/540/.test(s)) return 960;
    if (/480/.test(s)) return 854;
    return 0;                  // 智能/未知档不做分辨率校验
  }

  function actualMax(v) {
    return v ? Math.max(v.videoWidth || 0, v.videoHeight || 0) : 0;
  }

  // 新版播放器容器是 .douyin-player，旧版是 .xgplayer；清晰度组件同理
  const GROUP_SEL = '.xgplayer, .douyin-player';
  const COMP_SEL = '.xgplayer-playclarity-setting, .douyin-player-playclarity-setting';

  function groupOf(v) {
    if (v && v.closest) {
      const vp = v.closest(GROUP_SEL);
      if (vp) {
        const g = vp.querySelector(COMP_SEL);
        if (g) return g;
      }
    }
    // 兜底：页面里可见的清晰度组件中，挑离视频右下角最近的那个
    const all = document.querySelectorAll(COMP_SEL);
    if (!all.length) return null;
    if (!v) return all[0];
    const vr = v.getBoundingClientRect();
    let best = null;
    let bestD = Infinity;
    for (const g of all) {
      const r = g.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const d = Math.abs(r.left - vr.right) + Math.abs(r.bottom - vr.bottom);
      if (d < bestD) { bestD = d; best = g; }
    }
    return best;
  }

  const btnOf = g => (g ? g.querySelector('.gear .btn') || g.querySelector('.btn') : null);
  const itemsOf = g => (g ? Array.from(g.querySelectorAll('.virtual .item')) : []);

  function currentOf(g) {
    const sel = g ? g.querySelector('.virtual .item.selected') : null;
    if (sel) return D.textOf(sel);
    const b = btnOf(g);
    return b ? D.textOf(b) : '';
  }

  // 换弹层里的 item 引用（弹层可能在每次悬停时重建，旧引用会失效）
  function freshItem(g, txt) {
    for (const it of itemsOf(g)) if (D.textOf(it) === txt) return it;
    return null;
  }

  // 用播放器自己的按钮把清晰度菜单点开。
  // 关键：合成 PointerEvent/MouseEvent 一直不被接受，这里改用原生 HTMLElement.click()，
  // 它会生成真正的 click 事件、走 app 自己的事件委托链，和用户用鼠标点一下是同一条路径。
  // 同时仍加 .dyc-open，保证档位节点有真实坐标、不被隐藏样式挡住。
  function openMenu(g) {
    if (!g) return false;
    const b = btnOf(g);
    const v = g.querySelector('.virtual');
    // 先看 app 自己有没有已经把菜单打开（鼠标正好停在按钮上时会这样），
    // 已经打开就不要再点按钮，否则会把它关回去。
    const shown = v
      ? (getComputedStyle(v).display !== 'none' && getComputedStyle(v).visibility !== 'hidden')
      : false;
    g.classList.add('dyc-open');
    if (!b || shown) return !!b;
    try { b.click(); return true; } catch (e) { return false; }
  }

  // 收起：先撤掉强制展开的 class；若 app 的菜单还停留在展开状态，再点一次按钮关掉
  function closeMenu(g) {
    if (!g) return;
    g.classList.remove('dyc-open');
    const v = g.querySelector('.virtual');
    if (!v) return;
    const cs = getComputedStyle(v);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const b = btnOf(g);
    try { if (b) b.click(); } catch (e) { /* 忽略 */ }
  }

  // 直接点档位项：原生 click（不是自己构造的事件对象）
  function press(el) {
    if (!el) return false;
    try { el.click(); return true; } catch (e) { return false; }
  }

  function rowsOf(g) {
    const out = [];
    for (const el of itemsOf(g)) {
      const txt = D.textOf(el);
      const rk = rank(txt);
      if (rk <= 0) continue;
      out.push({
        el, txt, rk,
        nom: nominal(txt),
        selected: el.classList.contains('selected')
      });
    }
    return out;
  }

  function snapshot(g) {
    const rows = rowsOf(g);
    const cur = currentOf(g);
    return {
      rows, cur, curRank: rank(cur),
      sig: cur + '|' + rows.map(r => r.txt + (r.selected ? '*' : '')).join(',')
    };
  }

  // 换片瞬间档位表往往还是上一条的，连续读取到内容稳定为止（约 1.6 秒）
  async function stableSnap(g) {
    let prev = snapshot(g);
    for (let i = 0; i < 4; i++) {
      await D.sleep(400);
      const now = snapshot(g);
      if (now.sig === prev.sig) return now;
      prev = now;
    }
    return prev;
  }

  // 等实测分辨率爬到目标值：每 0.5 秒读一次 videoWidth/videoHeight（纯属性读，没有 DOM 查询）。
  // 只在达标时提前返回，不因中途短暂变低就结束 —— 换流过程中会先落到中间档，
  // 那不是最终结果，以前就是在这里误判并转去点 2K，把 4K 换流打断了。
  async function waitFor(v, nom, maxMs, id) {
    let after = actualMax(v);
    if (nom > 0 && after >= nom * 0.9) return after;
    const wasPlaying = !v.paused;
    for (let t = 0; t < maxMs; t += 500) {
      await D.sleep(500);
      if (id !== job) return actualMax(v);      // 这一轮已被作废（换了新视频）
      after = actualMax(v);
      if (nom > 0 && after >= nom * 0.9) return after;
      if (got4K) return after;
      // 换流期间播放器可能自动暂停，顺手恢复
      if (wasPlaying && v.paused) {
        try { await v.play(); } catch (e) { /* 忽略 */ }
      }
    }
    return after;
  }

  // attempt 期间 schedule 只登记不排任务，收尾后再补排一次
  function flushPending() {
    if (!pending) return;
    pending = false;
    if (got4K) return;
    lastRun = 0;
    setTimeout(() => {
      if (!got4K && !running && curVideo) D.quality.schedule(curVideo);
    }, 1200);
  }

  async function attempt(id, gen0) {
    // 早退时必须把排队标记清掉，否则这条视频再也排不上队
    if (!enabled() || running || got4K || id !== job) { queuedGen = -1; return; }
    if (gen0 !== qGen) { queuedGen = -1; return; }          // 视频已经换了，这一轮作废
    if (!document.documentElement.classList.contains('dyc-feed')) { queuedGen = -1; return; }

    const v = (curVideo instanceof HTMLVideoElement) ? curVideo : D.playingVideo();
    // 刚换视频时清晰度组件可能还停留在上一条的状态，等元数据就绪再看。
    // 以前这里直接 return，视频刚起播（readyState=0）时就永久放弃，
    // 而抖音换片后 emptied/loadedmetadata 只来一次，于是这条视频再也不会调清晰度。
    if (!v || v.readyState < 1) {
      queuedGen = -1;
      setTimeout(() => {
        if (!got4K && !running && curVideo) D.quality.schedule(curVideo);
      }, 1000);
      return D.log('quality: 元数据未就绪，1 秒后重试');
    }

    const g = groupOf(v);
    if (!g) { queuedGen = -1; return D.log('quality: 找不到清晰度组件'); }

    // 用播放器自己的按钮点开菜单（原生 click，走 app 自己的事件链），
    // 档位节点由 app 自己渲染；只点一次，重复点会把已经打开的菜单又关回去。
    openMenu(g);
    for (let i = 0; i < 6 && !itemsOf(g).length; i++) {
      await D.sleep(250);
      if (id !== job) { closeMenu(g); queuedGen = -1; return; }
    }
    if (!itemsOf(g).length) {
      closeMenu(g);
      queuedGen = -1;
      // 档位表可能还没请求回来：1.5 秒后再排一次，别像上一版那样一次失败就彻底不管
      setTimeout(() => { if (!got4K && !running) D.quality.schedule(v); }, 1500);
      return D.log('quality: 档位列表还没建好（按钮点了但没渲染出档位）');
    }
    D.log('quality: 档位节点', itemsOf(g).length, '个');

    // 弹层从这里一直保持展开到 finally，中途绝不收起：
    // 收起会触发抖音卸载 .virtual 里的档位节点，之后再点按钮时已经完全找不到 item。
    const s = await stableSnap(g);
    if (id !== job || got4K) { closeMenu(g); queuedGen = -1; return; }

    const rows = s.rows.slice().sort((a, b) => b.rk - a.rk);
    if (!rows.length) { closeMenu(g); queuedGen = -1; return D.log('quality: 没读到任何档位'); }

    const before = actualMax(v);
    const top = rows[0];
    D.log('quality: 当前=' + (s.cur || '未知'), '实测=' + before + 'p', '最高档=' + top.txt);

    // 实测分辨率已经到最高档的标称值：不需要动作
    if (top.nom > 0 && before >= top.nom * 0.9) {
      maxedGen = gen0;                 // 这条视频到此为止，后续 emptied 不再重开菜单
      if (top.rk >= R4K) {
        got4K = true;
        D.log('quality: 实测已是 4K(' + before + ')，本条视频不再调整');
      } else {
        D.log('quality: 实测已是该视频最高档(' + before + ')，等下一条');
      }
      closeMenu(g);
      lastDone = Date.now();
      queuedGen = -1;
      return;
    }

    // 一条视频只点最高档一次，然后耐心等它换流完成。
    // 关键教训：4K 换流比 2K 慢得多，以前等 2.6 秒就判失败再去点 2K，
    // 反而把正在进行的 4K 换流打断，结果永远停在 2K。
    // 另一个更隐蔽的坑：换流会改 <video>.src，看门狗的"换视频"判断会因此触发
    // 新的 schedule 并把本轮任务号作废。现在 attempt 期间 schedule 只登记不排任务。
    running = true;
    try {
      // 菜单显示的当前档已经是最高的：说明选择已生效，只是在换流。
      // 这时再点一次会把换流打回去，所以只等、不点。
      if (s.curRank >= top.rk && !isDead(top.txt)) {
        const budget = top.rk >= R4K ? 15000 : 8000;
        D.log('quality: 菜单已是', s.cur, '，等换流（最多', budget / 1000, '秒）');
        const after = await waitFor(v, top.nom, budget, id);
        if (top.nom > 0 && after >= top.nom * 0.9) {
          maxedGen = gen0;
          if (after >= 3400) {
            got4K = true;
            D.log('quality: 实测已到 4K(' + after + ')，本条视频不再调整');
          } else {
            D.log('quality: 实测已到', after + 'p（' + (currentOf(g) || '') + '）');
          }
        } else {
          // 菜单选了却没有对应画面：这条视频没有该档源，记入本条视频的冷却，别循环空等。
          // 实测为 0 说明这一刻还没解码出画面（正在换流），不能据此判定该档不可用。
          if (after > 0) markDead(top.txt);
          D.log('quality: 菜单已是', currentOf(g) || s.cur, '，但实测仍为', after + 'p');
        }
      } else {
        let clicked = 0;
        for (const row of rows) {
          if (got4K || clicked >= 1) break;                        // 只点一次，不链式降级
          if (row.nom > 0 && before >= row.nom * 0.9) continue;     // 这一档实测已经达标
          if (isDead(row.txt)) continue;                            // 这一档在本次视频里试过且失败

          const el = freshItem(g, row.txt);
          if (!el) continue;

          D.log('quality: 点档位', row.txt);
          if (!press(el)) {
            D.log('quality: 档位点击失败，跳过', row.txt);
            continue;
          }
          clicked++;

          const budget = row.rk >= R4K ? 15000 : 8000;
          const after = await waitFor(v, row.nom, budget, id);
          const nowCur = currentOf(g);

          // 达标：停手（只有实测到 4K 才整场 stop）
          if (row.nom > 0 && after >= row.nom * 0.9) {
            maxedGen = gen0;
            if (after >= 3400) {
              got4K = true;
              D.log('quality: 实测已到 4K(' + after + ')，本条视频不再调整');
            } else {
              D.log('quality: 已切到', nowCur || after + 'p', '（实测 ' + after + 'p）');
            }
            break;
          }

          // 菜单仍停在这一档 = 抖音接受了这次选择，只是长视频 4K 换流还没完成
          // （视频越长，换流越慢）。这时绝不能记冷却，交给下一轮继续等。
          if (rank(nowCur) >= row.rk) {
            D.log('quality:', row.txt, '已选中，仍在换流（实测', after + 'p', '），下一轮继续等');
            break;
          }

          // 分辨率变低 = 抖音把这一档顺延到了更低档，立刻点回原档止损
          if (before > 0 && after > 0 && after < before) {
            markDead(row.txt);
            D.log('quality:', row.txt, '不可用并触发降级（' + before + '→' + after + '），立即回滚');
            const back = freshItem(g, s.cur);
            if (back) press(back);
            break;
          }

          // 等够了既没达标也没降级：多见于此视频没有这条源，抖音静默顺延到下一个可用档。
          // 冷却只作用于当前这条视频，换下一条会清空（见 schedule 里的代次判断）。
          // 实测 0p = 还没解码出画面，不记冷却。
          if (after > 0) markDead(row.txt);
          D.log('quality:', row.txt, '未生效（实测', after + 'p', '，菜单=' + (nowCur || '未知') + '）');
        }
      }
    } finally {
      closeMenu(g);
      running = false;
      queuedGen = -1;
      lastDone = Date.now();
      flushPending();
    }
  }

  D.quality = {
    // 抖音用一个 <video> 元素播所有视频，src 也可能是不变的 blob:，
    // 所以不按 src 去重：每次媒体重新加载都重新判断一次。
    // 重复判断是幂等的（实测已达标就什么都不做）；
    // 两次评估之间至少隔 4 秒，避免同一条视频被反复点。
    schedule(video) {
      if (!(video instanceof HTMLVideoElement)) return;
      if (!enabled()) return;

      // 换了视频：4K 闩锁和档位冷却都只对"那一条视频"有效，必须一起重置。
      // 以前 got4K 是整场会话一次性的 —— 只要有任何一条视频到过 4K，
      // 后面所有视频都不再调清晰度，这正是"后面的视频不往高画质切"的原因。
      if (D.gen !== qGen) {
        qGen = D.gen;
        got4K = false;
        dead.clear();
      }
      if (got4K) return;
      // 这条视频已经确认过"实测已是最高档"：别再重复点开档位菜单
      // （抖音的 emptied 事件会反复触发，不拦一下会每隔几秒就白开一次菜单）
      if (maxedGen === qGen) return;
      curVideo = video;

      // 换流进行中收到的调度，多数是换流自己改 src 让看门狗误判成"换视频"，
      // 只登记、不递增任务号 —— 否则会把正在等 4K 换流的那一轮直接作废。
      if (running) {
        pending = true;
        return;
      }

      // 同一条视频已经有一个排队中的任务：直接返回。
      // 【这是"清晰度失效"的真正原因】抖音换片会触发 emptied、播放中还会触发 playing，
      // 看门狗每 2 秒又比对一次 src（MSE 流自己会变），于是 schedule 每隔一两秒就被调一次。
      // 以前每次都会 job++，而 attempt 要等 QUALITY_DELAY(1.6s) 才执行，
      // 等它跑起来 id 早就不是 job 了，第一行 `id !== job` 直接 return ——
      // 结果一条日志都不打、画质永远停在初始档，表现得就像功能完全没生效。
      if (queuedGen === qGen) return;

      const now = Date.now();
      if (now - lastRun < 700) return;
      lastRun = now;
      job++;
      const id = job;
      const gen0 = qGen;
      queuedGen = gen0;
      const wait = Math.max(D.QUALITY_DELAY, 4000 - (now - lastDone));
      timer = setTimeout(() => {
        timer = 0;
        D.idle(() => attempt(id, gen0));
      }, wait);
    },
    applySettings() {
      if (!enabled() || !document.documentElement.classList.contains('dyc-feed')) {
        this.reset();
        return;
      }
      const v = D.playingVideo();
      if (v) this.schedule(v);
    },
    probe() {
      const v = D.playingVideo();
      const g = groupOf(v);
      const rows = g ? rowsOf(g).sort((a, b) => b.rk - a.rk) : [];
      return {
        组件: !!g,
        当前: g ? currentOf(g) : null,
        档位: rows.map(r => r.txt + (r.selected ? '(当前)' : '') + (isDead(r.txt) ? '(冷却)' : '')),
        实测: actualMax(v) + 'p',
        已到4K: got4K,
        组件结构: g ? g.outerHTML.replace(/\s+/g, ' ').slice(0, 800) : ''
      };
    },
    reset() {
      clearTimeout(timer);
      timer = 0;
      lastRun = 0;
      lastDone = 0;
      got4K = false;
      curVideo = null;
      qGen = -1;
      maxedGen = -1;
      queuedGen = -1;
      pending = false;
      running = false;   // 路由切换 teardown 时强制解锁，避免 attempt 卡死后全场不再调度
      dead.clear();
      job++;
    }
  };
})();
