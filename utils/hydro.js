/**
 * 水文与受力计算
 *
 * 模型约定（工程简化，量级正确、趋势正确，不做精确水力学）：
 *   过水面积 A(h) —— 桥下所有洞口在水面以下的净面积之和，沿桥长积分
 *   过流流速 v(h) —— v = C·√(2g·H)，H 为水深（宽顶堰/孔口流的简化式）
 *   泄流量   Q    —— Q = A·v
 *   水流冲击力 F  —— 由动量变化给出：F = ρ·Q·(v − v₀)，v₀ 为天然河道行进流速
 *   上游壅水 ΔH   —— ΔH = (v² − v₀²) / 2g
 *
 * 这些量的意义：敞肩拱（四个小拱）增大了过水面积 A，
 * 在同一个泄流量 Q 下流速 v 更低 → 冲击力 F 更小、上游壅水 ΔH 更低。
 */

const B = require('./bridge.js')

const G = 9.81
const RHO = 1000        // kg/m³
const V_C = 0.42        // 流速系数
const A0 = 520          // 天然河道行洪断面面积 m²
const H_BED = -0.5      // 河床最低标高
const H_STEP = 0.05
const H_MAX = 12

/** 桥下洞口。只在 x ≥ 0 的半边积分，用 mult 计入对称的另一半 */
function openings(openSpandrel) {
  const list = [{
    x0: 0,
    x1: B.HALF_SPAN,
    bottom: function (x) { return B.groundY(x) },
    top: function (x) { return B.archIntrados(x) },
    mult: 2
  }]
  if (openSpandrel) {
    for (let i = 0; i < B.SMALL.length; i++) {
      const s = B.SMALL[i]
      list.push({
        x0: s.xc - s.a,
        x1: s.xc + s.a,
        bottom: function () { return s.ys },
        top: function (x) { return B.smallIntrados(s, x) },
        mult: 2
      })
    }
  }
  return list
}

function segHeight(op, x, h) {
  const t = op.top(x)
  const top = h < t ? h : t
  const v = top - op.bottom(x)
  return v > 0 ? v : 0
}

const SAMPLES = 64

function buildTable(openSpandrel) {
  const ops = openings(openSpandrel)
  const n = Math.round((H_MAX - H_BED) / H_STEP) + 1
  const A = new Float64Array(n)
  const Q = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const h = H_BED + i * H_STEP
    let area = 0
    for (let j = 0; j < ops.length; j++) {
      const op = ops[j]
      const w = (op.x1 - op.x0) / SAMPLES
      let s = 0
      for (let k = 0; k < SAMPLES; k++) {
        const xa = op.x0 + w * k
        const xb = xa + w
        s += (segHeight(op, xa, h) + segHeight(op, xb, h)) * 0.5 * w
      }
      area += s * op.mult
    }
    A[i] = area
    const depth = h - H_BED > 0 ? h - H_BED : 0
    Q[i] = area * V_C * Math.sqrt(2 * G * depth)
  }
  return { A: A, Q: Q, n: n }
}

const TABLE_OPEN = buildTable(true)
const TABLE_SOLID = buildTable(false)

/** 已知泄流量 Q 反解水位 h（Q 随 h 单调递增，二分即可） */
function levelForQ(Qtarget, table) {
  const Q = table.Q
  if (Qtarget <= Q[0]) return H_BED
  let lo = 0, hi = table.n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (Q[mid] < Qtarget) lo = mid; else hi = mid
  }
  const q0 = Q[lo], q1 = Q[hi]
  const t = q1 > q0 ? (Qtarget - q0) / (q1 - q0) : 0
  return H_BED + (lo + t) * H_STEP
}

function areaAt(h, table) {
  const f = (h - H_BED) / H_STEP
  if (f <= 0) return 0
  if (f >= table.n - 1) return table.A[table.n - 1]
  const i = Math.floor(f)
  return table.A[i] + (table.A[i + 1] - table.A[i]) * (f - i)
}

/**
 * 给定泄流量，算出敞肩 / 实肩两种桥的全部指标
 * 返回 { open: {...}, solid: {...}, q }
 */
function evaluate(q) {
  if (q < 1) q = 1
  const res = { q: q }
  ;[['open', TABLE_OPEN, true], ['solid', TABLE_SOLID, false]].forEach(function (cfg) {
    const h = levelForQ(q, cfg[1])
    const A = areaAt(h, cfg[1])
    const depth = Math.max(0.001, h - H_BED)
    const v = A > 0.01 ? q / A : 0
    const v0 = q / A0
    const dH = (v * v - v0 * v0) / (2 * G)
    const F = RHO * q * Math.max(0, v - v0) / 1000      // kN
    res[cfg[0]] = {
      h: h,
      area: A,
      v: v,
      v0: v0,
      backwater: dH,
      force: F,
      pMax: RHO * G * depth / 1000                       // kPa，河床处最大静水压强
    }
  })
  return res
}

module.exports = {
  evaluate: evaluate,
  buildTable: buildTable,
  areaAt: areaAt,
  levelForQ: levelForQ,
  TABLE_OPEN: TABLE_OPEN,
  TABLE_SOLID: TABLE_SOLID,
  H_BED: H_BED,
  G: G
}
