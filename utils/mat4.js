/**
 * 极简线性代数：3 维向量 + 4x4 矩阵
 * 矩阵按行主序存放 m[row*4 + col]，点按列向量右乘：out[i] = Σ m[i*4+j] * v[j]
 */

function vSub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
function vAdd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
function vScale(a, s) { return [a[0] * s, a[1] * s, a[2] * s] }
function vDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
function vCross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ]
}
function vNorm(a) {
  const x = a[0], y = a[1], z = a[2]
  const l = Math.sqrt(x * x + y * y + z * z) || 1
  return [x / l, y / l, z / l]
}

function m4Identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

function m4Mul(a, b) {
  const o = new Array(16)
  for (let r = 0; r < 4; r++) {
    const i = r * 4
    const a0 = a[i], a1 = a[i + 1], a2 = a[i + 2], a3 = a[i + 3]
    o[i]     = a0 * b[0] + a1 * b[4] + a2 * b[8]  + a3 * b[12]
    o[i + 1] = a0 * b[1] + a1 * b[5] + a2 * b[9]  + a3 * b[13]
    o[i + 2] = a0 * b[2] + a1 * b[6] + a2 * b[10] + a3 * b[14]
    o[i + 3] = a0 * b[3] + a1 * b[7] + a2 * b[11] + a3 * b[15]
  }
  return o
}

function m4Translate(x, y, z) {
  return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1]
}

function m4ScaleAt(pivot, s) {
  // 以 pivot 为中心缩放 s 倍
  const p = pivot
  return [
    s, 0, 0, p[0] * (1 - s),
    0, s, 0, p[1] * (1 - s),
    0, 0, s, p[2] * (1 - s),
    0, 0, 0, 1
  ]
}

function m4Perspective(fovyDeg, aspect, near, far) {
  const f = 1 / Math.tan(fovyDeg * Math.PI / 360)
  const nf = 1 / (near - far)
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, 2 * far * near * nf,
    0, 0, -1, 0
  ]
}

function m4LookAt(eye, target, up) {
  const zA = vNorm(vSub(eye, target))
  const xA = vNorm(vCross(up, zA))
  const yA = vCross(zA, xA)
  return [
    xA[0], xA[1], xA[2], -vDot(xA, eye),
    yA[0], yA[1], yA[2], -vDot(yA, eye),
    zA[0], zA[1], zA[2], -vDot(zA, eye),
    0, 0, 0, 1
  ]
}

// ---- 数值工具 ----

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v) }
function lerp(a, b, t) { return a + (b - a) * t }

function smoothstep(t) {
  t = clamp(t, 0, 1)
  return t * t * (3 - 2 * t)
}

function easeOutCubic(t) {
  const u = 1 - clamp(t, 0, 1)
  return 1 - u * u * u
}

// 回弹式缓动，用于构件"落位"
function easeOutBack(t) {
  t = clamp(t, 0, 1)
  const c1 = 1.70158, c3 = c1 + 1
  const u = t - 1
  return 1 + c3 * u * u * u + c1 * u * u
}

module.exports = {
  vSub, vAdd, vScale, vDot, vCross, vNorm,
  m4Identity, m4Mul, m4Translate, m4ScaleAt, m4Perspective, m4LookAt,
  clamp, lerp, smoothstep, easeOutCubic, easeOutBack
}
