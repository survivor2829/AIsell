/* 产品详情图的 AI 工作台（用户 2026-11-24：让老板看得见 AI 在干活、怎么干）。
   与桌面主界面的 AgentStage 同一套看法：产物卡片 + 带名字的彩色光标 + 执行日志，只由任务真实状态推出。
   这里是嵌入页（Flask 模板），所以用原生 JS 实现。动效跟一个每秒一次的心跳走、任务结束即停，不用无限 CSS 动画。 */
(function () {
  'use strict';
  const RUNNING = new Set(['pending', 'running', 'running_planner', 'running_generator', 'running_assembler', 'running_recovery']);
  const FAILED = new Set(['failed', 'outcome_unknown', 'recovery_required', 'pricing_required']);
  const DESIGNER_COLORS = ['#fb923c', '#f59e0b', '#fbbf24', '#fdba74', '#f97316', '#fcd34d', '#fed7aa', '#ea580c'];

  function screenTitle(screen, index) {
    const raw = screen && (screen.title || screen.headline || screen.role || screen.type);
    return raw ? String(raw).slice(0, 14) : `第 ${index + 1} 屏`;
  }
  // Each screen's own record (pipeline_runner checkpoint): prepared/submitted → raw_url → downloaded (success);
  // error or placeholder means that screen did not come out. Nothing is guessed from concurrency.
  function screenOf(block) {
    if (!block) return 'queued';
    if (block.success) return 'done';
    if (block.error || block.placeholder) return 'failed';
    if (block.raw_url) return 'fetching';
    if (block.provider_task_id || block.provider_status) return 'drawing';
    return 'queued';
  }

  // The whole model comes from the status the page already polls.
  function detailStageModel(state) {
    const status = String(state.status || '');
    const failed = FAILED.has(status);
    const finished = status === 'success' || status === 'partial_success';
    const planning = state.planning && Array.isArray(state.planning.screens) ? state.planning.screens : [];
    const blocks = Array.isArray(state.blocks) ? state.blocks : [];
    const reroll = Number.isInteger(state.reroll_index) ? state.reroll_index : null;
    const total = reroll !== null ? planning.length : (Number(state.planned_count) || planning.length || blocks.length);
    // A single-screen redo: the other screens are kept; only the redone one has a record of its own.
    const screen = (index) => reroll !== null ? (index === reroll ? screenOf(blocks.length === 1 ? blocks[0] : blocks[index]) : 'done') : screenOf(blocks[index]);
    const states = Array.from({ length: total }, (_, index) => screen(index));
    const planned = planning.length > 0 || blocks.length > 0;
    const allReady = total > 0 && states.every((value) => value === 'done');
    // The step reached: a failure stays on the step it happened in.
    const phase = finished ? 3 : status === 'running_assembler' || (failed && allReady) ? 2
      : status === 'running_generator' || status === 'running_recovery' || (failed && planned) ? 1 : 0;
    const at = (step) => phase > step ? 'done' : phase === step ? (failed ? 'fail' : 'now') : 'wait';
    const drawing = [];
    states.forEach((value, index) => { if (value === 'drawing' || value === 'fetching') drawing.push(index); });
    const cardState = (value) => value === 'done' ? 'done' : value === 'failed' ? 'fail' : (value === 'drawing' || value === 'fetching') && !failed && phase === 1 ? 'now' : 'wait';

    const cards = [{ id: 'plan', label: '分图方案', icon: '✦', state: at(0), detail: planned ? `${total} 屏` : '' }];
    states.forEach((value, index) => {
      const hero = index === 0 || (planning[index] && planning[index].role === 'hero');
      cards.push({ id: `screen-${index}`, label: hero ? '首图' : `第 ${index + 1} 屏`, icon: '▣', state: cardState(value),
        detail: value === 'fetching' && !failed ? '下载中' : value === 'queued' && phase === 1 && !failed ? '排队' : screenTitle(planning[index], index) });
    });
    cards.push({ id: 'long', label: '拼成长图', icon: '☰', state: at(2) });

    const agents = [{ id: 'planner', name: '策划', color: '#f472b6', at: 'plan', state: at(0) }];
    if (phase === 1 && !failed && drawing.length) {
      drawing.forEach((index, slot) => agents.push({ id: `designer-${slot}`, name: `设计师 ${slot + 1}`, color: DESIGNER_COLORS[slot % DESIGNER_COLORS.length], at: `screen-${index}`, state: 'now' }));
    } else {
      agents.push({ id: 'designer-0', name: '设计师', color: DESIGNER_COLORS[0], at: 'plan', state: phase > 1 ? 'done' : 'wait' });
    }
    agents.push({ id: 'assembler', name: '拼版', color: '#a78bfa', at: 'long', state: at(2) });

    const log = [];
    const message = String(state.progress_msg || '');
    const doneCount = states.filter((value) => value === 'done').length;
    const failedCount = states.filter((value) => value === 'failed').length;
    if (at(0) !== 'wait') log.push({ who: '策划', color: '#f472b6', state: at(0), text: at(0) === 'done' ? `客户买点已精选，分成 ${total} 屏` : (message || '读产品资料，挑客户买点、分屏') });
    if (phase >= 1) {
      const designState = phase > 1 ? 'done' : failed ? 'fail' : 'now';
      const text = reroll !== null && phase === 1 ? `重画第 ${reroll + 1} 屏，其余沿用`
        : phase > 1 ? `${doneCount}/${total} 屏画好了` : `已画好 ${doneCount}/${total} 屏${drawing.length ? `，${drawing.length} 位设计师在画` : ''}${failedCount ? `，${failedCount} 屏没画成` : ''}`;
      log.push({ who: '设计组', color: '#fb923c', state: designState, text });
    }
    if (at(2) !== 'wait') log.push({ who: '拼版', color: '#a78bfa', state: at(2), text: at(2) === 'done' ? (failedCount ? `长图拼好了，${failedCount} 屏没画成` : '长图拼好了') : '把画好的屏拼成长图' });
    if (failed && state.error) log.push({ who: '原因', color: '#f87171', state: 'fail', text: String(state.error).slice(0, 160) });
    return { cards, agents, log, running: RUNNING.has(status) };
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const CURSOR_SVG = '<svg width="18" height="22" viewBox="0 0 22 26" aria-hidden="true"><path d="M1 1 L1 21 L6.5 16 L10 24 L13.5 22.5 L10 15 L18 15 Z"/></svg>';

  function render(container, state) {
    const model = detailStageModel(state);
    let root = container.querySelector('.agent-stage');
    if (!root) {
      root = el('section', 'agent-stage');
      root.setAttribute('aria-label', 'AI 设计组工作台');
      root.append(el('div', 'agent-stage-board'), el('ol', 'agent-stage-log'));
      root.querySelector('.agent-stage-board').append(el('ol', 'agent-stage-cards'), el('div', 'agent-stage-dock'));
      root.querySelector('.agent-stage-log').setAttribute('aria-live', 'polite');
      container.appendChild(root);
    }
    const board = root.querySelector('.agent-stage-board');
    const list = root.querySelector('.agent-stage-cards');
    list.textContent = '';
    const cardNodes = {};
    model.cards.forEach((card) => {
      const item = el('li', `is-${card.state}`);
      item.append(el('span', 'agent-stage-icon', card.state === 'done' ? '✓' : card.state === 'fail' ? '!' : card.icon), el('b', '', card.label));
      if (card.detail) item.append(el('small', '', card.detail));
      list.appendChild(item);
      cardNodes[card.id] = item;
    });
    const logList = root.querySelector('.agent-stage-log');
    const nearBottom = logList.scrollHeight - logList.scrollTop - logList.clientHeight < 48;
    logList.textContent = '';
    model.log.forEach((line) => {
      const item = el('li', `is-${line.state}`);
      item.style.setProperty('--agent', line.color);
      item.append(el('b', '', line.who), el('span', '', line.text));
      logList.appendChild(item);
    });
    if (nearBottom) logList.scrollTop = logList.scrollHeight;

    // Cursors keep their element between polls so they glide from card to card.
    const dock = root.querySelector('.agent-stage-dock');
    const rootBox = board.getBoundingClientRect();
    const dockBox = dock.getBoundingClientRect();
    const parked = model.agents.filter((agent) => !(agent.state === 'now' || agent.state === 'fail') || !cardNodes[agent.at]);
    const perRow = Math.max(1, Math.floor((dockBox.width - 8) / 92));
    dock.style.height = `${Math.max(1, Math.ceil(parked.length / perRow)) * 24 + 6}px`;
    const keep = new Set();
    model.agents.forEach((agent) => {
      keep.add(agent.id);
      let cursor = board.querySelector(`[data-agent="${agent.id}"]`);
      if (!cursor) {
        cursor = el('span', 'agent-cursor');
        cursor.dataset.agent = agent.id;
        cursor.innerHTML = CURSOR_SVG;
        cursor.append(el('i', '', agent.name));
        board.appendChild(cursor);
      }
      cursor.className = `agent-cursor is-${agent.state}`;
      cursor.style.setProperty('--agent', agent.color);
      cursor.querySelector('i').textContent = agent.name;
      const box = cardNodes[agent.at] && cardNodes[agent.at].getBoundingClientRect();
      let x; let y;
      if ((agent.state === 'now' || agent.state === 'fail') && box) {
        x = Math.max(0, Math.min(box.left - rootBox.left + box.width * 0.58, rootBox.width - 104));
        y = box.top - rootBox.top + box.height - 26;
      } else {
        const index = parked.indexOf(agent);
        x = 4 + (index % perRow) * 92;
        y = dock.offsetTop + 6 + Math.floor(index / perRow) * 24;
      }
      cursor.style.transform = `translate(${x}px, ${y}px)`;
    });
    board.querySelectorAll('[data-agent]').forEach((node) => { if (!keep.has(node.dataset.agent)) node.remove(); });

    // Heartbeat only while the task runs and the page is visible.
    clearInterval(root._beat);
    root.dataset.beat = '0';
    if (model.running && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      root._beat = setInterval(() => {
        // Hidden with the loading area (task ended or failed): the heartbeat stops.
        if (!root.isConnected || root.offsetParent === null) { clearInterval(root._beat); root.dataset.beat = '0'; return; }
        if (!document.hidden) root.dataset.beat = root.dataset.beat === '1' ? '0' : '1';
      }, 1000);
    }
  }

  function stop(container) {
    const root = container && container.querySelector('.agent-stage');
    if (root) { clearInterval(root._beat); root.dataset.beat = '0'; }
  }

  window.AgentStage = { render, stop, detailStageModel };
})();
