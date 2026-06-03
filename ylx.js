// ============ 常量 ============
const ROWS = 14;
const COLS = 10;
const MAX_ID = 32;

// 生成 32 色（HSL 色环均分）
const COLORS = [];
for (let i = 0; i <= MAX_ID; i++) {
  if (i === 0) { COLORS[i] = ''; continue; }
  let hue = (i - 1) * 360 / MAX_ID;
  COLORS[i] = `hsl(${hue.toFixed(1)}, 65%, 50%)`;
}

// ============ 状态 ============
let grid = [];           // ROWS x COLS 二维数组，0=空格
let history = [];        // 操作历史 [{type:'clear'|'move', args:[...]}]
let editMode = false;

// 拖拽状态
let dragStartCell = null;    // {r, c} 拖拽起始格
let dragStartX = 0;
let dragStartY = 0;
let dragDirection = null;    // 'up'|'down'|'left'|'right'|null
let dragGridBackup = null;   // 拖拽前的网格备份
let dragPosB = null;         // 拖拽后棋子新位置
let hasMoved = false;        // 是否已经移动过（区分点击和拖拽）
const DRAG_THRESHOLD = 8;    // 像素阈值，超过才算拖拽
const CELL_SIZE = 39;        // 每格尺寸(px)：38px格子 + 1px间距

// ============ 工具函数 ============
function posKey(r, c) { return r + ',' + c; }
function parsePosKey(key) { return key.split(',').map(Number); }
function cloneGrid(g) { return g.map(row => [...row]); }

/** 获取网格值（越界返回0，等价于虚拟空格边框） */
function getCell(g, r, c) {
  if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return 0;
  return g[r][c];
}

/** 判断两个格子之间直线是否全空（不含端点） */
function isLineClear(g, r1, c1, r2, c2) {
  if (r1 === r2) {
    let minC = Math.min(c1, c2) + 1;
    let maxC = Math.max(c1, c2) - 1;
    for (let c = minC; c <= maxC; c++) {
      if (getCell(g, r1, c) !== 0) return false;
    }
    return true;
  }
  if (c1 === c2) {
    let minR = Math.min(r1, r2) + 1;
    let maxR = Math.max(r1, r2) - 1;
    for (let r = minR; r <= maxR; r++) {
      if (getCell(g, r, c1) !== 0) return false;
    }
    return true;
  }
  return false;
}

// ============ 直线消除检测 ============

/**
 * 判断两个格子是否可以直线消除（仅同行或同列，不允许拐角）
 * 条件：值相同≠0、同行或同列、中间无障碍
 */
function canMatch(g, r1, c1, r2, c2) {
  if (r1 === r2 && c1 === c2) return false;
  if (getCell(g, r1, c1) === 0 || getCell(g, r2, c2) === 0) return false;
  if (getCell(g, r1, c1) !== getCell(g, r2, c2)) return false;
  if (r1 !== r2 && c1 !== c2) return false; // 不允许拐角
  return isLineClear(g, r1, c1, r2, c2);
}

/** 查找某个格子的所有可直线消除的匹配格 */
function findAllMatches(g, r, c) {
  let val = getCell(g, r, c);
  if (val === 0) return [];
  let matches = [];
  for (let rr = 0; rr < ROWS; rr++) {
    for (let cc = 0; cc < COLS; cc++) {
      if (rr === r && cc === c) continue;
      if (canMatch(g, r, c, rr, cc)) {
        matches.push([rr, cc]);
      }
    }
  }
  return matches;
}

/** 查找唯一匹配（无歧义），返回匹配坐标或null */
function findUnambiguousMatch(g, r, c) {
  let matches = findAllMatches(g, r, c);
  if (matches.length === 1) return matches[0];
  return null;
}

// ============ 核心函数 ============

/**
 * 消除 posA 和 posB 两个格子
 * @param {[number,number]} posA - [row, col]
 * @param {[number,number]} posB - [row, col]
 * @returns {boolean} 是否成功
 */
function clear(posA, posB) {
  let [r1, c1] = posA;
  let [r2, c2] = posB;

  // 规则检查
  if (r1 < 0 || r1 >= ROWS || c1 < 0 || c1 >= COLS) return false;
  if (r2 < 0 || r2 >= ROWS || c2 < 0 || c2 >= COLS) return false;
  if (r1 === r2 && c1 === c2) return false;
  if (grid[r1][c1] === 0 || grid[r2][c2] === 0) return false;
  if (grid[r1][c1] !== grid[r2][c2]) return false;
  if (!canMatch(grid, r1, c1, r2, c2)) return false;

  // 执行消除
  grid[r1][c1] = 0;
  grid[r2][c2] = 0;

  // 记录历史
  history.push({ type: 'clear', args: [posA, posB] });
  renderGrid();
  renderHistory();
  return true;
}

/**
 * 拖动 posA 到 posB，并与 posC 一起消除
 * @param {[number,number]} posA - 被拖动格子的起始位置
 * @param {[number,number]} posB - 被拖动格子的目标位置（与posA同行或同列，任意距离）
 * @param {[number,number]} posC - 与 posB 匹配消除的格子
 * @returns {boolean} 是否成功
 */
function move(posA, posB, posC) {
  let [rA, cA] = posA;
  let [rB, cB] = posB;
  let [rC, cC] = posC;

  // 基本检查
  if (rA < 0 || rA >= ROWS || cA < 0 || cA >= COLS) return false;
  if (rB < 0 || rB >= ROWS || cB < 0 || cB >= COLS) return false;
  if (rC < 0 || rC >= ROWS || cC < 0 || cC >= COLS) return false;
  if (grid[rA][cA] === 0) return false;

  // posA 和 posB 必须同行或同列
  let dr = rB - rA;
  let dc = cB - cA;
  if (dr !== 0 && dc !== 0) return false;
  if (dr === 0 && dc === 0) return false;

  let dirR = Math.sign(dr);
  let dirC = Math.sign(dc);
  let requestedDist = Math.abs(dr) + Math.abs(dc);

  // 备份并执行链式移动
  let backup = cloneGrid(grid);
  let actualDist = executeChainMoveDir(rA, cA, dirR, dirC, requestedDist);

  // 实际移动格数必须等于请求的格数
  if (actualDist !== requestedDist) {
    grid = backup;
    return false;
  }

  // 检查 posB 和 posC 是否可以消除（只检查被拖动的那个格子）
  if (grid[rB][cB] === 0 || grid[rC][cC] === 0) {
    grid = backup;
    return false;
  }
  if (grid[rB][cB] !== grid[rC][cC]) {
    grid = backup;
    return false;
  }
  if (!canMatch(grid, rB, cB, rC, cC)) {
    grid = backup;
    return false;
  }

  // 执行消除
  grid[rB][cB] = 0;
  grid[rC][cC] = 0;

  // 记录历史
  history.push({ type: 'move', args: [posA, posB, posC] });
  renderGrid();
  renderHistory();
  return true;
}

// ============ 链式移动 ============

/**
 * 在给定网格上沿方向执行链式移动（原地修改grid），支持任意格数
 * 从 (r,c) 开始，向 (dr,dc) 方向，收集链条并在限制内整体平移
 * @param {number} shiftCount - 请求平移的格数（内部自动 cap 到可用空格数）
 * @returns {number} 实际移动的格数，0 表示无法移动
 */
function executeChainMoveDir(r, c, dr, dc, shiftCount) {
  if (shiftCount <= 0) return 0;

  // 1. 收集链条（从起始格到第一个空格前）
  let chain = [];
  let cr = r, cc = c;
  while (cr >= 0 && cr < ROWS && cc >= 0 && cc < COLS && grid[cr][cc] !== 0) {
    chain.push(grid[cr][cc]);
    cr += dr;
    cc += dc;
  }
  if (chain.length === 0) return 0;

  // 2. 统计连续空格数
  let maxEmpty = 0;
  while (cr >= 0 && cr < ROWS && cc >= 0 && cc < COLS && grid[cr][cc] === 0) {
    maxEmpty++;
    cr += dr;
    cc += dc;
  }
  if (maxEmpty === 0) return 0;

  // 3. cap 到可用空格
  let actual = Math.min(shiftCount, maxEmpty);

  // 4. 清空链条原位
  cr = r; cc = c;
  for (let i = 0; i < chain.length; i++) {
    grid[cr][cc] = 0;
    cr += dr;
    cc += dc;
  }

  // 5. 写入链条新位置
  cr = r + actual * dr;
  cc = c + actual * dc;
  for (let i = 0; i < chain.length; i++) {
    grid[cr][cc] = chain[i];
    cr += dr;
    cc += dc;
  }

  return actual;
}

// ============ 网格初始化 ============

function initGrid() {
  // 随机挑选ID，每个插入两次，重复至填满140格，然后洗牌
  let pool = [];
  while (pool.length < ROWS * COLS) {
    let id = Math.floor(Math.random() * MAX_ID) + 1; // 1~32
    pool.push(id, id);
  }
  pool = pool.slice(0, ROWS * COLS); // 截断到恰好140

  // Fisher-Yates 洗牌
  for (let i = pool.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  // 填入网格
  grid = [];
  let idx = 0;
  for (let r = 0; r < ROWS; r++) {
    grid[r] = [];
    for (let c = 0; c < COLS; c++) {
      grid[r][c] = pool[idx++];
    }
  }

  history = [];
  renderGrid();
  renderHistory();
  showToast('网格已初始化', 'success');
}

// ============ 渲染 ============

function renderGrid() {
  let gridEl = document.getElementById('grid');
  gridEl.innerHTML = '';

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      let cell = document.createElement('div');
      cell.className = 'cell';
      let val = grid[r][c];
      if (val === 0) {
        cell.classList.add('empty');
      } else {
        let bg = COLORS[val];
        cell.style.backgroundColor = bg;
        // 浅色背景用深色文字
        let m = bg.match(/hsl\([^,]+,(\d+)%/);
        if (m && parseInt(m[1]) > 55) cell.style.color = '#222';
        cell.textContent = val;
      }
      cell.dataset.row = r;
      cell.dataset.col = c;

      cell.addEventListener('mousedown', onCellMouseDown);
      cell.addEventListener('touchstart', onCellTouchStart, { passive: false });

      gridEl.appendChild(cell);
    }
  }
}

function renderHistory() {
  let histEl = document.getElementById('history');
  if (history.length === 0) {
    histEl.innerHTML = '<div class="empty-hint">暂无操作记录</div>';
    return;
  }

  let html = '';
  history.forEach((entry, i) => {
    let cls = entry.type === 'clear' ? 'clear-type' : 'move-type';
    let desc = '';
    if (entry.type === 'clear') {
      let [a, b] = entry.args;
      desc = `clear([${a[0]},${a[1]}], [${b[0]},${b[1]}])`;
    } else {
      let [a, b, c] = entry.args;
      desc = `move([${a[0]},${a[1]}], [${b[0]},${b[1]}], [${c[0]},${c[1]}])`;
    }
    html += `<div class="entry ${cls}"><span class="idx">#${i + 1}</span>${desc}</div>`;
  });
  histEl.innerHTML = html;
  histEl.scrollTop = histEl.scrollHeight;
}

// ============ 编辑模式 ============

function toggleEditMode() {
  editMode = !editMode;
  let btn = document.getElementById('btnEdit');
  if (editMode) {
    btn.classList.add('active');
    btn.textContent = '✏️ 编辑中...';
    showToast('编辑模式：点击格子修改ID（输入0-' + MAX_ID + '）', 'success');
  } else {
    btn.classList.remove('active');
    btn.textContent = '✏️ 编辑模式';
  }
}

function editCell(r, c) {
  let current = grid[r][c];
  let input = prompt(`修改格子 [${r},${c}] 的ID（当前: ${current}）\n输入 0-${MAX_ID} 之间的数字：`, current);
  if (input === null) return;
  let val = parseInt(input, 10);
  if (isNaN(val) || val < 0 || val > MAX_ID) {
    showToast('无效ID，请输入0-' + MAX_ID, 'error');
    return;
  }
  grid[r][c] = val;
  renderGrid();
  showToast(`已将 [${r},${c}] 设为 ${val}`, 'success');
}

// ============ 点击/拖拽事件处理 ============

function getCellFromEvent(e) {
  let cell = e.target.closest('.cell');
  if (!cell) return null;
  let r = parseInt(cell.dataset.row);
  let c = parseInt(cell.dataset.col);
  return { r, c, cell };
}

function onCellMouseDown(e) {
  if (e.button !== 0) return; // 只响应左键
  let info = getCellFromEvent(e);
  if (!info) return;

  if (editMode) {
    editCell(info.r, info.c);
    return;
  }

  if (grid[info.r][info.c] === 0) return; // 空格不响应

  // 先检查是否可以直接点击消除
  let match = findUnambiguousMatch(grid, info.r, info.c);
  if (match) {
    clear([info.r, info.c], match);
    e.preventDefault();
    return; // 消除了就不再进入拖拽
  }

  // 无法直接消除 → 进入拖拽模式
  dragStartCell = { r: info.r, c: info.c };
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragDirection = null;
  dragGridBackup = cloneGrid(grid);
  dragPosB = null;
  hasMoved = false;

  e.preventDefault();
}

function onCellTouchStart(e) {
  let info = getCellFromEvent(e);
  if (!info) return;

  if (editMode) {
    editCell(info.r, info.c);
    return;
  }

  if (grid[info.r][info.c] === 0) return;

  // 先检查是否可以直接点击消除
  let match = findUnambiguousMatch(grid, info.r, info.c);
  if (match) {
    clear([info.r, info.c], match);
    e.preventDefault();
    return;
  }

  let touch = e.touches[0];
  dragStartCell = { r: info.r, c: info.c };
  dragStartX = touch.clientX;
  dragStartY = touch.clientY;
  dragDirection = null;
  dragGridBackup = cloneGrid(grid);
  dragPosB = null;
  hasMoved = false;
}

// 全局移动事件
document.addEventListener('mousemove', function(e) {
  if (!dragStartCell) return;

  let dx = e.clientX - dragStartX;
  let dy = e.clientY - dragStartY;
  let pixelDist = Math.sqrt(dx * dx + dy * dy);

  // 首次超过阈值才算拖拽
  if (dragDirection === null && pixelDist < DRAG_THRESHOLD) return;

  // 确定/锁定方向
  let dirR = 0, dirC = 0;
  if (dragDirection === null) {
    if (Math.abs(dx) > Math.abs(dy)) {
      dirC = dx > 0 ? 1 : -1;
    } else {
      dirR = dy > 0 ? 1 : -1;
    }
    dragDirection = dirR === -1 ? 'up' : dirR === 1 ? 'down' : dirC === -1 ? 'left' : 'right';
    hasMoved = true;
  } else {
    // 方向已锁定，只允许同轴移动
    dirR = dragDirection === 'up' ? -1 : dragDirection === 'down' ? 1 : 0;
    dirC = dragDirection === 'left' ? -1 : dragDirection === 'right' ? 1 : 0;
  }

  // 像素距离 → 格数
  let axisPixels = dirC !== 0 ? Math.abs(dx) : Math.abs(dy);
  let cellDist = Math.max(1, Math.round(axisPixels / CELL_SIZE));

  // 恢复备份，按格数执行链式移动
  grid = cloneGrid(dragGridBackup);
  let rA = dragStartCell.r, cA = dragStartCell.c;

  let actual = executeChainMoveDir(rA, cA, dirR, dirC, cellDist);
  dragPosB = actual > 0 ? [rA + actual * dirR, cA + actual * dirC] : null;

  renderGrid();
  if (dragPosB) {
    highlightCell(dragPosB[0], dragPosB[1], 'drag-preview');
  }
});

document.addEventListener('mouseup', function(e) {
  if (!dragStartCell) return;
  finishDrag();
});

document.addEventListener('touchend', function(e) {
  if (!dragStartCell) return;
  finishDrag();
});

document.addEventListener('touchmove', function(e) {
  if (!dragStartCell) return;

  let touch = e.touches[0];
  let dx = touch.clientX - dragStartX;
  let dy = touch.clientY - dragStartY;
  let pixelDist = Math.sqrt(dx * dx + dy * dy);

  if (dragDirection === null && pixelDist < DRAG_THRESHOLD) return;

  let dirR = 0, dirC = 0;
  if (dragDirection === null) {
    if (Math.abs(dx) > Math.abs(dy)) {
      dirC = dx > 0 ? 1 : -1;
    } else {
      dirR = dy > 0 ? 1 : -1;
    }
    dragDirection = dirR === -1 ? 'up' : dirR === 1 ? 'down' : dirC === -1 ? 'left' : 'right';
    hasMoved = true;
  } else {
    dirR = dragDirection === 'up' ? -1 : dragDirection === 'down' ? 1 : 0;
    dirC = dragDirection === 'left' ? -1 : dragDirection === 'right' ? 1 : 0;
  }

  let axisPixels = dirC !== 0 ? Math.abs(dx) : Math.abs(dy);
  let cellDist = Math.max(1, Math.round(axisPixels / CELL_SIZE));

  grid = cloneGrid(dragGridBackup);
  let rA = dragStartCell.r, cA = dragStartCell.c;

  let actual = executeChainMoveDir(rA, cA, dirR, dirC, cellDist);
  dragPosB = actual > 0 ? [rA + actual * dirR, cA + actual * dirC] : null;

  renderGrid();
  if (dragPosB) {
    highlightCell(dragPosB[0], dragPosB[1], 'drag-preview');
  }

  e.preventDefault();
}, { passive: false });

function finishDrag() {
  if (!dragStartCell) return;

  if (!hasMoved) {
    // 点击但没拖动——mousedown 已经排除了可消除情况，这里只提示原因
    let allMatches = findAllMatches(grid, dragStartCell.r, dragStartCell.c);
    if (allMatches.length === 0) {
      showToast('该格子无可消除的匹配', 'error');
    } else {
      showToast('该格子有 ' + allMatches.length + ' 个匹配，存在歧义，无法消除', 'error');
    }
  } else if (dragPosB) {
    // 有拖拽且成功移动 — 只检查被拖动格子是否能消除
    let [rA, cA] = [dragStartCell.r, dragStartCell.c];
    let [rB, cB] = dragPosB;
    let movedMatches = findAllMatches(grid, rB, cB);

    if (movedMatches.length === 1) {
      // 唯一匹配 → 先恢复备份，再通过 move() 原子执行
      let [rC, cC] = movedMatches[0];
      grid = dragGridBackup;
      if (!move([rA, cA], dragPosB, [rC, cC])) {
        renderGrid();
        showToast('拖动后无法消除，已撤回', 'error');
      }
      // move() 成功则已记录历史并重绘
    } else {
      // 无匹配或有歧义 → 回退
      grid = dragGridBackup;
      renderGrid();
      if (movedMatches.length === 0) {
        showToast('拖动后无可消除匹配，已撤回', 'error');
      } else {
        showToast('拖动后有 ' + movedMatches.length + ' 个匹配，存在歧义，已撤回', 'error');
      }
    }
  } else {
    // 拖拽了但无法移动（无空格）
    grid = dragGridBackup;
    renderGrid();
    showToast('该方向无空格，无法移动', 'error');
  }

  // 清理拖拽状态
  dragStartCell = null;
  dragDirection = null;
  dragGridBackup = null;
  dragPosB = null;
  hasMoved = false;
}

function highlightCell(r, c, cls) {
  // 移除所有高亮
  document.querySelectorAll('.cell.drag-preview').forEach(el => el.classList.remove('drag-preview'));
  let cell = document.querySelector(`.cell[data-row="${r}"][data-col="${c}"]`);
  if (cell && cls) cell.classList.add(cls);
}

// ============ 推导 ============

/** 统计某方向的最大连续空格数 */
function countEmptyDir(r, c, dr, dc) {
  let er = r + dr, ec = c + dc;
  let count = 0;
  while (er >= 0 && er < ROWS && ec >= 0 && ec < COLS && getCell(grid, er, ec) === 0) {
    count++;
    er += dr;
    ec += dc;
  }
  return count;
}

/** 推导：找出一个可执行的操作，返回步骤描述对象或null */
function hint() {
  // 优先级1：直接消除
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      let match = findUnambiguousMatch(grid, r, c);
      if (match) {
        return {
          type: 'clear', posA: [r, c], posB: match,
          desc: `💡 点击 [${r},${c}] 可与 [${match[0]},${match[1]}] 直接消除`
        };
      }
    }
  }

  // 优先级2：移动后消除（只检查被拖动的格子 posB 能否消除）
  const DIRS = [[-1,0,'上'],[1,0,'下'],[0,-1,'左'],[0,1,'右']];
  for (let rA = 0; rA < ROWS; rA++) {
    for (let cA = 0; cA < COLS; cA++) {
      if (grid[rA][cA] === 0) continue;
      for (let [dr, dc, label] of DIRS) {
        let maxEmpty = countEmptyDir(rA, cA, dr, dc);
        if (maxEmpty === 0) continue;
        for (let s = 1; s <= maxEmpty; s++) {
          let simGrid = cloneGrid(grid);
          let act = executeChainMoveOnGrid(simGrid, rA, cA, dr, dc, s);
          if (act !== s) continue;
          let rB = rA + s * dr, cB = cA + s * dc;
          let match = findUnambiguousMatch(simGrid, rB, cB);
          if (match) {
            return {
              type: 'move', posA: [rA, cA], posB: [rB, cB], posC: match,
              desc: `💡 拖动 [${rA},${cA}] 向${label} ${s}格 → 与 [${match[0]},${match[1]}] 消除`
            };
          }
        }
      }
    }
  }

  return null;
}

/** 推导按钮回调：调用hint并Toast */
function doHint() {
  let step = hint();
  if (step) {
    showToast(step.desc, 'success');
  } else {
    showToast('😞 无可执行的步骤', 'error');
  }
}

// ============ 自动播放 ============

let autoTimer = null;
let autoRunning = false;

function toggleAuto() {
  if (autoRunning) {
    stopAuto();
  } else {
    startAuto();
  }
}

function startAuto() {
  autoRunning = true;
  let btn = document.getElementById('btnAuto');
  btn.textContent = '⏸ 停止';
  btn.classList.add('running');
  autoStep();
}

function stopAuto() {
  autoRunning = false;
  clearTimeout(autoTimer);
  let btn = document.getElementById('btnAuto');
  btn.textContent = '▶ 自动';
  btn.classList.remove('running');
}

function autoStep() {
  if (!autoRunning) return;

  let step = hint();
  if (!step) {
    showToast('😞 自动推导结束——无可执行步骤', 'success');
    stopAuto();
    return;
  }

  // 执行步骤
  let ok;
  if (step.type === 'clear') {
    ok = clear(step.posA, step.posB);
  } else {
    ok = move(step.posA, step.posB, step.posC);
  }

  if (!ok) {
    showToast('自动执行失败，已停止', 'error');
    stopAuto();
    return;
  }

  // 延时继续
  autoTimer = setTimeout(autoStep, 150);
}

/* executeChainMoveDir 的纯函数版本（不修改全局grid） */
function executeChainMoveOnGrid(g, r, c, dr, dc, shiftCount) {
  if (shiftCount <= 0) return 0;
  let chain = [];
  let cr = r, cc = c;
  while (cr >= 0 && cr < ROWS && cc >= 0 && cc < COLS && g[cr][cc] !== 0) {
    chain.push(g[cr][cc]);
    cr += dr; cc += dc;
  }
  if (chain.length === 0) return 0;
  let maxEmpty = 0;
  while (cr >= 0 && cr < ROWS && cc >= 0 && cc < COLS && g[cr][cc] === 0) {
    maxEmpty++;
    cr += dr; cc += dc;
  }
  if (maxEmpty === 0) return 0;
  let actual = Math.min(shiftCount, maxEmpty);
  cr = r; cc = c;
  for (let i = 0; i < chain.length; i++) { g[cr][cc] = 0; cr += dr; cc += dc; }
  cr = r + actual * dr; cc = c + actual * dc;
  for (let i = 0; i < chain.length; i++) { g[cr][cc] = chain[i]; cr += dr; cc += dc; }
  return actual;
}

// ============ 导入/导出 ============

/** 导出网格为文本（空格分隔，每行换行） */
function exportGrid() {
  let lines = grid.map(row => row.join(' '));
  let text = lines.join('\n');

  // 复制到剪贴板
  navigator.clipboard.writeText(text).then(() => {
    showToast('网格数据已复制到剪贴板', 'success');
  }).catch(() => {
    // fallback: 显示在弹窗中
    document.getElementById('gridTextarea').value = text;
    document.getElementById('modalGrid').classList.add('show');
    showToast('请手动复制文本框内容', 'success');
  });
}

/** 显示导入网格弹窗 */
function showImportGrid() {
  document.getElementById('gridTextarea').value = '';
  document.getElementById('modalGrid').classList.add('show');
}

/** 导入网格 */
function importGrid() {
  let text = document.getElementById('gridTextarea').value.trim();
  if (!text) {
    showToast('请输入网格数据', 'error');
    return;
  }

  let lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length !== ROWS) {
    showToast('网格必须有 ' + ROWS + ' 行，当前 ' + lines.length + ' 行', 'error');
    return;
  }

  let newGrid = [];
  for (let r = 0; r < ROWS; r++) {
    let nums = lines[r].split(/\s+/).map(Number);
    if (nums.length !== COLS) {
      showToast('第 ' + (r + 1) + ' 行必须有 ' + COLS + ' 个数字，当前 ' + nums.length + ' 个', 'error');
      return;
    }
    for (let n of nums) {
      if (isNaN(n) || n < 0 || n > MAX_ID) {
        showToast('第 ' + (r + 1) + ' 行包含无效数字（需要0-' + MAX_ID + '）', 'error');
        return;
      }
    }
    newGrid.push(nums);
  }

  grid = newGrid;
  history = [];
  closeModal('modalGrid');
  renderGrid();
  renderHistory();
  showToast('网格导入成功', 'success');
}

/** 导出步骤为 JSON */
function exportSteps() {
  if (history.length === 0) {
    showToast('没有可导出的步骤', 'error');
    return;
  }
  let lines = history.map(h => JSON.stringify([h.type, ...h.args]));
  let text = lines.join('\n');

  navigator.clipboard.writeText(text).then(() => {
    showToast('步骤数据已复制到剪贴板', 'success');
  }).catch(() => {
    document.getElementById('stepsTextarea').value = text;
    document.getElementById('modalSteps').classList.add('show');
    showToast('请手动复制文本框内容', 'success');
  });
}

/** 显示导入步骤弹窗 */
function showImportSteps() {
  document.getElementById('stepsTextarea').value = '';
  document.getElementById('modalSteps').classList.add('show');
}

/** 导入步骤 */
function importSteps() {
  let text = document.getElementById('stepsTextarea').value.trim();
  if (!text) {
    showToast('请输入步骤数据', 'error');
    return;
  }

  let steps;
  // 尝试按行解析（每行一个 JSON 数组），兼容旧版整体数组
  let lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  try {
    // 先尝试整体 JSON 解析（兼容旧版）
    let parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.length > 0 && Array.isArray(parsed[0])) {
      steps = parsed;
    } else {
      throw new Error('not array of arrays');
    }
  } catch (e1) {
    // 按行解析
    try {
      steps = [];
      for (let line of lines) {
        let step = JSON.parse(line);
        if (!Array.isArray(step)) throw new Error('invalid step');
        steps.push(step);
      }
    } catch (e2) {
      showToast('步骤解析失败: ' + e2.message, 'error');
      return;
    }
  }

  if (!Array.isArray(steps) || steps.length === 0) {
    showToast('步骤必须是数组格式', 'error');
    return;
  }

  // 验证并执行每一步
  for (let i = 0; i < steps.length; i++) {
    let step = steps[i];
    if (!Array.isArray(step) || step.length < 3) {
      showToast('步骤 #' + (i + 1) + ' 格式错误', 'error');
      return;
    }

    let [type, ...args] = step;

    if (type === 'clear') {
      if (args.length !== 2 || !Array.isArray(args[0]) || !Array.isArray(args[1])) {
        showToast('步骤 #' + (i + 1) + ' clear 参数格式错误', 'error');
        return;
      }
      if (!clear(args[0], args[1])) {
        showToast('步骤 #' + (i + 1) + ' clear 执行失败（规则不满足）', 'error');
        return;
      }
    } else if (type === 'move') {
      if (args.length !== 3 || !Array.isArray(args[0]) || !Array.isArray(args[1]) || !Array.isArray(args[2])) {
        showToast('步骤 #' + (i + 1) + ' move 参数格式错误', 'error');
        return;
      }
      if (!move(args[0], args[1], args[2])) {
        showToast('步骤 #' + (i + 1) + ' move 执行失败（规则不满足）', 'error');
        return;
      }
    } else {
      showToast('步骤 #' + (i + 1) + ' 未知类型: ' + type, 'error');
      return;
    }
  }

  closeModal('modalSteps');
  showToast('步骤导入并执行成功（共 ' + steps.length + ' 步）', 'success');
}

// ============ 弹窗 ============

function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}

// 点击遮罩关闭
document.getElementById('modalGrid').addEventListener('click', function(e) {
  if (e.target === this) closeModal('modalGrid');
});
document.getElementById('modalSteps').addEventListener('click', function(e) {
  if (e.target === this) closeModal('modalSteps');
});

// ============ Toast ============

let toastTimer = null;
function showToast(msg, type) {
  let el = document.getElementById('toast');
  clearTimeout(toastTimer);
  el.textContent = msg;
  el.className = type || '';
  el.classList.add('show');
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
  }, 2000);
}

// ============ 启动 ============
initGrid();
