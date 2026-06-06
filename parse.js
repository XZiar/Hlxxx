// ============ 图片解析工具 - FFT 特征提取实现 ============

// 全局常量
const FFT_SIZE = 32;                    // FFT 尺寸 32×32
const FFT_CENTER = Math.floor(FFT_SIZE / 2);  // FFT 中心点坐标 (16)
const MANHATTAN_RADIUS = 10;             // 曼哈顿距离半径（特征提取范围）
const EDGE_DETECTION_WIDTH = 256;       // 边缘检测时的缩放宽度

// ============ 数据类定义 ============

/** 格子数据类 */
class CellData {
  /**
   * @param {number} r - 行索引 (0-13)
   * @param {number} c - 列索引 (0-9)
   * @param {HTMLCanvasElement} canvas - 裁剪后的格子 canvas
   * @param {string} grayscaleBase64 - 灰度图 base64（加窗前）
   * @param {string} windowedGrayscaleBase64 - 加窗后的灰度图 base64
   * @param {Float32Array} fftReal - FFT 实部 (32×32)
   * @param {Float32Array} fftImag - FFT 虚部 (32×32)
   * @param {Float32Array} features - 特征向量
   * @param {Float32Array} shiftedMagnitude - 移位后的幅度谱 (32×32)
   * @param {number|null} id - 聚类后的 ID（初始为 null）
   */
  constructor(r, c, canvas, grayscaleBase64, windowedGrayscaleBase64, fftReal, fftImag, features, shiftedMagnitude, id = null) {
    this.r = r;
    this.c = c;
    this.canvas = canvas;
    this.grayscaleBase64 = grayscaleBase64;
    this.windowedGrayscaleBase64 = windowedGrayscaleBase64;
    this.fftReal = fftReal;
    this.fftImag = fftImag;
    this.features = features;
    this.shiftedMagnitude = shiftedMagnitude;
    this.id = id;
  }
  
  /** 获取格子在 14×10 网格中的线性索引 */
  getIndex() {
    return this.r * 10 + this.c;
  }
  
  /** 更新聚类 ID */
  setId(newId) {
    this.id = newId;
  }
}

/** 聚类类 */
class Cluster {
  /**
   * @param {number} id - 聚类 ID
   * @param {Float32Array} features - 类的特征向量（第一个格子的特征）
   * @param {Float32Array} shiftedMagnitude - 类的幅度谱（第一个格子的幅度谱）
   * @param {CellData[]} cells - 属于该类的格子列表
   */
  constructor(id, features, shiftedMagnitude, cells = []) {
    this.id = id;
    this.features = features;
    this.shiftedMagnitude = shiftedMagnitude;
    this.cells = cells;
  }
  
  /** 添加格子到聚类 */
  addCell(cellData) {
    this.cells.push(cellData);
  }
  
  /** 获取聚类中格子数量 */
  getSize() {
    return this.cells.length;
  }
  
  /** 合并另一个聚类 */
  merge(otherCluster) {
    for (let cell of otherCluster.cells) {
      this.cells.push(cell);
    }
  }
}

/** FFT 结果类 */
class FFTResult {
  /**
   * @param {Float32Array} real - FFT 实部
   * @param {Float32Array} imag - FFT 虚部
   * @param {Float32Array} features - 特征向量
   * @param {Float32Array} shiftedMagnitude - 移位幅度谱
   */
  constructor(real, imag, features, shiftedMagnitude) {
    this.real = real;
    this.imag = imag;
    this.features = features;
    this.shiftedMagnitude = shiftedMagnitude;
  }
}

// FFT 预计算表（cos/sin 缓存，只针对 FFT_SIZE=32）
const FFT_CACHE = (() => {
  const cache = {
    cos: new Float32Array(FFT_SIZE / 2),
    sin: new Float32Array(FFT_SIZE / 2)
  };
  for (let k = 0; k < FFT_SIZE / 2; k++) {
    let angle = -2 * Math.PI * k / FFT_SIZE;
    cache.cos[k] = Math.cos(angle);
    cache.sin[k] = Math.sin(angle);
  }
  return cache;
})();

// 全局状态
let globalClasses = [];           // 全局类列表，每个类包含：{ id, features, shiftedMagnitude, cells: [cellDataItem] }
let idCounter = 0;                 // ID 计数器
let gridHashes = [];              // 14×10 的格子特征（按行列排序）
let SIMILARITY_THRESHOLD = 0.1;  // L1 距离阈值（经验值），可通过界面调整（范围 0-1）
let CROP_TOP_RATIO = 0.12;        // 顶部裁剪比例，可通过界面调整
let CROP_BOTTOM_RATIO = 0.15;     // 底部裁剪比例，可通过界面调整
let CROP_LEFT_RATIO = 0.02;       // 左侧裁剪比例
let CROP_RIGHT_RATIO = 0.02;      // 右侧裁剪比例

// 裁剪比例限制
const MAX_TOP_CROP = 0.30;        // 顶部最大 30%
const MAX_BOTTOM_CROP = 0.30;     // 底部最大 30%
const MAX_LEFT_CROP = 0.05;       // 左侧最大 5%
const MAX_RIGHT_CROP = 0.05;      // 右侧最大 5%

// 特征向量维度：曼哈顿距离在 (2, MANHATTAN_RADIUS) 环形区域内的 FFT 采样点数
// 曼哈顿距离 ≤ r 的点数公式: 2r² + 2r + 1
const FEATURE_COUNT = (() => {
  const outerN = MANHATTAN_RADIUS - 1;  // dist < 10 → max dist = 9
  const outerCount = 2 * outerN * outerN + 2 * outerN + 1;
  const innerN = 2;                     // dist > 2  → 排除 dist ≤ 2
  const innerCount = 2 * innerN * innerN + 2 * innerN + 1;
  return outerCount - innerCount;
})();

// 边缘检测结果
let edgeDetectionResult = null;

// Tukey 窗缓存 Map<key, Float32Array>，key 格式："width_height_r"
const TUKEY_WINDOW_CACHE = new Map();

// ============ 工具函数 ============

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

/** 检测边缘边界 */
function detectEdges(gray, width, height) {
  // 检测横向边缘（行）
  let topEdge = -1;
  let bottomEdge = -1;
  let leftEdge = -1;
  let rightEdge = -1;
  
  // 找第一个和最后一个横向边缘（垂直梯度）
  let edgeRows = [];
  for (let y = 0; y < height - 1; y++) {
    // 统计该行梯度变化超过阈值的像素数
    let count = 0;
    for (let x = 0; x < width; x++) {
      let idx = y * width + x;
      let grad = Math.abs(gray[(y + 1) * width + x] - gray[idx]);
      if (grad > 30) count++;
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
  for (let x = 0; x < width - 1; x++) {
    // 统计该列梯度变化超过阈值的像素数
    let count = 0;
    for (let y = 0; y < height; y++) {
      let idx = y * width + x;
      let grad = Math.abs(gray[y * width + (x + 1)] - gray[idx]);
      if (grad > 30) count++;
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

/** FFT 实现（一维，非递归 Cooley-Tukey 算法） */
function fft1d(real, imag) {
  // 确保输入长度为 FFT_SIZE
  if (real.length !== FFT_SIZE) {
    throw new Error(`FFT length must be ${FFT_SIZE}, got ${real.length}`);
  }
  
  let n = real.length;
  
  // 位反转置换
  let bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let j = 0;
    for (let b = 0; b < bits; b++) {
      if (i & (1 << b)) {
        j |= (1 << (bits - 1 - b));
      }
    }
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  
  // 迭代 FFT（使用预计算的 cos/sin 表）
  for (let len = 2; len <= n; len *= 2) {
    let halfLen = len / 2;
    let angleStep = n / len;
    
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < halfLen; k++) {
        let tableIdx = k * angleStep;
        let cos = FFT_CACHE.cos[tableIdx];
        let sin = FFT_CACHE.sin[tableIdx];
        
        let tReal = cos * real[i + k + halfLen] - sin * imag[i + k + halfLen];
        let tImag = sin * real[i + k + halfLen] + cos * imag[i + k + halfLen];
        
        real[i + k + halfLen] = real[i + k] - tReal;
        imag[i + k + halfLen] = imag[i + k] - tImag;
        real[i + k] = real[i + k] + tReal;
        imag[i + k] = imag[i + k] + tImag;
      }
    }
  }
}

/** 2D FFT */
function fft2d(gray, size) {
  let n = size;
  let real = new Float32Array(n * n);
  let imag = new Float32Array(n * n);
  
  // 初始化
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      real[y * n + x] = gray[y * n + x];
      imag[y * n + x] = 0;
    }
  }
  
  // 复用数组（避免频繁创建）
  let bufferReal = new Float32Array(n);
  let bufferImag = new Float32Array(n);
  
  // 行 FFT
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      bufferReal[x] = real[y * n + x];
      bufferImag[x] = imag[y * n + x];
    }
    fft1d(bufferReal, bufferImag);
    for (let x = 0; x < n; x++) {
      real[y * n + x] = bufferReal[x];
      imag[y * n + x] = bufferImag[x];
    }
  }
  
  // 列 FFT（复用同一组 buffer）
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      bufferReal[y] = real[y * n + x];
      bufferImag[y] = imag[y * n + x];
    }
    fft1d(bufferReal, bufferImag);
    for (let y = 0; y < n; y++) {
      real[y * n + x] = bufferReal[y];
      imag[y * n + x] = bufferImag[y];
    }
  }
  
  return { real, imag };
}

/** FFT 幅度谱计算 */
function fftMagnitude(real, imag) {
  let n = real.length;
  let magnitude = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    magnitude[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
  }
  return magnitude;
}

/** FFT shift（将 DC 分量移到中心） */
function fftShift(magnitude, size) {
  let n = size;
  let shifted = new Float32Array(n * n);
  
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let srcY = (y + n / 2) % n;
      let srcX = (x + n / 2) % n;
      shifted[y * n + x] = magnitude[srcY * n + srcX];
    }
  }
  
  return shifted;
}

/** 计算 FFT 特征（替代 pHash）
 * @param {Float32Array} windowedGray - 已加窗的灰度数组（32×32）
 * @returns {FFTResult} FFT 结果
 */
function calculateFFTFeatures(windowedGray) {
  // 1. 2D FFT（返回实部和虚部）
  let { real, imag } = fft2d(windowedGray, FFT_SIZE);
  
  // 2. 计算幅度谱并做幂函数缩放 y = x^0.4
  let magnitude = fftMagnitude(real, imag);
  for (let i = 0; i < magnitude.length; i++) {
    // 使用幂函数缩放，压缩动态范围
    magnitude[i] = Math.pow(magnitude[i], 0.4);
  }
  
  // 3. FFT shift
  let shifted = fftShift(magnitude, FFT_SIZE);
  
  // 4. 提取特征向量：曼哈顿距离在 2 到 10 之间的环形区域
  let features = new Float32Array(FEATURE_COUNT);
  let idx = 0;
  for (let y = 0; y < FFT_SIZE; y++) {
    for (let x = 0; x < FFT_SIZE; x++) {
      let dx = Math.abs(x - FFT_CENTER);
      let dy = Math.abs(y - FFT_CENTER);
      let manhattanDist = dx + dy;
      
      // 环形区域：2 < 曼哈顿距离 < MANHATTAN_RADIUS
      if (manhattanDist > 2 && manhattanDist < MANHATTAN_RADIUS) {
        features[idx++] = shifted[y * FFT_SIZE + x];
      }
    }
  }
  
  // 返回 FFTResult 实例
  return new FFTResult(real, imag, features, shifted);
}

/** 计算特征距离（L1 距离/SAD，归一化）
 * L1 距离公式：L1 = Σ|a[i] - b[i]| / N
 * N 为向量长度，归一化后距离范围更稳定
 */
function featureDistance(features1, features2) {
  let sumDiff = 0;
  for (let i = 0; i < features1.length; i++) {
    let a = features1[i];
    let b = features2[i];
    sumDiff += Math.abs(a - b);
  }
  
  // L1 归一化：除以向量长度
  return sumDiff / features1.length;
}

/** 将幅度谱转为 base64 图片 */
function magnitudeToBase64(shiftedMagnitude, size) {
  let canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  // 设置 willReadFrequently 提高多次 getImageData 的性能
  let ctx = canvas.getContext('2d', { willReadFrequently: true });
  
  let imageData = ctx.createImageData(size, size);
  
  // 归一化到 0-255
  let max = 0;
  let min = Infinity;
  for (let i = 0; i < shiftedMagnitude.length; i++) {
    if (shiftedMagnitude[i] > max) max = shiftedMagnitude[i];
    if (shiftedMagnitude[i] < min) min = shiftedMagnitude[i];
  }
  
  let range = max - min;
  if (range === 0) range = 1;
  
  for (let i = 0; i < size * size; i++) {
    let val = Math.floor((shiftedMagnitude[i] - min) / range * 255);
    imageData.data[i * 4] = val;
    imageData.data[i * 4 + 1] = val;
    imageData.data[i * 4 + 2] = val;
    imageData.data[i * 4 + 3] = 255;
  }
  
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

/** 将灰度数组转为 base64 图片 */
function grayToBase64(gray, width, height) {
  let canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  let ctx = canvas.getContext('2d', { willReadFrequently: true });
  
  let imageData = ctx.createImageData(width, height);
  
  // 填充灰度值
  for (let i = 0; i < width * height; i++) {
    let val = Math.floor(gray[i]);
    imageData.data[i * 4] = val;
    imageData.data[i * 4 + 1] = val;
    imageData.data[i * 4 + 2] = val;
    imageData.data[i * 4 + 3] = 255;
  }
  
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

/** 格式化特征向量为字符串（支持 Float32Array 和普通数组） */
function formatFeatureVector(features) {
  // 将 Float32Array 或数组转换为普通数组再格式化
  let arr = Array.from(features);
  return arr.map(f => f.toFixed(3)).join(', ');
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
      
      // 计算裁剪比例（坐标减 0.5 修正，因为梯度计算跳过了第一行/列）
      let topRatio = edges.topEdge >= 0 ? (edges.topEdge - 0.5) / targetHeight : 0;
      let bottomRatio = edges.bottomEdge >= 0 ? 1 - (edges.bottomEdge + 1 - 0.5) / targetHeight : 0;
      let leftRatio = edges.leftEdge >= 0 ? (edges.leftEdge - 0.5) / targetWidth : 0;
      let rightRatio = edges.rightEdge >= 0 ? 1 - (edges.rightEdge + 1 - 0.5) / targetWidth : 0;
      
      // Clamp 到 [0, 1] 范围
      topRatio = Math.max(0, Math.min(topRatio, 1));
      bottomRatio = Math.max(0, Math.min(bottomRatio, 1));
      leftRatio = Math.max(0, Math.min(leftRatio, 1));
      rightRatio = Math.max(0, Math.min(rightRatio, 1));
      
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

/** 生成 Tukey 窗系数（1D）
 * Tukey 窗公式：
 * - 当 0 ≤ n < r/2 时：w[n] = 0.5 * (1 + cos(2π/r * (n - r/2)))
 * - 当 r/2 ≤ n ≤ 1-r/2 时：w[n] = 1
 * - 当 1-r/2 < n ≤ 1 时：w[n] = 0.5 * (1 + cos(2π/r * (n - 1 + r/2)))
 * 其中 n = i / (size-1)，r 为余弦部分比例
 */
function generateTukeyWindow1D(size, r) {
  let window = new Float32Array(size);
  
  for (let i = 0; i < size; i++) {
    let n = i / (size - 1);  // 归一化坐标 [0, 1]
    
    if (n < r / 2) {
      // 左侧余弦部分：从 0 平滑上升到 1
      window[i] = 0.5 * (1 + Math.cos(2 * Math.PI / r * (n - r / 2)));
    } else if (n > 1 - r / 2) {
      // 右侧余弦部分：从 1 平滑下降到 0
      window[i] = 0.5 * (1 + Math.cos(2 * Math.PI / r * (n - 1 + r / 2)));
    } else {
      // 中间平坦部分（值为 1）
      window[i] = 1;
    }
  }
  
  return window;
}

/** 获取或创建 Tukey 窗（2D，缓存复用） */
function getTukeyWindow2D(width, height, r) {
  // 生成缓存 key
  let key = `${width}_${height}_${r}`;
  
  // 检查缓存
  if (TUKEY_WINDOW_CACHE.has(key)) {
    return TUKEY_WINDOW_CACHE.get(key);
  }
  
  // 计算 1D 窗
  let windowX = generateTukeyWindow1D(width, r);
  let windowY = generateTukeyWindow1D(height, r);
  
  // 构建 2D 窗
  let window2D = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      window2D[y * width + x] = windowX[x] * windowY[y];
    }
  }
  
  // 存入缓存
  TUKEY_WINDOW_CACHE.set(key, window2D);
  
  return window2D;
}

/** 应用 Tukey 窗口函数到灰度图像（使用缓存，反向模式）用于减少 FFT 的频谱泄漏
 * 其中 r 为余弦部分比例
 * 反向模式：windowed = 255 - (255 - gray) * window
 * - 中间区域（window=1）：保持原灰度值
 * - 边缘区域（window≈0）：趋近于白色（255）
 */
function applyTukeyWindow(gray, width, height, r) {
  // 获取缓存的 2D 窗
  let window2D = getTukeyWindow2D(width, height, r);
  
  // 应用反向窗：周围变亮
  let windowed = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    windowed[i] = 255 - (255 - gray[i]) * window2D[i];
  }
  
  return windowed;
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
      
      // 四舍五入到最邻近整数
      let cropX = Math.round(img.width * cropLeftRatio);
      let cropY = Math.round(img.height * cropTopRatio);
      let cropW = Math.round(img.width * (1 - cropLeftRatio - cropRightRatio));
      let cropH = Math.round(img.height * (1 - cropTopRatio - cropBottomRatio));
      
      // 创建裁剪后的画布（只保留网格区域）
      let croppedCanvas = document.createElement('canvas');
      croppedCanvas.width = cropW;
      croppedCanvas.height = cropH;
      let croppedCtx = croppedCanvas.getContext('2d');
      croppedCtx.drawImage(originalCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
      
      // 计算格子尺寸（四舍五入）
      let cellW = Math.round(cropW / 10);
      let cellH = Math.round(cropH / 14);
      
      // 裁剪 140 个格子（每格再裁掉四周 5% 边框，保留中心 90%）
      let cellData = [];
      for (let r = 0; r < 14; r++) {
        for (let c = 0; c < 10; c++) {
          let x = c * cellW;
          let y = r * cellH;
          let cellCanvas = cropImage(croppedCanvas, x, y, cellW, cellH);
          
          // 裁剪掉四周 5% 边框，保留中心 90%
          let borderCropRatio = 0.05;
          let borderCropX = Math.round(cellCanvas.width * borderCropRatio);
          let borderCropY = Math.round(cellCanvas.height * borderCropRatio);
          let borderCropW = Math.round(cellCanvas.width * (1 - 2 * borderCropRatio));
          let borderCropH = Math.round(cellCanvas.height * (1 - 2 * borderCropRatio));
          let croppedCell = cropImage(cellCanvas, borderCropX, borderCropY, borderCropW, borderCropH);
          
          // 转换为灰度并生成 base64
          let cellCtx = croppedCell.getContext('2d', { willReadFrequently: true });
          let cellImageData = cellCtx.getImageData(0, 0, croppedCell.width, croppedCell.height);
          let grayscaleBase64 = canvasToGrayscaleBase64(croppedCell);
          
          // 在外部进行缩放、灰度转换和加窗（避免重复计算）
          let resized = resizeImage(cellImageData, FFT_SIZE, FFT_SIZE);
          let gray = toGrayscale(resized);
          let windowed = applyTukeyWindow(gray, FFT_SIZE, FFT_SIZE, 0.4);
          
          // 生成加窗后的灰度图 base64（用于识别统计表格）
          let windowedGrayscaleBase64 = grayToBase64(windowed, FFT_SIZE, FFT_SIZE);
          
          // 复用 calculateFFTFeatures 计算核心 FFT 特征（传入已加窗的灰度数据）
          let fftResult = calculateFFTFeatures(windowed);
          
          // 创建 CellData 实例
          let cellDataItem = new CellData(
            r,
            c,
            croppedCell,
            grayscaleBase64,
            windowedGrayscaleBase64,
            fftResult.real,
            fftResult.imag,
            fftResult.features,
            fftResult.shiftedMagnitude,
            null  // 聚类后填充
          );
          
          cellData.push(cellDataItem);
        }
      }
      
      resolve({
        originalCanvas,
        croppedCanvas,
        cellW,
        cellH,
        cellData,
        cropParams: { x: cropX, y: cropY, w: cropW, h: cropH }
      });
    };
    
    img.onerror = reject;
    img.src = URL.createObjectURL(imageFile);
  });
}

/** 第二阶段：对格子进行层次聚类（可重复调用） */
function matchHashes(cellData, threshold) {
  // 重置全局状态
  globalClasses = [];
  idCounter = 0;
  gridHashes = [];
  
  let grid = [];
  
  // 步骤 1：为每个格子创建初始 Cluster 实例
  let tempClasses = [];
  for (let i = 0; i < cellData.length; i++) {
    let item = cellData[i];
    let cluster = new Cluster(i, item.features, item.shiftedMagnitude, [item]);
    tempClasses.push(cluster);
  }
  
  // 步骤 2 & 3：层次聚类 - 重复合并直到超过阈值
  while (true) {
    // 找到距离最短的两个类
    let minDist = Infinity;
    let mergeI = -1, mergeJ = -1;
    
    for (let i = 0; i < tempClasses.length; i++) {
      for (let j = i + 1; j < tempClasses.length; j++) {
        // 提前跳过格子数量和不是偶数的类对（游戏机制：格子必须成对出现）
        if ((tempClasses[i].getSize() + tempClasses[j].getSize()) % 2 !== 0) {
          continue;
        }
        
        // 计算 L1 距离（已归一化）
        let dist = featureDistance(tempClasses[i].features, tempClasses[j].features);
        if (dist < minDist) {
          minDist = dist;
          mergeI = i;
          mergeJ = j;
        }
      }
    }
    
    // 如果最小距离超过阈值，停止合并
    if (minDist > threshold || mergeI === -1) {
      break;
    }
    
    // 获取要合并的两个类
    let classI = tempClasses[mergeI];
    let classJ = tempClasses[mergeJ];
    
    // 加权平均特征向量（保持浮点数原始精度）
    let totalCells = classI.getSize() + classJ.getSize();
    let newFeatures = new Float32Array(classI.features.length);
    for (let k = 0; k < classI.features.length; k++) {
      newFeatures[k] = (classI.features[k] * classI.getSize() + classJ.features[k] * classJ.getSize()) / totalCells;
    }
    
    // 加权平均幅度谱（保持浮点数原始精度）
    let newMagnitude = new Float32Array(classI.shiftedMagnitude.length);
    for (let k = 0; k < classI.shiftedMagnitude.length; k++) {
      newMagnitude[k] = (classI.shiftedMagnitude[k] * classI.getSize() + classJ.shiftedMagnitude[k] * classJ.getSize()) / totalCells;
    }
    
    // 创建新的 Cluster 实例
    let mergedCluster = new Cluster(classI.id, newFeatures, newMagnitude);
    mergedCluster.merge(classI);
    mergedCluster.merge(classJ);
    mergedCluster.features = newFeatures;
    mergedCluster.shiftedMagnitude = newMagnitude;
    
    // 更新类列表（移除 mergeJ，更新 mergeI）
    tempClasses[mergeI] = mergedCluster;
    tempClasses.splice(mergeJ, 1);
  }
  
  // 步骤 4：赋予 ID（从 1 开始），更新 cellData 中的 id，并写入全局类列表
  for (let cls of tempClasses) {
    cls.id = ++idCounter;
    
    // 更新 cellData 中每个格子的 id
    for (let cell of cls.cells) {
      cell.setId(cls.id);
    }
    
    globalClasses.push(cls);
  }
  
  // 构建 gridHashes 和网格（按行列排序）
  // 初始化网格（10 列 x 14 行）
  for (let c = 0; c < 10; c++) {
    grid[c] = [];
  }
  
  for (let cls of globalClasses) {
    for (let cell of cls.cells) {
      let { r, c, canvas } = cell;
      
      gridHashes.push({
        r, c,
        features: cls.features,
        shiftedMagnitude: cls.shiftedMagnitude,
        id: cls.id,
        canvas: canvas
      });
      
      grid[c][r] = cls.id;
    }
  }
  
  // 转置网格（从 [c][r] 转为 [r][c]）
  let finalGrid = [];
  for (let r = 0; r < 14; r++) {
    let row = [];
    for (let c = 0; c < 10; c++) {
      row.push(grid[c][r]);
    }
    finalGrid.push(row);
  }
  
  return {
    grid: finalGrid,
    gridHashes: [...gridHashes],
    stats: {
      totalCells: 140,
      uniqueIcons: idCounter,
      classes: globalClasses
    }
  };
}

/** 完整解析流程（先裁剪，再匹配） */
async function parseImage(imageFile, threshold = SIMILARITY_THRESHOLD, cropTop = CROP_TOP_RATIO, cropBottom = CROP_BOTTOM_RATIO, cropLeft = CROP_LEFT_RATIO, cropRight = CROP_RIGHT_RATIO) {
  // 第一阶段：裁剪（包含特征提取）
  let cropResult = await cropGridRegion(imageFile, cropTop, cropBottom, cropLeft, cropRight);
  
  // 第二阶段：哈希匹配（使用预计算的特征）
  let matchResult = matchHashes(cropResult.cellData, threshold);
  
  // 合并结果
  return {
    ...cropResult,
    ...matchResult
  };
}



// ============ 导出功能 ============

/** 导出网格为文本 */
function exportGridText(grid) {
  return grid.map(row => row.join(' ')).join('\n');
}

/** 将 canvas 转为灰度 base64 */
function canvasToGrayscaleBase64(canvas) {
  // 创建临时 canvas 并设置 willReadFrequently
  let tempCanvas = document.createElement('canvas');
  tempCanvas.width = canvas.width;
  tempCanvas.height = canvas.height;
  let tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
  tempCtx.drawImage(canvas, 0, 0);
  let imageData = tempCtx.getImageData(0, 0, canvas.width, canvas.height);
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
  
  // 创建第二个临时 canvas 转 base64
  let outputCanvas = document.createElement('canvas');
  outputCanvas.width = w;
  outputCanvas.height = h;
  let outputCtx = outputCanvas.getContext('2d');
  outputCtx.putImageData(imageData, 0, 0);
  
  return outputCanvas.toDataURL('image/png');
}

/** 重新解析（使用当前阈值） */
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

/** 渲染格子网格预览（灰度 base64 图片，按裁剪顺序显示） */
function renderCellGrid(cellData, containerId) {
  let container = document.getElementById(containerId);
  container.innerHTML = '';
  
  if (!cellData || cellData.length === 0) {
    container.innerHTML = '<div class="no-data">暂无数据</div>';
    return;
  }
  
  let gridDiv = document.createElement('div');
  gridDiv.className = 'cell-grid';
  
  // cellData 已按裁剪顺序 push，直接遍历
  for (let item of cellData) {
    let cell = document.createElement('div');
    cell.className = 'cell-item';
    cell.title = `ID: ${item.id || '未聚类'}`;
    
    // 显示预生成的灰度缩略图
    if (item.grayscaleBase64) {
      let img = document.createElement('img');
      img.src = item.grayscaleBase64;
      img.className = 'cell-img';
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
    <div class="stats-info">
      <div><strong>总格子数:</strong> ${stats.totalCells}</div>
      <div><strong>唯一图标数:</strong> ${stats.uniqueIcons}</div>
      <div><strong>平均每个图标出现:</strong> ${(stats.totalCells / stats.uniqueIcons).toFixed(1)} 次</div>
      <div class="stats-table-title"><strong>ID - 图标映射表:</strong></div>
      <div>
        ${renderIdIconTable(stats.uniqueIcons)}
      </div>
    </div>
  `;
}

/** 渲染 ID-图标映射表格 */
function renderIdIconTable(uniqueCount) {
  // 创建表格
  let table = document.createElement('table');
  table.className = 'stats-table';
  
  // 表头
  let headerRow = document.createElement('tr');
  
  let th1 = document.createElement('th');
  th1.textContent = 'ID';
  
  let th2 = document.createElement('th');
  th2.textContent = 'FFT 幅度谱（32×32）';
  
  let th3 = document.createElement('th');
  th3.textContent = '特征向量';
  
  let th4 = document.createElement('th');
  th4.textContent = '格子列表';
  
  headerRow.appendChild(th1);
  headerRow.appendChild(th2);
  headerRow.appendChild(th3);
  headerRow.appendChild(th4);
  table.appendChild(headerRow);
  
  // 数据行 - 使用全局类列表
  for (let cls of globalClasses) {
    let row = document.createElement('tr');
    
    // ID 列
    let tdId = document.createElement('td');
    tdId.className = 'id-cell';
    tdId.textContent = cls.id;
    
    // FFT 幅度谱列 - 显示类的幅度谱
    let tdSpectrum = document.createElement('td');
    tdSpectrum.className = 'spectrum-cell';
    
    let spectrumBase64 = magnitudeToBase64(cls.shiftedMagnitude, 32);
    let img = document.createElement('img');
    img.src = spectrumBase64;
    img.className = 'spectrum-img';
    tdSpectrum.appendChild(img);
    
    // 特征向量列 - 显示类的特征向量，自动换行
    let tdFeatures = document.createElement('td');
    tdFeatures.className = 'features-cell';
    tdFeatures.textContent = formatFeatureVector(cls.features);
    
    // 格子列表列 - 显示类中所有格子的灰度图
    let tdCells = document.createElement('td');
    
    let cellsContainer = document.createElement('div');
    cellsContainer.className = 'cells-container';
    
    for (let cell of cls.cells) {
      let cellDiv = document.createElement('div');
      cellDiv.className = 'cell-thumbnail';
      cellDiv.title = `格子 (${cell.r},${cell.c})`;
      
      let img = document.createElement('img');
      img.src = cell.windowedGrayscaleBase64;  // 使用加窗后的灰度图
      cellDiv.appendChild(img);
      
      cellsContainer.appendChild(cellDiv);
    }
    
    tdCells.appendChild(cellsContainer);
    
    row.appendChild(tdId);
    row.appendChild(tdSpectrum);
    row.appendChild(tdFeatures);
    row.appendChild(tdCells);
    table.appendChild(row);
  }
  
  return table.outerHTML;
}
