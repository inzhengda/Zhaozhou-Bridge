/**
 * 软渲染器：把 3D 面片投影成 2D 多边形，按深度排序后填充到 Canvas 2D。
 *
 * 流程：世界坐标 → 裁剪空间 → 近平面裁剪 → 透视除法 → 屏幕坐标 → 画家算法排序 → 填充
 * 不透明面和不透明面之间用平均深度排序；半透明面（水面）单独放到第二趟。
 */

const M = require('./mat4.js')

const NEAR_W = 0.25
const MAX_CLIP = 8          // 一个面最多被裁出 8 个顶点

// 颜色字符串缓存：每通道量化到 5 bit，最多 32768 项
const CSS = new Array(32768)

function cssOf(r, g, b) {
  r = r < 0 ? 0 : (r > 255 ? 255 : r | 0)
  g = g < 0 ? 0 : (g > 255 ? 255 : g | 0)
  b = b < 0 ? 0 : (b > 255 ? 255 : b | 0)
  const r5 = r >> 3, g5 = g >> 3, b5 = b >> 3
  const key = (r5 << 10) | (g5 << 5) | b5
  let s = CSS[key]
  if (s === undefined) {
    const R = r5 << 3, G = g5 << 3, B = b5 << 3
    const v = (R << 16) | (G << 8) | B
    s = '#' + ('000000' + v.toString(16)).slice(-6)
    CSS[key] = s
  }
  return s
}

// 静水压强热力色带：水面(≈0) 深蓝 → 青 → 橙 → 河床(最大) 红
const RAMP = [
  [0.00, [46, 96, 148]],
  [0.35, [56, 156, 168]],
  [0.70, [218, 168, 76]],
  [1.00, [198, 66, 40]]
]

function rampAt(t) {
  for (let i = 0; i < RAMP.length - 1; i++) {
    const a = RAMP[i], b = RAMP[i + 1]
    if (t <= b[0]) {
      const k = (t - a[0]) / (b[0] - a[0])
      return [
        a[1][0] + (b[1][0] - a[1][0]) * k,
        a[1][1] + (b[1][1] - a[1][1]) * k,
        a[1][2] + (b[1][2] - a[1][2]) * k
      ]
    }
  }
  return RAMP[RAMP.length - 1][1]
}

// 供裁剪使用的暂存区（平面数组：x, y, z, w × N）
const sx = new Float64Array(MAX_CLIP * 4)
const sy = new Float64Array(MAX_CLIP * 4)

function createScene() {
  return {
    vp: null,
    ex: 0, ey: 0, ez: 0,         // 相机位置
    fx: 0, fy: 0, fz: -1,        // 视线方向
    w: 0, h: 0, cx: 0, cy: 0,
    fog: null,
    list: [],
    stats: { faces: 0, drawn: 0, culled: 0, clipped: 0 }
  }
}

function beginFrame(sc, cam) {
  const aspect = cam.w / Math.max(1, cam.h)
  const proj = M.m4Perspective(cam.fov || 38, aspect, 0.5, 600)
  const view = M.m4LookAt(cam.eye, cam.target, [0, 1, 0])
  sc.vp = M.m4Mul(proj, view)
  sc.ex = cam.eye[0]; sc.ey = cam.eye[1]; sc.ez = cam.eye[2]
  const f = M.vNorm(M.vSub(cam.target, cam.eye))
  sc.fx = f[0]; sc.fy = f[1]; sc.fz = f[2]
  sc.w = cam.w; sc.h = cam.h
  sc.cx = cam.w / 2; sc.cy = cam.h / 2
  sc.list.length = 0
  sc.stats.faces = 0
  sc.stats.drawn = 0
  sc.stats.culled = 0
  sc.stats.clipped = 0
}

/** 把一个世界坐标点投影到屏幕，返回 [sx, sy, depth]；不可见返回 null */
function project(sc, x, y, z) {
  const m = sc.vp
  const cw = m[12] * x + m[13] * y + m[14] * z + m[15]
  if (cw < NEAR_W) return null
  const cxv = m[0] * x + m[1] * y + m[2] * z + m[3]
  const cyv = m[4] * x + m[5] * y + m[6] * z + m[7]
  return [sc.cx + (cxv / cw) * sc.cx, sc.cy - (cyv / cw) * sc.cy, cw]
}

/**
 * 提交一个面。
 * pos     —— 扁平顶点数组
 * idx     —— 顶点索引
 * color   —— 基色 [r,g,b]（0-255）
 * k, j    —— 光照系数 / 石材明暗抖动
 * opt     —— { alpha, tintR/G/B, tintT, noCull, shadeMap }
 */
function pushFace(sc, pos, faceRec, opt) {
  sc.stats.faces++
  const m = sc.vp
  const idx = faceRec.i
  const n = idx.length

  // 背面剔除：用世界空间法线判断（光照方向不参与，只看视线）
  if (!opt.noCull) {
    const a = idx[0] * 3
    const dx = pos[a] - sc.ex, dy = pos[a + 1] - sc.ey, dz = pos[a + 2] - sc.ez
    if (faceRec.nx * dx + faceRec.ny * dy + faceRec.nz * dz >= 0) {
      sc.stats.culled++
      return
    }
  }

  // 1) 变换到裁剪空间
  let cnt = 0
  let sumW = 0
  for (let i = 0; i < n; i++) {
    const v = idx[i] * 3
    const x = pos[v], y = pos[v + 1], z = pos[v + 2]
    const i4 = i * 4
    sx[i4]     = m[0] * x + m[1] * y + m[2] * z + m[3]
    sx[i4 + 1] = m[4] * x + m[5] * y + m[6] * z + m[7]
    sx[i4 + 2] = m[8] * x + m[9] * y + m[10] * z + m[11]
    sx[i4 + 3] = m[12] * x + m[13] * y + m[14] * z + m[15]
    cnt++
  }

  // 2) 近平面裁剪（Sutherland–Hodgman，只裁 w >= NEAR_W 这一个半空间）
  let out = 0
  for (let i = 0; i < cnt; i++) {
    const j = (i + 1) % cnt
    const i4 = i * 4, j4 = j * 4
    const di = sx[i4 + 3] - NEAR_W
    const dj = sx[j4 + 3] - NEAR_W
    if (di >= 0) {
      const o = out * 4
      sy[o] = sx[i4]; sy[o + 1] = sx[i4 + 1]; sy[o + 2] = sx[i4 + 2]; sy[o + 3] = sx[i4 + 3]
      out++
    }
    if ((di >= 0) !== (dj >= 0)) {
      const t = di / (di - dj)
      const o = out * 4
      sy[o]     = sx[i4]     + (sx[j4]     - sx[i4])     * t
      sy[o + 1] = sx[i4 + 1] + (sx[j4 + 1] - sx[i4 + 1]) * t
      sy[o + 2] = sx[i4 + 2] + (sx[j4 + 2] - sx[i4 + 2]) * t
      sy[o + 3] = sx[i4 + 3] + (sx[j4 + 3] - sx[i4 + 3]) * t
      out++
    }
    if (out >= MAX_CLIP - 1) break
  }
  if (out < 3) { sc.stats.clipped++; return }

  // 3) 透视除法 → 屏幕坐标
  const p = new Array(out * 2)
  for (let i = 0; i < out; i++) {
    const i4 = i * 4
    const iw = 1 / sy[i4 + 3]
    p[i * 2]     = sc.cx + sy[i4] * iw * sc.cx
    p[i * 2 + 1] = sc.cy - sy[i4 + 1] * iw * sc.cy
    sumW += sy[i4 + 3]
  }

  // 4) 上色（opt.color 可整件覆盖基色，用于建造高亮）
  const base = opt.color || faceRec.c
  let r = base[0] * faceRec.k * faceRec.j
  let g = base[1] * faceRec.k * faceRec.j
  let b = base[2] * faceRec.k * faceRec.j

  if (opt.tintT > 0) {
    const tt = opt.tintT
    r = r + (opt.tintR - r) * tt
    g = g + (opt.tintG - g) * tt
    b = b + (opt.tintB - b) * tt
  }
  if (opt.bright) {
    r *= opt.bright; g *= opt.bright; b *= opt.bright
  }

  // 没入水下的面
  if (opt.waterY !== undefined && faceRec.cy < opt.waterY) {
    const depth = opt.waterY - faceRec.cy
    if (opt.waterTint) {
      // 桥体：按静水压强 p = ρg·h 做热力着色
      let t = depth / (opt.waterDepth > 1 ? opt.waterDepth : 1)
      if (t > 1) t = 1
      const col = rampAt(t)
      const mix = 0.62
      r += (col[0] - r) * mix
      g += (col[1] - g) * mix
      b += (col[2] - b) * mix
      // 湿面略压暗
      r *= 0.88; g *= 0.92; b *= 0.96
    } else {
      // 地形：只是泡在水里，压暗即可（上色带留给桥体）
      const f = 1 - 0.34 * Math.min(1, depth / (opt.waterDepth || 1))
      r *= f; g *= f * 1.01; b *= f * 1.05
    }
  }

  // 远处压雾，让桥端和地形自然融进天空
  if (sc.fog) {
    const fg = sc.fog
    let t = (sumW / out - fg.near) / (fg.far - fg.near)
    if (t > 0) {
      if (t > 0.94) t = 0.94
      r += (fg.r - r) * t
      g += (fg.g - g) * t
      b += (fg.b - b) * t
    }
  }

  const rec = {
    p: p,
    d: sumW / out,
    s: cssOf(r, g, b),
    a: opt.alpha || 1
  }
  sc.list.push(rec)
  sc.stats.drawn++
}

/** 提交一个网格；mat 为 null 表示顶点已是世界坐标 */
function pushMesh(sc, mesh, mat, opt) {
  const pos = mesh.pos
  if (!mat) {
    for (let i = 0; i < mesh.faces.length; i++) pushFace(sc, pos, mesh.faces[i], opt)
    return
  }
  // 需要变换顶点：复制一份，重算法线
  const tp = new Array(pos.length)
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2]
    tp[i]     = mat[0] * x + mat[1] * y + mat[2] * z + mat[3]
    tp[i + 1] = mat[4] * x + mat[5] * y + mat[6] * z + mat[7]
    tp[i + 2] = mat[8] * x + mat[9] * y + mat[10] * z + mat[11]
  }
  for (let i = 0; i < mesh.faces.length; i++) {
    const f = mesh.faces[i]
    // 法线取变换后的三点重算（矩阵含缩放/旋转时不保持原法线）
    const a = f.i[0] * 3, b = f.i[1] * 3, c = f.i[2] * 3
    const e1x = tp[b] - tp[a], e1y = tp[b + 1] - tp[a + 1], e1z = tp[b + 2] - tp[a + 2]
    const e2x = tp[c] - tp[a], e2y = tp[c + 1] - tp[a + 1], e2z = tp[c + 2] - tp[a + 2]
    let nx = e1y * e2z - e1z * e2y
    let ny = e1z * e2x - e1x * e2z
    let nz = e1x * e2y - e1y * e2x
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
    pushFace(sc, tp, { i: f.i, c: f.c, nx: nx / l, ny: ny / l, nz: nz / l, k: f.k, j: f.j }, opt)
  }
}

/** 只做平移的网格提交：法线和光照系数可原样复用，比重算快得多 */
function pushMeshT(sc, mesh, dx, dy, dz, opt) {
  const pos = mesh.pos
  const tp = new Array(pos.length)
  for (let i = 0; i < pos.length; i += 3) {
    tp[i] = pos[i] + dx
    tp[i + 1] = pos[i + 1] + dy
    tp[i + 2] = pos[i + 2] + dz
  }
  for (let i = 0; i < mesh.faces.length; i++) pushFace(sc, tp, mesh.faces[i], opt)
}

/** 提交一组离散世界坐标点构成的凸多边形 */
function pushPoly(sc, pts, color, opt) {
  const n = pts.length
  const idx = new Array(n)
  const pos = new Array(n * 3)
  for (let i = 0; i < n; i++) {
    pos[i * 3] = pts[i][0]; pos[i * 3 + 1] = pts[i][1]; pos[i * 3 + 2] = pts[i][2]
    idx[i] = i
  }
  // 由绕序求法线
  const e1x = pos[3] - pos[0], e1y = pos[4] - pos[1], e1z = pos[5] - pos[2]
  const e2x = pos[6] - pos[0], e2y = pos[7] - pos[1], e2z = pos[8] - pos[2]
  let nx = e1y * e2z - e1z * e2y
  let ny = e1z * e2x - e1x * e2z
  let nz = e1x * e2y - e1y * e2x
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
  pushFace(sc, pos, {
    i: idx, c: color, nx: nx / l, ny: ny / l, nz: nz / l,
    k: opt.k === undefined ? 1 : opt.k, j: 1
  }, opt)
}

/**
 * 屏幕空间精灵（水流粒子、气泡）：在投影点上放一个正方形色块，
 * 深度取自世界坐标，因此会被桥体正确遮挡。
 */
function pushSprite(sc, x, y, z, size, r, g, b, alpha) {
  const p = project(sc, x, y, z)
  if (!p) return
  const s = size * (60 / Math.max(8, p[2]))     // 近大远小
  const h = s / 2
  const d = p[2]
  const rec = {
    p: [p[0] - h, p[1] - h, p[0] + h, p[1] - h, p[0] + h, p[1] + h, p[0] - h, p[1] + h],
    d: d,
    s: cssOf(r, g, b),
    a: alpha === undefined ? 1 : alpha
  }
  sc.list.push(rec)
}

/** 屏幕空间线段（压力箭头、水流线） */
function pushSegment(sc, ax, ay, az, bx, by, bz, width, r, g, b, alpha) {
  const pa = project(sc, ax, ay, az)
  const pb = project(sc, bx, by, bz)
  if (!pa || !pb) return
  let dx = pb[0] - pa[0], dy = pb[1] - pa[1]
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len < 0.5) return
  dx /= len; dy /= len
  const nx = -dy * width / 2, ny = dx * width / 2
  const rec = {
    p: [
      pa[0] + nx, pa[1] + ny, pb[0] + nx, pb[1] + ny,
      pb[0] - nx, pb[1] - ny, pa[0] - nx, pa[1] - ny
    ],
    d: Math.min(pa[2], pb[2]),
    s: cssOf(r, g, b),
    a: alpha === undefined ? 1 : alpha
  }
  sc.list.push(rec)
}

/** 三角形（箭头头部） */
function pushTri(sc, p0, p1, p2, r, g, b, alpha) {
  const a = project(sc, p0[0], p0[1], p0[2])
  const c = project(sc, p1[0], p1[1], p1[2])
  const d = project(sc, p2[0], p2[1], p2[2])
  if (!a || !c || !d) return
  const rec = {
    p: [a[0], a[1], c[0], c[1], d[0], d[1]],
    d: Math.min(a[2], c[2], d[2]),
    s: cssOf(r, g, b),
    a: alpha === undefined ? 1 : alpha
  }
  sc.list.push(rec)
}

function byDepth(a, b) { return b.d - a.d }

function drawList(ctx, list) {
  for (let i = 0; i < list.length; i++) {
    const rec = list[i]
    const p = rec.p
    ctx.fillStyle = rec.s
    if (rec.a !== 1) ctx.globalAlpha = rec.a
    ctx.beginPath()
    ctx.moveTo(p[0], p[1])
    for (let k = 2; k < p.length; k += 2) ctx.lineTo(p[k], p[k + 1])
    ctx.closePath()
    ctx.fill()
    if (rec.a !== 1) ctx.globalAlpha = 1
  }
}

/**
 * 画家算法：不透明和半透明合成一条队列统一由远及近绘制。
 * 必须合成一条 —— 近处的水面要既能盖住水下的桥体，又会被露出水面的桥体挡住。
 */
function flush(ctx, sc) {
  sc.list.sort(byDepth)
  drawList(ctx, sc.list)
}

module.exports = {
  createScene, beginFrame, pushFace, pushMesh, pushMeshT, pushPoly,
  pushSprite, pushSegment, pushTri, flush, project, cssOf
}
