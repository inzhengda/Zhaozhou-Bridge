/**
 * 赵州桥几何模型（隋·李春，公元 595—605 年）
 *
 * 关键史料数据：
 *   主拱净跨 37.02 m，矢高 7.23 m —— 矢跨比约 1/5，是"坦拱"而非半圆拱
 *   拱圈厚度 1.03 m —— 跨 37 m 只用 1 m 厚的薄拱，是隋代石拱的奇迹
 *   28 道拱券并列砌筑，桥宽 9.0 m，每道厚约 0.32 m
 *   四个小拱净跨 3.8 m ×2、2.85 m ×2 —— "敞肩拱"，泄洪减重
 *   全桥长 64.4 m
 */

const mesh = require('./mesh.js')

// ---- 主拱 ----
const SPAN = 37.02
const HALF_SPAN = SPAN / 2
const RISE = 7.23
const R_IN = (RISE * RISE + HALF_SPAN * HALF_SPAN) / (2 * RISE)   // 27.3094
const R_OUT = R_IN + 1.03                                        // 28.3394
const CY = RISE - R_IN                                           // -20.0794
const HALF_TH = Math.asin(HALF_SPAN / R_IN)                      // 0.74513 rad

// ---- 桥宽 / 拱券 ----
const BRIDGE_W = 9.0
const RING_N = 28
const RING_T = BRIDGE_W / RING_N
const Z0 = -BRIDGE_W / 2

// ---- 桥面 ----
const DECK_HALF = 32.2
const DECK_CROWN = 9.4
const DECK_END = 7.1
const DECK_TH = 0.5
const _sag = DECK_CROWN - DECK_END
const DECK_R = (_sag * _sag + DECK_HALF * DECK_HALF) / (2 * _sag)  // 226.55
const DECK_CY = DECK_CROWN - DECK_R

// ---- 侧墙与桥台分界标高 ----
const SB = 4.0

// ---- 四个小拱 ----
const SMALL = [
  { xc: 21.9, a: 1.9,   h: 1.71,   ys: 4.25, rt: 0.55 },
  { xc: 26.1, a: 1.425, h: 1.2825, ys: 4.35, rt: 0.50 }
]
SMALL.forEach(function (s) {
  s.R = (s.a * s.a + s.h * s.h) / (2 * s.h)
  s.k = (s.h * s.h - s.a * s.a) / (2 * s.h)
  s.cy = s.ys + s.k
  s.th = Math.asin(s.a / s.R)
})

// ---- 配色 ----
const C = {
  arch:   [199, 188, 168],
  small:  [203, 191, 170],
  key:    [216, 173, 104],
  span:   [175, 164, 145],
  base:   [163, 153, 137],
  deck:   [184, 176, 161],
  rail:   [208, 200, 184],
  ground: [122, 116,  99],
  bed:    [100,  96,  84],
  water:  [ 40, 106, 130],
  hi:     [216, 104,  60]
}

// ---- 营造时序（秒）----
const T = {
  base:  [0.0, 2.4],
  arch:  [2.4, 11.6],
  span:  [11.6, 14.4],
  small: [14.4, 17.4],
  deck:  [17.4, 19.6],
  rail:  [19.6, 21.4]
}
const TOTAL = T.rail[1]

const RING_DUR = 2.2
const RING_STAGGER = (T.arch[1] - T.arch[0] - RING_DUR) / (RING_N - 1)
const KEY_FRAC = 0.14
// 圆弧分段数。主拱 85° 弧分 9 段，小拱近看才圆
const RING_SEG = 9
const SMALL_SEG = 14

// ================= 形状函数 =================

/**
 * 河床与河岸标高。两岸抬到 8 m，洪水才有"漫上滩地"的过程可看；
 * 岸坡约 1:3，从 x=20 一直爬到 x=46。
 */
const BANK_H = 8.0
const BANK_X = 46.0

function groundY(ax) {
  if (ax <= 16) return -0.5
  if (ax <= 18.5) return -0.5 + 0.5 * (ax - 16) / 2.5
  if (ax <= 20) return 0
  if (ax <= BANK_X) return BANK_H * (ax - 20) / (BANK_X - 20)
  return BANK_H
}

function archIntrados(x) {
  const t = R_IN * R_IN - x * x
  return t <= 0 ? CY : CY + Math.sqrt(t)
}

function archExtrados(x) {
  const t = R_OUT * R_OUT - x * x
  return t <= 0 ? -1e9 : CY + Math.sqrt(t)
}

/** 桥台底：河床与拱背延伸线取高者，拱脚就能自然坐在桥台上 */
function baseBottom(x) {
  const ax = Math.abs(x)
  let bottom = groundY(ax)
  if (ax < R_OUT) {
    const e = archExtrados(ax)
    if (e > bottom) bottom = e
  }
  if (bottom > SB - 0.12) bottom = SB - 0.12
  return bottom
}

function deckTop(x) {
  const t = DECK_R * DECK_R - x * x
  return t <= 0 ? DECK_END : DECK_CY + Math.sqrt(t)
}
function deckBottom(x) { return deckTop(x) - DECK_TH }

function smallIntrados(s, x) {
  const t = s.R * s.R - (x - s.xc) * (x - s.xc)
  return t <= 0 ? s.ys : s.cy + Math.sqrt(t)
}
function smallExtrados(s, x) {
  const R = s.R + s.rt
  const t = R * R - (x - s.xc) * (x - s.xc)
  return t <= 0 ? s.ys : s.cy + Math.sqrt(t)
}

function smallAt(x) {
  const ax = Math.abs(x)
  for (let i = 0; i < SMALL.length; i++) {
    const s = SMALL[i]
    if (ax >= s.xc - s.a && ax <= s.xc + s.a) return s
  }
  return null
}

// ================= 构件网格 =================

/** 一道拱券。q 为砌筑进度（从两端拱脚对称砌向拱顶），mask 位 0/1 控制 z 端面 */
function ringMesh(i, q, mask) {
  const z0 = Z0 + i * RING_T
  const z1 = z0 + RING_T
  const m = mesh.newMesh()
  mesh.setSeed(i * 977 + 13)
  if (q >= 1) {
    mesh.archRing(m, 0, CY, R_IN, R_OUT, -HALF_TH, HALF_TH, z0, z1, RING_SEG, C.arch, mask)
    return m
  }
  const qq = Math.min(1, q / 0.87)
  const built = HALF_TH * (1 - KEY_FRAC) * qq
  const segs = Math.max(1, Math.round(RING_SEG * (built / HALF_TH)))
  mesh.archRing(m, 0, CY, R_IN, R_OUT, -HALF_TH, -HALF_TH + built, z0, z1, segs, C.arch, 3)
  mesh.archRing(m, 0, CY, R_IN, R_OUT, HALF_TH - built, HALF_TH, z0, z1, segs, C.arch, 3)
  return m
}

/** 龙门石：拱顶合龙的那一块 */
function keystoneMesh(i) {
  const z0 = Z0 + i * RING_T
  const z1 = z0 + RING_T
  const m = mesh.newMesh()
  const g = HALF_TH * KEY_FRAC
  mesh.archRing(m, 0, CY, R_IN, R_OUT, -g, g, z0, z1, 1, C.key, 3)
  return m
}

/** 小拱券。idx 0/1 对应 3.8m / 2.85m，side ±1 决定左右 */
function smallRingMesh(idx, side) {
  const s = SMALL[idx]
  const m = mesh.newMesh()
  mesh.archRing(m, side * s.xc, s.cy, s.R, s.R + s.rt, -s.th, s.th, Z0, -Z0, SMALL_SEG, C.small, 3)
  return m
}

/** 沿 x 分条的墙体（桥台 isBase=true / 侧墙 isBase=false），每个分条返回一个独立构件 */
function wallStrips(open, isBase) {
  const runs = [
    [HALF_SPAN, 20.0, 1],
    [20.0, 23.8, 4],
    [23.8, 24.675, 1],
    [24.675, 27.525, 3],
    [27.525, DECK_HALF, 2]
  ]
  const col = isBase ? C.base : C.span
  const out = []

  const emit = function (xa, xb, zSign) {
    const A = xa * zSign, B = xb * zSign
    const m = mesh.newMesh()

    if (isBase) {
      const b0 = baseBottom(A), b1 = baseBottom(B)
      if (SB - b0 < 0.03 || SB - b1 < 0.03) return
      mesh.prismZ(m, [[A, b0], [B, b1], [B, SB], [A, SB]], Z0, -Z0, col)
    } else {
      const d0 = deckBottom(A), d1 = deckBottom(B)
      const s = open ? smallAt((xa + xb) / 2) : null
      if (s) {
        const i0 = smallIntrados(s, xa), i1 = smallIntrados(s, xb)
        const e0 = smallExtrados(s, xa), e1 = smallExtrados(s, xb)
        if (i0 > SB + 0.03 && i1 > SB + 0.03) {
          mesh.prismZ(m, [[A, SB], [B, SB], [B, i1], [A, i0]], Z0, -Z0, col)
        }
        if (d0 > e0 + 0.03 && d1 > e1 + 0.03) {
          mesh.prismZ(m, [[A, e0], [B, e1], [B, d1], [A, d0]], Z0, -Z0, col)
        }
      } else {
        if (d0 > SB + 0.03 && d1 > SB + 0.03) {
          mesh.prismZ(m, [[A, SB], [B, SB], [B, d1], [A, d0]], Z0, -Z0, col)
        }
      }
    }
    if (!m.faces.length) return
    out.push({
      mesh: m,
      center: mesh.centerOf(m),
      ax: (xa + xb) / 2,
      zSign: zSign
    })
  }

  for (let r = 0; r < runs.length; r++) {
    const run = runs[r]
    const n = run[2]
    for (let k = 0; k < n; k++) {
      const xa = run[0] + (run[1] - run[0]) * (k / n)
      const xb = run[0] + (run[1] - run[0]) * ((k + 1) / n)
      emit(xa, xb, 1)
      emit(xa, xb, -1)
    }
  }
  return out
}

/** 桥面：沿桥长按弧线分段的石板，每段一个构件 */
function deckSegments() {
  const n = 10
  const out = []
  for (let k = 0; k < n; k++) {
    const xa = -DECK_HALF + 2 * DECK_HALF * (k / n)
    const xb = -DECK_HALF + 2 * DECK_HALF * ((k + 1) / n)
    const m = mesh.newMesh()
    mesh.prismZ(m, [
      [xa, deckBottom(xa)], [xb, deckBottom(xb)],
      [xb, deckTop(xb)], [xa, deckTop(xa)]
    ], Z0, -Z0, C.deck)
    out.push({ mesh: m, center: mesh.centerOf(m), ax: (xa + xb) / 2 })
  }
  return out
}

/** 栏板 + 望柱（桥两侧各一件） */
function railPiece(sign) {
  const m = mesh.newMesh()
  const zc = sign * (BRIDGE_W / 2 - 0.16)
  const za = zc - 0.13, zb = zc + 0.13
  const n = 6
  for (let k = 0; k < n; k++) {
    const xa = -DECK_HALF + 2 * DECK_HALF * (k / n)
    const xb = -DECK_HALF + 2 * DECK_HALF * ((k + 1) / n)
    const b0 = deckTop(xa) - 0.06, b1 = deckTop(xb) - 0.06
    mesh.prismZ(m, [[xa, b0], [xb, b1], [xb, b1 + 0.62], [xa, b0 + 0.62]], za, zb, C.rail)
  }
  for (let k = 0; k <= n; k++) {
    const x = -DECK_HALF + 2 * DECK_HALF * (k / n)
    const y = deckTop(x) - 0.06
    mesh.box(m, x - 0.13, x + 0.13, y, y + 0.82, za - 0.06, zb + 0.06, C.rail)
  }
  return m
}

/** 地形：河床 + 河岸，沿 z 拉伸。整块静态，不参与营造动画 */
const TERRAIN_Z = 520

function terrainMesh() {
  const m = mesh.newMesh()
  // 外侧一直铺到 ±90，免得侧向切面出现在画面里
  const xs = [-90, -60, -46, -32, -24, -20, -18.5, -16, 0, 16, 18.5, 20, 24, 32, 46, 60, 90]
  for (let k = 0; k < xs.length - 1; k++) {
    const xa = xs[k], xb = xs[k + 1]
    const ya = groundY(Math.abs(xa)), yb = groundY(Math.abs(xb))
    const col = (Math.abs(xa) <= 16 && Math.abs(xb) <= 16) ? C.bed : C.ground
    // 底面比地表低 2.5 m：面心的 y 就会跟着地表走，
    // 水面之下的"浸没"判断才不会被深处的底边拖偏。
    // z 方向拉得很长，近端伸到相机身后，俯视时才看不到地面的截断边。
    mesh.prismZ(m, [[xa, ya], [xb, yb], [xb, yb - 2.5], [xa, ya - 2.5]],
      -TERRAIN_Z, TERRAIN_Z, col)
  }
  return m
}

// ================= 场景装配 =================

function buildScene() {
  const pieces = []
  const rings = []

  // ---- 1. 桥台与基础 ----
  const baseParts = wallStrips(false, true)
  const [b0, b1] = T.base
  const spanBase = DECK_HALF - HALF_SPAN
  for (let i = 0; i < baseParts.length; i++) {
    const p = baseParts[i]
    const d = (Math.abs(p.ax) - HALF_SPAN) / spanBase   // 0=拱脚 1=桥端
    const t0 = b0 + d * (b1 - b0) * 0.6
    pieces.push({
      id: 'base-' + i, group: 'base', kind: 'mesh',
      mesh: p.mesh, pivot: p.center,
      t0: t0, t1: t0 + (b1 - b0) * 0.62,
      inOffset: [0, -5, 0], mode: 'rise', color: C.base
    })
  }

  // ---- 2. 28 道拱券 ----
  for (let i = 0; i < RING_N; i++) {
    rings.push({
      index: i,
      t0: T.arch[0] + i * RING_STAGGER,
      t1: T.arch[0] + i * RING_STAGGER + RING_DUR
    })
  }

  // ---- 3. 拱上侧墙（敞肩 / 实肩两套，顺序一一对应）----
  const openParts = wallStrips(true, false)
  const solidParts = wallStrips(false, false)
  const [s0, s1] = T.span
  for (let i = 0; i < openParts.length; i++) {
    const p = openParts[i]
    const d = (Math.abs(p.ax) - HALF_SPAN) / spanBase
    const t0 = s0 + d * (s1 - s0) * 0.55
    pieces.push({
      id: 'span-' + i, group: 'span', kind: 'mesh',
      mesh: p.mesh,
      alt: solidParts[i] ? solidParts[i].mesh : null,
      pivot: p.center,
      t0: t0, t1: t0 + (s1 - s0) * 0.6,
      inOffset: [0, -4, 0], mode: 'rise', color: C.span
    })
  }

  // ---- 4. 四个小拱 ----
  const [m0, m1] = T.small
  for (let i = 0; i < 4; i++) {
    const idx = i % 2
    const side = i < 2 ? 1 : -1
    const s = SMALL[idx]
    const t0 = m0 + (m1 - m0) * (i / 4) * 0.65
    pieces.push({
      id: 'small-' + i, group: 'small', kind: 'mesh',
      mesh: smallRingMesh(idx, side),
      pivot: [side * s.xc, s.ys + s.h * 0.5, 0],
      t0: t0, t1: t0 + (m1 - m0) * 0.72,
      inOffset: [0, 0, 7], mode: 'fly', color: C.small,
      hideInSolid: true
    })
  }

  // ---- 5. 桥面 ----
  const deckParts = deckSegments()
  const [d0, d1] = T.deck
  for (let i = 0; i < deckParts.length; i++) {
    const p = deckParts[i]
    const d = Math.abs(p.ax) / DECK_HALF
    const t0 = d0 + d * (d1 - d0) * 0.5
    pieces.push({
      id: 'deck-' + i, group: 'deck', kind: 'mesh',
      mesh: p.mesh, pivot: p.center,
      t0: t0, t1: t0 + (d1 - d0) * 0.62,
      inOffset: [0, 3.5, 0], mode: 'drop', color: C.deck
    })
  }

  // ---- 6. 栏板 ----
  const [r0, r1] = T.rail
  for (let i = 0; i < 2; i++) {
    const sign = i === 0 ? 1 : -1
    const t0 = r0 + (r1 - r0) * i * 0.3
    pieces.push({
      id: 'rail-' + i, group: 'rail', kind: 'mesh',
      mesh: railPiece(sign),
      pivot: [0, deckTop(0), sign * (BRIDGE_W / 2 - 0.16)],
      t0: t0, t1: t0 + (r1 - r0) * 0.7,
      inOffset: [0, 4, 0], mode: 'drop', color: C.rail
    })
  }

  return { pieces: pieces, rings: rings, terrain: terrainMesh(), total: TOTAL }
}

module.exports = {
  C, T, TOTAL, SMALL, RING_N, RING_T, Z0, BRIDGE_W, BANK_H, BANK_X,
  SPAN, HALF_SPAN, RISE, R_IN, R_OUT, CY, HALF_TH,
  DECK_HALF, DECK_CROWN, DECK_END, DECK_TH, DECK_R, DECK_CY, SB,
  groundY, archIntrados, archExtrados, baseBottom,
  deckTop, deckBottom, smallIntrados, smallExtrados, smallAt,
  ringMesh, keystoneMesh, smallRingMesh,
  buildScene
}
