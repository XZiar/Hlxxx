// ============ 图片解析工具 - 感知哈希实现 ============

// 全局状态
let hashToIdMap = new Map();      // 哈希字符串 → ID 映射
let idCounter = 0;                 // ID 计数器
let gridHashes = [];              // 14×10 的格子哈希
const HASH_SIZE = 8;              // 哈希尺寸 8×8 = 64 位
const EDGE_DETECTION_WIDTH = 256; // 边缘检测时的缩放宽度
let SIMILARITY_THRESHOLD = 5;     // 汉明距离阈值（≤5 视为相同），可通过界面调整
let CROP_TOP_RATIO = 0.12;        // 顶部裁剪比例，可通过界面调整
let CROP_BOTTOM_RATIO = 0.15;     // 底部裁剪比例，可通过界面调整
let CROP_LEFT_RATIO = 0.02;       // 左侧裁剪比例
let CROP_RIGHT_RATIO = 0.02;      // 右侧裁剪比例

// 裁剪比例限制
const MAX_TOP_CROP = 0.30;        // 顶部最大 30%
const MAX_BOTTOM_CROP = 0.30;     // 底部最大 30%
const MAX_LEFT_CROP = 0.05;       // 左侧最大 5%
const MAX_RIGHT_CROP = 0.05;      // 右侧最大 5%

// 边缘检测结果
let edgeDetectionResult = null;   // { topEdge, bottomEdge, leftEdge, rightEdge, grayCanvas, edgeCanvas }

// ============ 工具函数 ============

/** 计算汉明距离 */
function hammingDistance(hash1, hash2) {
  let dist = 0;
  for (let i = 0; i < hash1.length; i++) {
    if (hash1[i] !== hash2[i]) dist++;
  }
  return dist;
}

/** 将 ImageData 转为灰度数组（亮度） */
function toGrayscale(imageData) {
  let w = imageData.width;
  let h = imageData.height;
  let gray = new Float32Array(w * h);
  
  for (let i = 0; i < w * h; i++) {
    let r = imageData.data[i * 4];
    let g = imageData.data[i * 4 + 1];
    let b = imageData.data[i * 4 + 2];
    // 亮度公式
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  
  return gray;
}

/** 等比缩放图片到指定宽度 */
function resizeImageToWidth(imageData, targetWidth) {
  let oldW = imageData.width;
  let oldH = imageData.height;
  let newH = Math.floor(oldH * targetWidth / oldW);
  return resizeImage(imageData, targetWidth, newH);
}

/** 计算垂直梯度（行之间的变化） */
function calculateVerticalGradient(gray, width, height) {
  let gradients = new Float32Array(height - 1);
  
  for (let y = 0; y < height - 1; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      let idx1 = y * width + x;
      let idx2 = (y + 1) * width + x;
      sum += Math.abs(gray[idx2] - gray[idx1]);
    }
    gradients[y] = sum / width;  // 平均梯度
  }
  
  return gradients;
}

/** 计算水平梯度（列之间的变化） */
function calculateHorizontalGradient(gray, width, height) {
  let gradients = new Float32Array(width - 1);
  
  for (let x = 0; x < width - 1; x++) {
    let sum = 0;
    for (let y = 0; y < height; y++) {
      let idx1 = y * width + x;
      let idx2 = y * width + (x + 1);
      sum += Math.abs(gray[idx2] - gray[idx1]);
    }
    gradients[x] = sum / height;  // 平均梯度
  }
  
  return gradients;
}

/** 检测边缘边界 */
function detectEdges(gray, width, height) {
  // 计算梯度
  let vGrad = calculateVerticalGradient(gray, width, height);
  let hGrad = calculateHorizontalGradient(gray, width, height);
  
  // 计算梯度阈值（使用自适应阈值）
  let vThreshold = 30;  // 垂直梯度阈值
  let hThreshold = 30;  // 水平梯度阈值
  
  // 检测横向边缘（行）
  let topEdge = -1;
  let bottomEdge = -1;
  let leftEdge = -1;
  let rightEdge = -1;
  
  // 找第一个和最后一个横向边缘（垂直梯度）
  let edgeRows = [];
  for (let y = 0; y < vGrad.length; y++) {
    // 统计该行梯度变化超过阈值的像素数
    let count = 0;
    for (let x = 0; x < width; x++) {
      let idx = y * width + x;
      if (y < height - 1) {
        let grad = Math.abs(gray[(y + 1) * width + x] - gray[idx]);
        if (grad > vThreshold) count++;
      }
    }
    if (count > width * 0.7) {  // 70% 的像素梯度变化超过阈值
      edgeRows.push(y);
    }
  }
  
  if (edgeRows.length > 0) {
    topEdge = edgeRows[0];
    bottomEdge = edgeRows[edgeRows.length - 1];
  }
  
  // 找第一个和最后一个纵向边缘（水平梯度）
  let edgeCols = [];
  for (let x = 0; x < hGrad.length; x++) {
    // 统计该列梯度变化超过阈值的像素数
    let count = 0;
    for (let y = 0; y < height; y++) {
      let idx = y * width + x;
      if (x < width - 1) {
        let grad = Math.abs(gray[y * width + (x + 1)] - gray[idx]);
        if (grad > hThreshold) count++;
      }
    }
    if (count > height * 0.5) {  // 50% 的像素梯度变化超过阈值
      edgeCols.push(x);
    }
  }
  
  if (edgeCols.length > 0) {
    leftEdge = edgeCols[0];
    rightEdge = edgeCols[edgeCols.length - 1];
  }
  
  return { topEdge, bottomEdge, leftEdge, rightEdge, edgeRows, edgeCols };
}

/** 在灰度图上标记边缘（红色） */
function markEdgesOnGray(gray, width, height, edges) {
  // 创建 canvas 显示
  let canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  let ctx = canvas.getContext('2d');
  
  // 创建 ImageData
  let imageData = ctx.createImageData(width, height);
  
  // 填充灰度
  for (let i = 0; i < width * height; i++) {
    let val = gray[i];
    imageData.data[i * 4] = val;     // R
    imageData.data[i * 4 + 1] = val; // G
    imageData.data[i * 4 + 2] = val; // B
    imageData.data[i * 4 + 3] = 255; // A
  }
  
  // 标记边缘为红色
  for (let y of edges.edgeRows) {
    for (let x = 0; x < width; x++) {
      let idx = y * width + x;
      imageData.data[idx * 4] = 255;     // R
      imageData.data[idx * 4 + 1] = 0;   // G
      imageData.data[idx * 4 + 2] = 0;   // B
    }
  }
  
  for (let x of edges.edgeCols) {
    for (let y = 0; y < height; y++) {
      let idx = y * width + x;
      imageData.data[idx * 4] = 255;     // R
      imageData.data[idx * 4 + 1] = 0;   // G
      imageData.data[idx * 4 + 2] = 0;   // B
    }
  }
  
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/** 计算 DCT（离散余弦变换） */
function dct(gray, size) {
  let result = new Float32Array(size * size);
  
  for (let u = 0; u < size; u++) {
    for (let v = 0; v < size; v++) {
      let sum = 0;
      for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
          let val = gray[x * size + y];
          sum += val * Math.cos((2 * x + 1) * u * Math.PI / (2 * size))
                     * Math.cos((2 * y + 1) * v * Math.PI / (2 * size));
        }
      }
      // 归一化
      let cu = u === 0 ? 1 / Math.sqrt(2) : 1;
      let cv = v === 0 ? 1 / Math.sqrt(2) : 1;
      result[u * size + v] = 0.25 * cu * cv * sum;
    }
  }
  
  return result;
}

/** 计算感知哈希 (pHash) */
function calculatePhash(imageData) {
  // 1. 缩放到 8×8
  let resized = resizeImage(imageData, HASH_SIZE, HASH_SIZE);
  
  // 2. 转灰度
  let gray = toGrayscale(resized);
  
  // 3. 计算 DCT
  let dctResult = dct(gray, HASH_SIZE);
  
  // 4. 提取低频部分（去掉直流分量 DC）
  let freqs = [];
  for (let i = 1; i < HASH_SIZE * HASH_SIZE; i++) {
    freqs.push(dctResult[i]);
  }
  
  // 5. 计算中位数
  let sorted = [...freqs].sort((a, b) => a - b);
  let median = sorted[Math.floor(sorted.length / 2)];
  
  // 6. 生成哈希（大于中位数为 1，否则为 0）
  let hash = '';
  for (let val of freqs) {
    hash += val > median ? '1' : '0';
  }
  
  return hash;
}

/** 缩放图片（双线性插值） */
function resizeImage(imageData, newW, newH) {
  let oldW = imageData.width;
  let oldH = imageData.height;
  let newData = new Uint8ClampedArray(newW * newH * 4);
  
  let xRatio = oldW / newW;
  let yRatio = oldH / newH;
  
  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      let oldX = x * xRatio;
      let oldY = y * yRatio;
      
      let x1 = Math.floor(oldX);
      let y1 = Math.floor(oldY);
      let x2 = Math.min(x1 + 1, oldW - 1);
      let y2 = Math.min(y1 + 1, oldH - 1);
      
      let dx = oldX - x1;
      let dy = oldY - y1;
      
      // 双线性插值
      for (let c = 0; c < 3; c++) {
        let idx1 = (y1 * oldW + x1) * 4 + c;
        let idx2 = (y1 * oldW + x2) * 4 + c;
        let idx3 = (y2 * oldW + x1) * 4 + c;
        let idx4 = (y2 * oldW + x2) * 4 + c;
        
        let val = imageData.data[idx1] * (1 - dx) * (1 - dy)
                + imageData.data[idx2] * dx * (1 - dy)
                + imageData.data[idx3] * (1 - dx) * dy
                + imageData.data[idx4] * dx * dy;
        
        let newIdx = (y * newW + x) * 4 + c;
        newData[newIdx] = val;
      }
      newData[(y * newW + x) * 4 + 3] = 255; // Alpha
    }
  }
  
  return { width: newW, height: newH, data: newData };
}

// ============ 边缘检测主函数 ============

/** 执行边缘检测（在缩放的灰度图上） */
async function performEdgeDetection(imageFile) {
  return new Promise((resolve, reject) => {
    let img = new Image();
    img.onload = () => {
      // 创建原始画布
      let originalCanvas = document.createElement('canvas');
      originalCanvas.width = img.width;
      originalCanvas.height = img.height;
      let originalCtx = originalCanvas.getContext('2d');
      originalCtx.drawImage(img, 0, 0);
      
      // 等比缩放到宽度 256（更准确）
      let targetWidth = EDGE_DETECTION_WIDTH;
      let targetHeight = Math.floor(img.height * targetWidth / img.width);
      
      let resizedCanvas = document.createElement('canvas');
      resizedCanvas.width = targetWidth;
      resizedCanvas.height = targetHeight;
      let resizedCtx = resizedCanvas.getContext('2d');
      resizedCtx.drawImage(originalCanvas, 0, 0, targetWidth, targetHeight);
      
      // 获取 ImageData 并转灰度
      let imageData = resizedCtx.getImageData(0, 0, targetWidth, targetHeight);
      let gray = toGrayscale(imageData);
      
      // 检测边缘
      let edges = detectEdges(gray, targetWidth, targetHeight);
      
      // 标记边缘（红色）
      let edgeCanvas = markEdgesOnGray(gray, targetWidth, targetHeight, edges);
      
      // 创建灰度图 canvas
      let grayCanvas = document.createElement('canvas');
      grayCanvas.width = targetWidth;
      grayCanvas.height = targetHeight;
      let grayCtx = grayCanvas.getContext('2d');
      let grayImageData = grayCtx.createImageData(targetWidth, targetHeight);
      for (let i = 0; i < targetWidth * targetHeight; i++) {
        let val = gray[i];
        grayImageData.data[i * 4] = val;
        grayImageData.data[i * 4 + 1] = val;
        grayImageData.data[i * 4 + 2] = val;
        grayImageData.data[i * 4 + 3] = 255;
      }
      grayCtx.putImageData(grayImageData, 0, 0);
      
      // 计算裁剪比例（应用 clamp 限制）
      let topRatio = edges.topEdge >= 0 ? edges.topEdge / targetHeight : 0;
      let bottomRatio = edges.bottomEdge >= 0 ? 1 - (edges.bottomEdge + 1) / targetHeight : 0;
      let leftRatio = edges.leftEdge >= 0 ? edges.leftEdge / targetWidth : 0;
      let rightRatio = edges.rightEdge >= 0 ? 1 - (edges.rightEdge + 1) / targetWidth : 0;
      
      // 应用最大值限制
      topRatio = Math.min(topRatio, MAX_TOP_CROP);
      bottomRatio = Math.min(bottomRatio, MAX_BOTTOM_CROP);
      leftRatio = Math.min(leftRatio, MAX_LEFT_CROP);
      rightRatio = Math.min(rightRatio, MAX_RIGHT_CROP);
      
      resolve({
        originalCanvas,
        grayCanvas,
        edgeCanvas,
        edges,
        cropRatios: {
          top: topRatio,
          bottom: bottomRatio,
          left: leftRatio,
          right: rightRatio
        }
      });
    };
    
    img.onerror = reject;
    img.src = URL.createObjectURL(imageFile);
  });
}

// ============ 图片处理 ============

/** 裁剪图片区域 */
function cropImage(canvas, x, y, w, h) {
  let cropped = document.createElement('canvas');
  cropped.width = w;
  cropped.height = h;
  let cropCtx = cropped.getContext('2d');
  cropCtx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return cropped;
}

/** 去除格子边框（只保留中心 80% 区域） */
function removeBorder(canvas) {
  let w = canvas.width;
  let h = canvas.height;
  let marginX = Math.floor(w * 0.1);
  let marginY = Math.floor(h * 0.1);
  let innerW = w - 2 * marginX;
  let innerH = h - 2 * marginY;
  
  let cropped = document.createElement('canvas');
  cropped.width = innerW;
  cropped.height = innerH;
  let ctx = cropped.getContext('2d');
  ctx.drawImage(canvas, marginX, marginY, innerW, innerH, 0, 0, innerW, innerH);
  return cropped;
}

/** 第一阶段：裁剪图片（使用边缘检测得到的裁剪比例） */
async function cropGridRegion(imageFile, cropTop, cropBottom, cropLeft, cropRight) {
  return new Promise((resolve, reject) => {
    let img = new Image();
    img.onload = () => {
      // 创建原始画布
      let originalCanvas = document.createElement('canvas');
      originalCanvas.width = img.width;
      originalCanvas.height = img.height;
      let originalCtx = originalCanvas.getContext('2d');
      originalCtx.drawImage(img, 0, 0);
      
      // 使用传入的裁剪比例
      let cropTopRatio = cropTop;
      let cropBottomRatio = cropBottom;
      let cropLeftRatio = cropLeft;
      let cropRightRatio = cropRight;
      
      let cropX = Math.floor(img.width * cropLeftRatio);
      let cropY = Math.floor(img.height * cropTopRatio);
      let cropW = Math.floor(img.width * (1 - cropLeftRatio - cropRightRatio));
      let cropH = Math.floor(img.height * (1 - cropTopRatio - cropBottomRatio));
      
      // 创建裁剪后的画布（只保留网格区域）
      let croppedCanvas = document.createElement('canvas');
      croppedCanvas.width = cropW;
      croppedCanvas.height = cropH;
      let croppedCtx = croppedCanvas.getContext('2d');
      croppedCtx.drawImage(originalCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
      
      // 计算格子尺寸
      let cellW = Math.floor(cropW / 10);
      let cellH = Math.floor(cropH / 14);
      
      // 裁剪 140 个格子（完整大小，不去边框）
      let cellCanvases = [];
      for (let r = 0; r < 14; r++) {
        for (let c = 0; c < 10; c++) {
          let x = c * cellW;
          let y = r * cellH;
          let cellCanvas = cropImage(croppedCanvas, x, y, cellW, cellH);
          cellCanvases.push({ r, c, canvas: cellCanvas });
        }
      }
      
      resolve({
        originalCanvas,
        croppedCanvas,
        cellW,
        cellH,
        cellCanvases,
        cropParams: { x: cropX, y: cropY, w: cropW, h: cropH }
      });
    };
    
    img.onerror = reject;
    img.src = URL.createObjectURL(imageFile);
  });
}

/** 第二阶段：对格子进行哈希匹配（可重复调用） */
function matchHashes(cellCanvases, threshold) {
  // 重置映射
  hashToIdMap.clear();
  idCounter = 0;
  gridHashes = [];
  
  let grid = [];
  
  // 处理每个格子
  for (let item of cellCanvases) {
    let { r, c, canvas } = item;
    
    // 去除边框
    let iconCanvas = removeBorder(canvas);
    
    // 获取 ImageData
    let iconCtx = iconCanvas.getContext('2d');
    let iconData = iconCtx.getImageData(0, 0, iconCanvas.width, iconCanvas.height);
    
    // 计算 pHash（内部会缩放到 8x8）
    let hash = calculatePhash(iconData);
    
    // 查找或创建 ID
    let id = findOrCreateId(hash, threshold);
    
    // 保存 8x8 灰度图（用于显示）
    let resized8x8 = resizeImage(iconData, HASH_SIZE, HASH_SIZE);
    let gray8x8 = toGrayscale(resized8x8);
    
    gridHashes.push({ 
      r, c, hash, id, 
      canvas: iconCanvas,
      gray8x8: gray8x8  // 保存 8x8 灰度数组
    });
    
    if (r === 0) {
      grid[c] = [id];
    } else {
      grid[c].push(id);
    }
  }
  
  // 转置网格（从按行存储转为按行输出）
  let finalGrid = [];
  for (let r = 0; r < 14; r++) {
    let row = [];
    for (let c = 0; c < 10; c++) {
      let item = gridHashes.find(item => item.r === r && item.c === c);
      row.push(item.id);
    }
    finalGrid.push(row);
  }
  
  return {
    grid: finalGrid,
    gridHashes: [...gridHashes],
    stats: {
      totalCells: 140,
      uniqueIcons: idCounter,
      mappings: Array.from(hashToIdMap.entries())
    }
  };
}

/** 完整解析流程（先裁剪，再匹配） */
async function parseImage(imageFile, threshold = SIMILARITY_THRESHOLD, cropTop = CROP_TOP_RATIO, cropBottom = CROP_BOTTOM_RATIO, cropLeft = CROP_LEFT_RATIO, cropRight = CROP_RIGHT_RATIO) {
  // 第一阶段：裁剪
  let cropResult = await cropGridRegion(imageFile, cropTop, cropBottom, cropLeft, cropRight);
  
  // 第二阶段：哈希匹配
  let matchResult = matchHashes(cropResult.cellCanvases, threshold);
  
  // 合并结果
  return {
    ...cropResult,
    ...matchResult
  };
}

/** 查找或创建 ID */
function findOrCreateId(hash, threshold = SIMILARITY_THRESHOLD) {
  // 查找相似哈希
  for (let [existingHash, id] of hashToIdMap.entries()) {
    let dist = hammingDistance(hash, existingHash);
    if (dist <= threshold) {
      return id;
    }
  }
  
  // 没有匹配，创建新 ID
  let newId = idCounter++;
  hashToIdMap.set(hash, newId);
  return newId;
}

// ============ 导出功能 ============

/** 导出网格为文本 */
function exportGridText(grid) {
  return grid.map(row => row.join(' ')).join('\n');
}

/** 导出映射表 */
function exportMappings() {
  let lines = [];
  lines.push(`// 图标映射表 - 共 ${idCounter} 个唯一图标`);
  lines.push(`// 格式：哈希 → ID`);
  lines.push('');
  
  for (let [hash, id] of hashToIdMap.entries()) {
    lines.push(`// ID ${id}: ${hash}`);
  }
  
  return lines.join('\n');
}

/** 将 canvas 转为灰度 base64 */
function canvasToGrayscaleBase64(canvas) {
  let ctx = canvas.getContext('2d');
  let imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let w = canvas.width;
  let h = canvas.height;
  
  // 转灰度
  for (let i = 0; i < w * h; i++) {
    let r = imageData.data[i * 4];
    let g = imageData.data[i * 4 + 1];
    let b = imageData.data[i * 4 + 2];
    let gray = 0.299 * r + 0.587 * g + 0.114 * b;
    imageData.data[i * 4] = gray;
    imageData.data[i * 4 + 1] = gray;
    imageData.data[i * 4 + 2] = gray;
  }
  
  // 创建临时 canvas 转 base64
  let tempCanvas = document.createElement('canvas');
  tempCanvas.width = w;
  tempCanvas.height = h;
  let tempCtx = tempCanvas.getContext('2d');
  tempCtx.putImageData(imageData, 0, 0);
  
  return tempCanvas.toDataURL('image/png');
}

/** 重新解析（使用当前阈值） */
function reparseWithThreshold(imageFile, newThreshold) {
  SIMILARITY_THRESHOLD = newThreshold;
  return parseImage(imageFile, newThreshold);
}

// ============ 预览渲染 ============

/** 渲染缩放后的预览 */
function renderResizedPreview(canvas, containerId) {
  let container = document.getElementById(containerId);
  container.innerHTML = '';
  
  let preview = document.createElement('canvas');
  preview.width = 200;
  preview.height = Math.floor(200 * canvas.height / canvas.width);
  let ctx = preview.getContext('2d');
  ctx.drawImage(canvas, 0, 0, preview.width, preview.height);
  
  container.appendChild(preview);
}

/** 渲染格子网格预览（灰度 base64 图片，流式排列） */
function renderCellGrid(gridHashes, containerId) {
  let container = document.getElementById(containerId);
  container.innerHTML = '';
  
  if (!gridHashes || gridHashes.length === 0) {
    container.innerHTML = '<div style="color:#888;">暂无数据</div>';
    return;
  }
  
  let gridDiv = document.createElement('div');
  gridDiv.style.display = 'flex';
  gridDiv.style.flexWrap = 'wrap';
  gridDiv.style.gap = '4px';
  gridDiv.style.justifyContent = 'flex-start';
  
  for (let item of gridHashes) {
    let cell = document.createElement('div');
    cell.style.width = '50px';
    cell.style.height = '50px';
    cell.style.background = '#fff';
    cell.style.borderRadius = '4px';
    cell.style.overflow = 'hidden';
    cell.title = `ID: ${item.id}`;
    
    // 显示灰度缩略图
    if (item.canvas) {
      let img = document.createElement('img');
      img.src = canvasToGrayscaleBase64(item.canvas);
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'cover';
      cell.appendChild(img);
    }
    
    gridDiv.appendChild(cell);
  }
  
  container.appendChild(gridDiv);
}

/** 渲染 ID-图标映射表（表格形式，灰度 base64 图片） */
function renderStats(stats, containerId) {
  let container = document.getElementById(containerId);
  container.innerHTML = `
    <div style="font-family: monospace; font-size: 12px; line-height: 1.6;">
      <div><strong>总格子数:</strong> ${stats.totalCells}</div>
      <div><strong>唯一图标数:</strong> ${stats.uniqueIcons}</div>
      <div><strong>平均每个图标出现:</strong> ${(stats.totalCells / stats.uniqueIcons).toFixed(1)} 次</div>
      <div style="margin-top: 15px;"><strong>ID - 图标映射表:</strong></div>
      <div style="margin-top: 8px;">
        ${renderIdIconTable(stats.uniqueIcons)}
      </div>
    </div>
  `;
}

/** 渲染 ID-图标映射表格 */
function renderIdIconTable(uniqueCount) {
  // 按 ID 分组，收集每个 ID 对应的格子
  let idToCells = new Map();
  for (let item of gridHashes) {
    if (!idToCells.has(item.id)) {
      idToCells.set(item.id, []);
    }
    idToCells.get(item.id).push(item);
  }
  
  // 创建表格
  let table = document.createElement('table');
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  table.style.fontSize = '11px';
  
  // 表头
  let headerRow = document.createElement('tr');
  headerRow.style.background = '#e94560';
  headerRow.style.color = '#fff';
  
  let th1 = document.createElement('th');
  th1.textContent = 'ID';
  th1.style.padding = '6px';
  th1.style.border = '1px solid #ddd';
  
  let th2 = document.createElement('th');
  th2.textContent = '8×8 灰度图';
  th2.style.padding = '6px';
  th2.style.border = '1px solid #ddd';
  
  let th3 = document.createElement('th');
  th3.textContent = '哈希值';
  th3.style.padding = '6px';
  th3.style.border = '1px solid #ddd';
  
  let th4 = document.createElement('th');
  th4.textContent = '出现次数';
  th4.style.padding = '6px';
  th4.style.border = '1px solid #ddd';
  
  headerRow.appendChild(th1);
  headerRow.appendChild(th2);
  headerRow.appendChild(th3);
  headerRow.appendChild(th4);
  table.appendChild(headerRow);
  
  // 数据行
  for (let id = 0; id < uniqueCount; id++) {
    let cells = idToCells.get(id) || [];
    let row = document.createElement('tr');
    // 不设置白色背景，使用透明
    row.style.background = 'transparent';
    
    // ID 列
    let tdId = document.createElement('td');
    tdId.textContent = id;
    tdId.style.padding = '6px';
    tdId.style.border = '1px solid #ddd';
    tdId.style.fontWeight = 'bold';
    tdId.style.textAlign = 'center';
    
    // 8x8 灰度图列
    let tdGray = document.createElement('td');
    tdGray.style.padding = '6px';
    tdGray.style.border = '1px solid #ddd';
    tdGray.style.textAlign = 'center';
    
    if (cells.length > 0 && cells[0].gray8x8) {
      let grayCanvas = document.createElement('canvas');
      grayCanvas.width = HASH_SIZE;
      grayCanvas.height = HASH_SIZE;
      let grayCtx = grayCanvas.getContext('2d');
      let grayImageData = grayCtx.createImageData(HASH_SIZE, HASH_SIZE);
      for (let i = 0; i < HASH_SIZE * HASH_SIZE; i++) {
        let val = cells[0].gray8x8[i];
        grayImageData.data[i * 4] = val;
        grayImageData.data[i * 4 + 1] = val;
        grayImageData.data[i * 4 + 2] = val;
        grayImageData.data[i * 4 + 3] = 255;
      }
      grayCtx.putImageData(grayImageData, 0, 0);
      
      let img = document.createElement('img');
      img.src = grayCanvas.toDataURL('image/png');
      img.style.width = '40px';
      img.style.height = '40px';
      img.style.objectFit = 'contain';
      img.style.imageRendering = 'pixelated';
      tdGray.appendChild(img);
    }
    
    // 哈希列
    let tdHash = document.createElement('td');
    tdHash.textContent = cells.length > 0 ? cells[0].hash : '';
    tdHash.style.padding = '6px';
    tdHash.style.border = '1px solid #ddd';
    tdHash.style.fontFamily = 'monospace';
    tdHash.style.fontSize = '10px';
    tdHash.style.textAlign = 'center';
    
    // 次数列
    let tdCount = document.createElement('td');
    tdCount.textContent = cells.length;
    tdCount.style.padding = '6px';
    tdCount.style.border = '1px solid #ddd';
    tdCount.style.textAlign = 'center';
    
    row.appendChild(tdId);
    row.appendChild(tdGray);
    row.appendChild(tdHash);
    row.appendChild(tdCount);
    table.appendChild(row);
  }
  
  return table.outerHTML;
}
