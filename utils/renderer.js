/**
 * 软渲染器：把 3D 面片投影成 2D 多边形，按深度排序后填充到 Canvas 2D。
 *
 * 流程：世界坐标 → 裁剪空间 → 近平面裁剪 → 透视除法 → 屏幕坐标 → 画家算法排序 → 填充
 * 不透明面和不透明面之间用平均深度排序；半透明面（水面）单独放到第二趟。
 */

const M = require('./mat4.js')
const MESH = require('./mesh.js')

const NEAR_W = 0.25
const MAX_CLIP = 8          // 一个面最多被裁出 8 个顶点

// ---- 描边 ----
// 全片平涂的桥读起来是一坨色块，靠 mesh.js 里每面 ±4% 的明暗抖动分开相邻的券石，
// 代价是大面积糊、拱下没有边界。这里按"这条边两侧的面是什么关系"挑边描一遍：
// 剪影（邻面不存在或背朝相机）和折痕（二面角够大）画，弧面上的分段缝不画。
//
// 三个数都是看着图调的，改之前先跑 tools/render.js 出接触表对比。
const OUTLINE_COS = 0.94     // 二面角余弦阈值，0.94 ≈ 20°。低于它才算折痕
const OUTLINE_DARK = 0.62    // 描边色 = 该面自身的颜色 × 这个。跟着面色走，
                             // 深色石头描深线、浅色描浅线，整幅画才是同一个调子
const OUTLINE_ALPHA = 0.5
const OUTLINE_W = 0.7

// 描边总开关。给 tools/render.js 的 --no-outline 用：判断画面上的某条线
// 到底是描边画出来的、还是几何本身的缝，得能一键关掉对比着看。
// 和 bridge.js 的 setDetail 是同一个路数——留一个开发期的对照开关
let OUTLINE_ON = true
function setOutline(on) { OUTLINE_ON = !!on }

// 没入水下的地形在排序时往后沉这么多米。
//
// 原取 10 m，只够压住"相邻两格格心横坐标差一整格宽"的深度误差（13.8 m ×
// sin(yaw) ≤ 2.7 m）。但拆解机位（yaw 0.75、ty 4.0）相机贴着南岸，脚下
// 湿河床格的真实深度只有四五米，+10 之后仍近于几十米外的水面格——画家
// 算法让水面先画、河床后画，河面中央就悬出一块 21 m 宽的暗绿滩涂。
// 河床隔着半透明水面被看见靠的是水面后画叠色，与河床自己的排序值无关；
// 而水上的东西（桥体、景物）wet 判定为假，从不跟河床比这个偏置。所以
// 直接把湿面沉到任何机位的任何水面格之外（水面最远 camDist×2.5 ≈ 850 m），
// 一劳永逸。
const WET_SINK = 2000

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
    stats: { faces: 0, drawn: 0, culled: 0, clipped: 0, off: 0 }
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
  sc.stats.off = 0
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
  let nw = 0                    // 落在相机前方的顶点数
  let fTop = -1e9               // 这个面在世界里的最高点，判"是否整块没入水下"用
  for (let i = 0; i < n; i++) {
    const v = idx[i] * 3
    const x = pos[v], y = pos[v + 1], z = pos[v + 2]
    if (y > fTop) fTop = y
    const i4 = i * 4
    sx[i4]     = m[0] * x + m[1] * y + m[2] * z + m[3]
    sx[i4 + 1] = m[4] * x + m[5] * y + m[6] * z + m[7]
    sx[i4 + 2] = m[8] * x + m[9] * y + m[10] * z + m[11]
    const w = m[12] * x + m[13] * y + m[14] * z + m[15]
    sx[i4 + 3] = w
    // 排序深度只累加**原本就在相机前方**的顶点，不算近平面裁出来的那几个交点。
    //
    // 交点全落在 w ≈ 0.25 上，谁被裁出一个交点，谁的平均深度就被拉向零，
    // 于是"排在最近、画在最上面"。而地面和岸坡恰好是唯一会被相机站进去的东西：
    // 脚下一格横跨上百米的土地，裁完之后平均深度只剩二三十米，反而压到了
    // 半透明的水面之上，河面上就裂出一道道没有水的干河床，一蓝一褐交替。
    // 只按真实顶点取平均，这些长条才会老老实实排到水面后面去。
    if (w >= NEAR_W) { sumW += w; nw++ }
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
  }
  const depth = nw > 0 ? sumW / nw : 0

  // 整块没入水下的判据，见下面上色那一段的说明。这里先算出来，排序也要用。
  const wet = opt.waterY !== undefined && fTop < opt.waterY

  // 排序深度。默认就是真实深度；没入水下的**地形**往后沉一截。
  //
  // 水面和地形共用同一张分格表，同一格的深度几乎相等，谁先画谁后画都对。
  // 出问题的是**相邻两格**：两格的格心横坐标差着一整格宽，而深度里带着一个
  // x 项（m[12]，本机位约 -0.035），两格就差了 W·sin(yaw)——8 m 的格子在
  // yaw 0.19 时是 1.5 m。栅格化时那条公共边两个面都要涂，排序一错，
  // 河面上就沿着 x = ±8 的格子线裂出一道没入水的干河床，一蓝一褐。
  //
  // 河床只该隔着水被人看见，任何时候都不该盖住水面，索性整体往后沉，
  // 怎么排都排在水面之前。桥体（opt.waterTint）不沉：它有一半露在水上，
  // 要和岸、和水面正常比深度。
  //
  // 沉的是排序用的那个数，真实深度照旧——雾按真实深度拉，
  // 河床本就在起雾距离以内，不该因为排序被顺手推远。
  // opt.dBias：排序深度手动偏置。半透明叠层（倒影、波光）和它贴着的水面
  // 面心深度几乎相等，谁先谁后全看浮点抖动；往相机方向偏 2-3 m 就稳定地
  // 排到水面之后，压在水色上面
  const sortD = (wet && !opt.waterTint) ? depth + WET_SINK : depth + (opt.dBias || 0)

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

  // 没入水下的面。
  //
  // 判据是**整块面都没入水下**，桥体和地形一条规矩。
  //
  // 桥体侧墙、桥台的分条是几米高的竖板，面心在水面以下、板子却有大半露在水上；
  // 按面心一判，整块板连水上那截一起染成水色，水线之上就浮出一排蓝方块——
  // 泄洪时两岸看着像贴了两片塑料。
  //
  // 地形原本按面心判（图省事，想避免岸坡上裂出一条明暗台阶），但地形格是
  // 十几米见方的粗格，一格从岸边一直铺到水里，面心判会把水线以上的干岸
  // 也一并压暗，岸边就横着一条脏带子。改成整块没入才压暗之后，跨水线的
  // 那格保持土色，水下部分交给半透明的蓝色水面去压，水线反而更利落。
  if (wet) {
    const sub = opt.waterY - faceRec.cy          // 没入水下的深度
    if (opt.waterTint) {
      // 桥体：按静水压强 p = ρg·h 做热力着色。
      // 色带上限压到 0.78、混色比降到 0.45：河床处压强确实最大，
      // 但把拱脚整片染成朱红会被误读成"桥要塌了"。深水处收在赭石色上，
      // 真正刺目的红留给压强箭头——在那里红是读数，不是伤害。
      let t = sub / (opt.waterDepth > 1 ? opt.waterDepth : 1)
      if (t > 1) t = 1
      const col = rampAt(t * 0.78)
      const mix = 0.45
      r += (col[0] - r) * mix
      g += (col[1] - g) * mix
      b += (col[2] - b) * mix
      // 湿面略压暗
      r *= 0.88; g *= 0.92; b *= 0.96
    } else {
      // 地形：只是泡在水里，压暗即可（上色带留给桥体）。
      // 压暗量必须是**常数**：原来按每格的没入深度算，河床深浅不一，
      // 半透明的水面之下就显出一格深一格浅的方格纹，整条河看着像铺了瓷砖。
      // 水深的空间感交给水面自己的透明度坡度去表达
      const f = 0.72
      r *= f; g *= f * 1.01; b *= f * 1.05
    }
  }

  // 远处压雾，让桥端和地形自然融进天空
  if (sc.fog) {
    const fg = sc.fog
    let t = (depth - fg.near) / (fg.far - fg.near)
    if (t > 0) {
      if (t > 0.94) t = 0.94
      r += (fg.r - r) * t
      g += (fg.g - g) * t
      b += (fg.b - b) * t
    }
  }

  const rec = {
    p: p,
    d: sortD,
    s: cssOf(r, g, b),
    a: opt.alpha || 1,
    // opt.seam：描边压接缝。只用于不透明面（地形等）描本色，
    // 盖住共享边的 AA 缝隙；半透明面（水面）描边自身也是格线来源，
    // 由调用方保证不描边（消融对账：描边去净后目检干净）
    ln: opt.seam ? (opt.seamLn || 1) : 0
  }

  // 5) 描边。逐条边问一句"这条边看不看得见"，看得见的收进 o。
  //
  // 只在**没被近平面裁过**的面上做：裁剪会往 p 里插交点，p 的下标就和
  // idx 对不上了，映射不回"这是第几条边"。裁剪到的面占全画幅 2% 不到
  // （全景 2333 个面里 44 个），少描这几条边看不出来。
  if (OUTLINE_ON && opt.outline !== false && faceRec.nb && out === n && n >= 3) {
    const fs = opt.mesh ? opt.mesh.faces : null
    const nb = faceRec.nb
    const wx = pos[faceRec.i[0] * 3]
    const wy = pos[faceRec.i[0] * 3 + 1]
    const wz = pos[faceRec.i[0] * 3 + 2]
    const vx = wx - sc.ex, vy = wy - sc.ey, vz = wz - sc.ez
    let o = null
    for (let e = 0; e < n; e++) {
      const k = nb[e]
      let keep = true
      if (k >= 0 && fs) {
        const nf = fs[k]
        // 邻面也朝相机：只有二面角够大才算折痕。拱券内弧是 26 段拼的，
        // 段间夹角不到两度，这一句就是那圈灯芯绒的开关
        if (nf.nx * vx + nf.ny * vy + nf.nz * vz < 0) {
          keep = faceRec.nx * nf.nx + faceRec.ny * nf.ny + faceRec.nz * nf.nz < OUTLINE_COS
        }
      }
      if (!keep) continue
      if (!o) o = []
      const a = e * 2, b = ((e + 1) % n) * 2
      o.push(p[a], p[a + 1], p[b], p[b + 1])
    }
    if (o) {
      rec.o = o
      rec.os = cssOf(r * OUTLINE_DARK, g * OUTLINE_DARK, b * OUTLINE_DARK)
      rec.oa = rec.a * OUTLINE_ALPHA
      rec.ow = OUTLINE_W
    }
  }

  sc.list.push(rec)
  sc.stats.drawn++
}

/** 提交一个网格；mat 为 null 表示顶点已是世界坐标 */
function pushMesh(sc, mesh, mat, opt) {
  const pos = mesh.pos
  // 邻接表只建一次，挂回网格上。之后的每一帧、每一张图都直接读
  if (!mesh.indexed) MESH.indexEdges(mesh)
  if (!opt.mesh) opt = { ...opt, mesh: mesh }
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
    // nb 原样带过去：邻面的法线取自网格里存的那份（未经变换）。这里的矩阵
    // 只有平移和等比缩放（drawPieces 的飞入），等比缩放不改法线，所以够用
    pushFace(sc, tp, {
      i: f.i, c: f.c, nx: nx / l, ny: ny / l, nz: nz / l,
      k: f.k, j: f.j, nb: f.nb
    }, opt)
  }
}

/** 只做平移的网格提交：法线和光照系数可原样复用，比重算快得多 */
function pushMeshT(sc, mesh, dx, dy, dz, opt) {
  const pos = mesh.pos
  if (!mesh.indexed) MESH.indexEdges(mesh)
  if (!opt.mesh) opt = { ...opt, mesh: mesh }
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

function drawList(ctx, list, vw, vh, sc) {
  // 圆头端帽：每条边是独立的一段，平头会在石头转角处留下一丝缝
  ctx.lineCap = 'round'
  // 画幅外的面直接不填。相机拉远时地形与水面铺到 460 m 远，
  // 其中大半落在画幅外——投影、排序都做完了，填进去只会被画布裁掉，
  // 纯属白填。逐面算一次包围盒，跳过这几十个百分点，帧时间就下来了。
  // vw/vh 是设计空间的画幅尺寸；拿不到就不裁（照旧全画）
  const cut = vw > 0 && vh > 0
  for (let i = 0; i < list.length; i++) {
    const rec = list[i]
    const p = rec.p
    if (cut) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (let k = 0; k < p.length; k += 2) {
        const X = p[k], Y = p[k + 1]
        if (X < minX) minX = X
        if (X > maxX) maxX = X
        if (Y < minY) minY = Y
        if (Y > maxY) maxY = Y
      }
      if (maxX < 0 || minX > vw || maxY < 0 || minY > vh) {
        sc.stats.off++
        continue
      }
    }
    ctx.fillStyle = rec.s
    if (rec.a !== 1) ctx.globalAlpha = rec.a
    ctx.beginPath()
    ctx.moveTo(p[0], p[1])
    for (let k = 2; k < p.length; k += 2) ctx.lineTo(p[k], p[k + 1])
    ctx.closePath()
    ctx.fill()

    // 描边必须紧跟着这一面的填充画：整幅画是按深度排好序的，
    // 攒到最后统一描就会让近处的线被远处的面盖掉
    if (rec.o) {
      const o = rec.o
      ctx.strokeStyle = rec.os
      ctx.lineWidth = rec.ow
      if (rec.oa !== 1) ctx.globalAlpha = rec.oa
      ctx.beginPath()
      for (let k = 0; k < o.length; k += 4) {
        ctx.moveTo(o[k], o[k + 1])
        ctx.lineTo(o[k + 2], o[k + 3])
      }
      ctx.stroke()
    }

    // 水面接缝那一圈：描的是这个多边形自己的边（同色加粗），
    // 和上面按二面角挑出来的实体描边不是一回事，两样各画各的
    if (rec.ln) {
      ctx.globalAlpha = rec.a
      ctx.lineWidth = rec.ln
      ctx.lineJoin = 'round'
      ctx.strokeStyle = rec.s
      ctx.stroke()
    }

    if (rec.a !== 1 || (rec.o && rec.oa !== 1)) ctx.globalAlpha = 1
  }
  // 复位：lineCap 是 ctx 上的常驻状态，留着 'round' 会影响后面画的
  // 剖面图尺寸线（线端会多出小圆头，压在标线上很难看）
  ctx.lineCap = 'butt'
}

/**
 * 画家算法：不透明和半透明合成一条队列统一由远及近绘制。
 * 必须合成一条 —— 近处的水面要既能盖住水下的桥体，又会被露出水面的桥体挡住。
 */
function flush(ctx, sc) {
  sc.list.sort(byDepth)
  drawList(ctx, sc.list, sc.w, sc.h, sc)
}

module.exports = {
  createScene, beginFrame, pushFace, pushMesh, pushMeshT, pushPoly,
  pushSprite, pushSegment, pushTri, flush, project, cssOf, setOutline
}
