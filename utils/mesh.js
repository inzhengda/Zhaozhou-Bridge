/**
 * 网格构造工具
 *
 * 世界坐标约定（单位：米）：
 *   x —— 沿桥长方向，也就是主拱跨度方向
 *   y —— 向上
 *   z —— 沿桥宽方向，也就是水流方向（水从 +z 流向 -z）
 *
 * 所有面按「从物体外侧看逆时针」排列，因此法线恒朝外，可做背面剔除。
 */

const LIGHT = [0.392, 0.735, 0.476]   // 指向光源（左上前方）
const AMB = 0.34                       // 环境光占比

let seedOff = 0

/** 改变后续面片的明暗随机种子，让并列的拱券之间有可辨的色差 */
function setSeed(n) { seedOff = n | 0 }

function newMesh() {
  return { pos: [], faces: [] }
}

// 确定性伪随机，用来给每一块石头一点明暗差异，避免大面积同色糊成一片
function jitterOf(seed) {
  let h = (seed * 2654435761) % 4294967296
  h = (h ^ (h >>> 13)) * 1274126177 % 4294967296
  return 1 + ((h % 1000) / 1000 - 0.5) * 0.085
}

function vert(m, x, y, z) {
  m.pos.push(x, y, z)
  return m.pos.length / 3 - 1
}

/**
 * 压入一个面。idx 为顶点索引数组（>=3 个）。
 * 自动由绕序求法线，并预算好光照系数 face.k。
 */
function face(m, idx, color) {
  const p = m.pos
  const a = idx[0] * 3, b = idx[1] * 3, c = idx[2] * 3
  const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2]
  const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2]
  let nx = e1y * e2z - e1z * e2y
  let ny = e1z * e2x - e1x * e2z
  let nz = e1x * e2y - e1y * e2x
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
  nx /= l; ny /= l; nz /= l

  const lam = nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]
  // 半兰伯特，暗面不至于死黑；再叠一点天空/地面补光
  const k = AMB + (1 - AMB) * (lam * 0.5 + 0.5) * 0.94

  // 面心 y，用于判断是否没入水面（水下要做压强热力着色）
  let cy = 0
  for (let t = 0; t < idx.length; t++) cy += p[idx[t] * 3 + 1]
  cy /= idx.length

  m.faces.push({
    i: idx,
    c: color,
    nx, ny, nz,
    k, cy,
    j: jitterOf(m.faces.length + 7 + seedOff)
  })
}

// ---- 图元 ----

/** 单个四边形（p 为 4 个 [x,y,z]） */
function quad(m, p0, p1, p2, p3, color) {
  const a = vert(m, p0[0], p0[1], p0[2])
  const b = vert(m, p1[0], p1[1], p1[2])
  const c = vert(m, p2[0], p2[1], p2[2])
  const d = vert(m, p3[0], p3[1], p3[2])
  face(m, [a, b, c, d], color)
}

/** 二维多边形（xy 平面）沿 z 拉伸成棱柱。poly2d: [[x,y], ...]，会自动纠正为逆时针 */
function prismZ(m, poly2d, z0, z1, color) {
  let pts = poly2d
  // 有向面积 < 0 说明是顺时针，反转
  let area = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length]
    area += p[0] * q[1] - q[0] * p[1]
  }
  if (area < 0) pts = pts.slice().reverse()

  const n = pts.length
  const a0 = [], a1 = []
  for (let i = 0; i < n; i++) {
    a0.push(vert(m, pts[i][0], pts[i][1], z0))
    a1.push(vert(m, pts[i][0], pts[i][1], z1))
  }
  // 前盖 z1：正序 → 法线 +z
  face(m, a1.slice(), color)
  // 后盖 z0：反序 → 法线 -z
  face(m, a0.slice().reverse(), color)
  // 侧面：绕序 [i@z1, i@z0, i+1@z0, i+1@z1] → 法线朝外
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    face(m, [a1[i], a0[i], a0[j], a1[j]], color)
  }
}

/** 轴对齐长方体 */
function box(m, x0, x1, y0, y1, z0, z1, color) {
  prismZ(m, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], z0, z1, color)
}

/**
 * 拱券（弧段环体）。圆心 (cx, cy)，内外弧半径 rIn / rOut，
 * 角度按 phi 计，0 = 正上方（拱顶），正方向朝 +x（右拱脚）。
 * mask: 位 0 = 画 z0 端面，位 1 = 画 z1 端面（拱券并列砌筑时相邻面互相遮挡，可省掉）
 */
function archRing(m, cx, cy, rIn, rOut, phi0, phi1, z0, z1, segs, color, mask) {
  const O0 = [], O1 = [], I0 = [], I1 = []
  for (let s = 0; s <= segs; s++) {
    const phi = phi0 + (phi1 - phi0) * (s / segs)
    const sp = Math.sin(phi), cp = Math.cos(phi)
    O0.push(vert(m, cx + rOut * sp, cy + rOut * cp, z0))
    O1.push(vert(m, cx + rOut * sp, cy + rOut * cp, z1))
    I0.push(vert(m, cx + rIn * sp, cy + rIn * cp, z0))
    I1.push(vert(m, cx + rIn * sp, cy + rIn * cp, z1))
  }
  for (let s = 0; s < segs; s++) {
    // 外弧面（法线朝外）
    face(m, [O0[s], O1[s], O1[s + 1], O0[s + 1]], color)
    // 内弧面（法线朝圆心）
    face(m, [I0[s], I0[s + 1], I1[s + 1], I1[s]], color)
    // 两侧端面
    if (mask & 1) face(m, [I0[s], O0[s], O0[s + 1], I0[s + 1]], color)
    if (mask & 2) face(m, [I1[s], I1[s + 1], O1[s + 1], O1[s]], color)
  }
  // 起拱端 / 收拱端的径向端面
  face(m, [O0[0], I0[0], I1[0], O1[0]], color)
  face(m, [I0[segs], O0[segs], O1[segs], I1[segs]], color)
}

/** 把 src 的所有顶点/面并进 dst（带索引偏移） */
function merge(dst, src) {
  const off = dst.pos.length / 3
  for (let i = 0; i < src.pos.length; i++) dst.pos.push(src.pos[i])
  for (let i = 0; i < src.faces.length; i++) {
    const f = src.faces[i]
    const idx = new Array(f.i.length)
    for (let j = 0; j < idx.length; j++) idx[j] = f.i[j] + off
    dst.faces.push({ i: idx, c: f.c, nx: f.nx, ny: f.ny, nz: f.nz, k: f.k, cy: f.cy, j: f.j })
  }
}

/** 计算网格包围盒中心，用作装配动画的缩放轴心 */
function centerOf(m) {
  if (!m.pos.length) return [0, 0, 0]
  let x0 = Infinity, y0 = Infinity, z0 = Infinity
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
  for (let i = 0; i < m.pos.length; i += 3) {
    const x = m.pos[i], y = m.pos[i + 1], z = m.pos[i + 2]
    if (x < x0) x0 = x; if (x > x1) x1 = x
    if (y < y0) y0 = y; if (y > y1) y1 = y
    if (z < z0) z0 = z; if (z > z1) z1 = z
  }
  return [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]
}

module.exports = {
  newMesh, setSeed, vert, face, quad, prismZ, box, archRing, merge, centerOf, LIGHT, AMB
}
