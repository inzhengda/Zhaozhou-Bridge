/**
 * 赵州桥 · 营造与泄洪演示
 *
 * 两种模式：
 *   营造 —— 按史料时序把桥"砌"出来：桥台 → 28 道拱券 → 侧墙 → 四小拱 → 桥面 → 栏板
 *   泄洪 —— 水量可变，实时给出水位/过水面积/流速/冲击力，并可一键切换敞肩/实肩对比
 *
 * 渲染走 utils/renderer.js 的自研软光栅：面的平均深度做画家算法，
 * 因此水面既是半透明的，又能和水下的桥体正确遮挡。
 */

const B = require('../../utils/bridge.js')
const M = require('../../utils/mat4.js')
const R = require('../../utils/renderer.js')
const H = require('../../utils/hydro.js')

const PHASES = [
  {
    t: B.T.base[0], key: 'base', name: '夯筑桥台',
    desc: '河床为粗砂层，桥台直接砌在砂上，仅做浅基础'
  },
  {
    t: B.T.arch[0], key: 'arch', name: '并列砌筑 28 道拱券',
    desc: '自两端拱脚对称砌向拱顶，每道独立成券，券间以铁腰相连'
  },
  {
    t: B.T.span[0], key: 'span', name: '砌筑拱上侧墙',
    desc: '拱背上砌侧墙，两端各留出两个洞口的位置'
  },
  {
    t: B.T.small[0], key: 'small', name: '架设四个小拱',
    desc: '净跨 3.8 m ×2、2.85 m ×2 —— 世界最早的敞肩拱'
  },
  {
    t: B.T.deck[0], key: 'deck', name: '铺砌桥面',
    desc: '桥面随拱势微拱，连同引桥全长 64.4 m'
  },
  {
    t: B.T.rail[0], key: 'rail', name: '安装栏板望柱',
    desc: '两侧石栏板，桥面可通车马'
  }
]

// 相机预设：给人看构件的几个固定机位
// 机位预设。zoom < 1 是拉近：竖屏上要装下 64 m 的桥就得退很远，
// 那样桥只剩一条细带，所以默认机位裁掉两端引桥，只留主拱和四个小拱。
const VIEWS = {
  full:  { yaw: 0.30, pitch: 0.13,  zoom: 0.78, name: '全景' },
  side:  { yaw: 0.02, pitch: 0.05,  zoom: 1.02, name: '正视' },
  under: { yaw: 0.30, pitch: -0.10, zoom: 0.38, t: [0, 4.6, 0], name: '拱下' },
  small: { yaw: 0.35, pitch: 0.06,  zoom: 0.16, t: [23.0, 5.4, 0], name: '小拱' }
}

const Q_MIN = 150
// 上限卡在两岸高程（8 m）之下：这套简化模型只算了主河槽的过水断面，
// 水位一旦漫上滩地就没有对应的断面积，再往上推出来的水位是虚的。
const Q_MAX = 1080
const Q_DEF = 950          // 默认水量取在四小拱起作用的区间，一进来就能看出敞肩的差别
const WZ_FAR = 520          // 水面沿 z 的延伸：伸到相机身后，免得看到截断边
const WX = 52               // 水面半宽

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v) }

function phaseAt(t) {
  let k = 0
  for (let i = 0; i < PHASES.length; i++) if (t >= PHASES[i].t) k = i
  return k
}

/** 水面能漫到多宽：把 groundY 反解出来（岸坡 1:2） */
function wetHalf(h) {
  if (h <= -0.5) return 0
  if (h <= 0) return 16 + 5 * (h + 0.5)
  if (h <= B.BANK_H) return 20 + (B.BANK_X - 20) * (h / B.BANK_H)
  return WX
}

/** 该点是否在桥下洞口范围内（水能从这里流过去） */
function inOpening(x, y) {
  const ax = Math.abs(x)
  if (y < B.groundY(ax)) return false
  const s = B.smallAt(x)
  if (s && y < B.smallIntrados(s, x)) return true
  return ax <= B.HALF_SPAN && y < B.archIntrados(ax)
}

Page({
  data: {
    mode: 'build',
    playing: true,
    speed: 1,
    progressPct: 0,
    phaseName: PHASES[0].name,
    phaseDesc: PHASES[0].desc,
    phaseIdx: 0,
    builtCount: 0,
    ringTicks: new Array(B.RING_N).fill(false),
    // 泄洪
    q: Q_DEF,
    open: true,
    autoFlood: false,
    view: 'full',
    anno: true,
    readout: { h: 0, area: 0, v: 0, backwater: 0, force: 0, pMax: 0 },
    diff: { forcePct: 0, areaPct: 0, hDown: 0 },
    fps: 0
  },

  // ==================== 生命周期 ====================

  onLoad() {
    this.st = { t: 0, q: Q_DEF }
    this.cam = { yaw: 0.30, pitch: 0.13, zoom: 0.78, tx: 0, ty: 4.2, tz: 0 }
    this.scene = null
    this.parts = []
    this.running = true
    this.last = 0
    this.hudAt = 0
    this.fpsAcc = 0
    this.fpsN = 0
    this.floodT = 0
    this.rc = []            // 拱券网格缓存
    this.rcN = 0
    this.colCache = {}
    this._ready = false
  },

  onReady() {
    const q = wx.createSelectorQuery()
    q.select('#gl').fields({ node: true, size: true }).exec((res) => {
      const r = res && res[0]
      if (!r || !r.node) return
      const canvas = r.node
      const dpr = (wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2) || 2
      canvas.width = Math.round(r.width * dpr)
      canvas.height = Math.round(r.height * dpr)
      const ctx = canvas.getContext('2d')
      ctx.scale(dpr, dpr)

      this.canvas = canvas
      this.ctx = ctx
      this.cw = r.width
      this.ch = r.height
      this.scene = R.createScene()

      // 场景只搭一次，之后每帧只做投影
      this.bs = B.buildScene()
      this.static = { terrain: this.bs.terrain }

      this.initParticles()
      this._ready = true
      this.tick = this.tick.bind(this)
      canvas.requestAnimationFrame(this.tick)
    })
  },

  onUnload() { this.running = false },

  onHide() { this.running = false },
  onShow() {
    if (this.canvas && !this.running) {
      this.running = true
      this.last = 0
      this.canvas.requestAnimationFrame(this.tick)
    }
  },

  // ==================== 主循环 ====================

  tick(ts) {
    if (!this.running || !this._ready) return
    const dt = this.last ? Math.min(0.1, (ts - this.last) / 1000) : 0.016
    this.last = ts

    if (this.data.mode === 'build') {
      if (this.data.playing) {
        this.st.t += dt * this.data.speed
        if (this.st.t >= B.TOTAL) {
          this.st.t = B.TOTAL
          this.setData({ playing: false })
        }
      }
    } else if (this.data.autoFlood) {
      // 洪水过程线：涨快落慢的脉冲
      this.floodT += dt * this.data.speed * 0.55
      const u = (this.floodT % 1 + 1) % 1
      const pulse = Math.pow(Math.sin(Math.PI * u), 1.7)
      this.st.q = Q_MIN + (Q_MAX - Q_MIN) * pulse
    }

    this.stepCameraAnim(dt)
    this.draw(dt)
    this.syncHud(ts, dt)
    this.canvas.requestAnimationFrame(this.tick)
  },

  // ==================== 相机 ====================

  /** 机位切换的缓动，免得镜头瞬移 */
  stepCameraAnim(dt) {
    const an = this.anim
    if (!an) return
    an.t += dt / 0.8
    const e = M.easeOutCubic(an.t)
    const a = an.from, b = an.to
    const c = this.cam
    c.yaw = a.yaw + (b.yaw - a.yaw) * e
    c.pitch = a.pitch + (b.pitch - a.pitch) * e
    c.zoom = a.zoom + (b.zoom - a.zoom) * e
    c.tx = a.tx + (b.tx - a.tx) * e
    c.ty = a.ty + (b.ty - a.ty) * e
    c.tz = a.tz + (b.tz - a.tz) * e
    if (an.t >= 1) this.anim = null
  },

  camera() {
    const c = this.cam
    const aspect = this.cw / Math.max(1, this.ch)
    // 桥全长 64.4 m，按视锥自动退到能装下的距离
    const need = 74
    const base = need / (2 * Math.tan(38 * Math.PI / 360) * Math.max(0.34, Math.min(aspect, 1.9)))
    const d = clamp(base * c.zoom, 26, 340)
    const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch)
    const target = [c.tx, c.ty, c.tz]
    const eye = [
      target[0] + d * cp * Math.sin(c.yaw),
      target[1] + d * sp,
      target[2] + d * cp * Math.cos(c.yaw)
    ]
    if (eye[1] < 1.2) eye[1] = 1.2
    return { eye, target, w: this.cw, h: this.ch, fov: 38 }
  },

  // ==================== 绘制 ====================

  draw(dt) {
    const ctx = this.ctx
    const sc = this.scene
    const W = this.cw, Hh = this.ch

    // 天空：上青下暖，和石材的米白拉开
    const g = ctx.createLinearGradient(0, 0, 0, Hh)
    g.addColorStop(0, '#9fb3c0')
    g.addColorStop(0.40, '#cfd6d3')
    g.addColorStop(0.60, '#e8e1d0')
    g.addColorStop(1, '#d9cfba')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, Hh)

    const cam = this.camera()
    R.beginFrame(sc, cam)
    const d = Math.sqrt(
      Math.pow(cam.eye[0] - cam.target[0], 2) +
      Math.pow(cam.eye[1] - cam.target[1], 2) +
      Math.pow(cam.eye[2] - cam.target[2], 2)
    )
    sc.fog = { r: 208, g: 210, b: 202, near: d * 1.35, far: d * 3.2 }

    const flood = this.data.mode === 'flood'
    const t = flood ? B.TOTAL : this.st.t
    const q = flood ? this.data.q : 0

    let ev = null
    if (flood) ev = H.evaluate(q)
    const waterY = flood ? ev.open.h : 0.9
    const waterDepth = flood ? Math.max(1.2, ev.open.h - H.H_BED) : 1.4

    // ---- 静态地形 ----
    R.pushMesh(sc, this.static.terrain, null, {
      waterY: waterY, waterDepth: waterDepth
    })
    const wo = { waterY: waterY, waterDepth: waterDepth, waterTint: true }

    // ---- 营造中的构件 ----
    const solid = !this.data.open
    this.drawPieces(sc, t, solid, wo)

    // ---- 水面 ----
    const flow = flood ? ev.open.v : 0.5
    this.drawWater(sc, waterY, t, flood, wetHalf(waterY))

    // ---- 水流粒子 & 水花 ----
    this.drawParticles(sc, dt, waterY, flood, flow, ev)
    this.drawFoam(sc, waterY, flood, flow)

    // ---- 压力箭头 ----
    // 贴得太近时箭头和水花会糊满画面，索性不画
    const tooClose = this.cam.zoom < 0.24
    if (flood && !tooClose) this.drawPressure(sc, ev)

    R.flush(ctx, sc)

    // ---- 2D 覆盖层 ----
    if (this.data.anno) this.drawAnnotations(ctx, sc, t, flood, waterY, ev)
    this.drawRingStrip(ctx)
  },

  /** 构件的装配动画：位移 + 缩放 + 泛红高亮 */
  drawPieces(sc, t, solid, wo) {
    const ps = this.bs.pieces
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]
      if (solid && p.hideInSolid) continue
      const raw = (t - p.t0) / (p.t1 - p.t0)
      if (raw <= 0) continue
      const pr = raw > 1 ? 1 : raw

      const mesh = (solid && p.alt) ? p.alt : p.mesh
      const e = M.easeOutCubic(pr)
      const wp = { waterY: wo.waterY, waterDepth: wo.waterDepth, waterTint: true }

      if (pr < 1) {
        // 未落位：从引导位置飞入，尚未抹灰所以偏暖色
        const off = 1 - e
        const s = 0.58 + 0.42 * e
        const mat = M.m4Mul(
          M.m4Translate(p.inOffset[0] * off, p.inOffset[1] * off, p.inOffset[2] * off),
          M.m4ScaleAt(p.pivot, s)
        )
        wp.color = this.hiColor(p.color, off * 0.8)
        wp.bright = 1 + 0.16 * off
        R.pushMesh(sc, mesh, mat, wp)
      } else {
        R.pushMesh(sc, mesh, null, wp)
      }
    }

    // ---- 28 道拱券 ----
    const rings = this.bs.rings
    for (let i = 0; i < rings.length; i++) {
      const rg = rings[i]
      if (t <= rg.t0) continue
      const idx = (t - rg.t0) / (rg.t1 - rg.t0)
      const qp = idx > 1 ? 1 : idx

      let mask = 0
      if (i === 0 || rings[i - 1].t0 > t) mask |= 1
      if (i === rings.length - 1 || rings[i + 1].t0 > t) mask |= 2

      const m = this.ringMesh(i, qp, mask)
      const opt = { waterY: wo.waterY, waterDepth: wo.waterDepth, waterTint: true }
      if (qp < 1) {
        const off = 1 - qp
        opt.color = this.hiColor(B.C.arch, off * 0.75)
        opt.bright = 1 + 0.14 * off
      }
      R.pushMeshT(sc, m, 0, 0, 0, opt)

      // 龙门石：砌到 87% 时从上方落进拱顶
      if (qp > 0.87) {
        const kp = clamp((qp - 0.87) / 0.13, 0, 1)
        const ky = (1 - M.easeOutBack(kp)) * 3.2
        R.pushMeshT(sc, this.keyMesh(i), 0, ky, 0, {
          waterY: wo.waterY, waterDepth: wo.waterDepth, waterTint: true,
          bright: kp < 1 ? 1.2 : 1
        })
      }
    }
  },

  /** 基色掺红：正在砌的石头是"新凿"的暖色，落位后回到青灰石色 */
  hiColor(base, w) {
    const k = Math.round(w * 12)
    const key = base[0] + '_' + k
    let c = this.colCache[key]
    if (!c) {
      const u = k / 12
      c = [
        base[0] + (B.C.hi[0] - base[0]) * u,
        base[1] + (B.C.hi[1] - base[1]) * u,
        base[2] + (B.C.hi[2] - base[2]) * u
      ]
      this.colCache[key] = c
    }
    return c
  },

  ringMesh(i, q, mask) {
    const qk = q >= 1 ? 13 : Math.round(q * 12)
    const key = i * 60 + qk * 4 + mask
    let m = this.rc[key]
    if (!m) {
      if (this.rcN > 420) { this.rc = []; this.rcN = 0 }
      m = B.ringMesh(i, q >= 1 ? 1 : qk / 12, mask)
      this.rc[key] = m
      this.rcN++
    }
    return m
  },

  keyMesh(i) {
    const key = 9000 + i
    let m = this.rc[key]
    if (!m) { m = B.keystoneMesh(i); this.rc[key] = m }
    return m
  },

  // ==================== 水面 ====================

  drawWater(sc, level, t, flood, halfW) {
    const xs = [-WX, -30, -18, -6, 6, 18, 30, WX]
    const zs = [-WZ_FAR, -120, -40, -12, -4, 4, 12, 40, 120, WZ_FAR]
    const C = B.C.water
    const speed = flood ? 1 : 0.35
    const hw = Math.max(0.5, halfW)
    for (let a = 0; a < xs.length - 1; a++) {
      for (let b = 0; b < zs.length - 1; b++) {
        // 按岸坡把水面裁到实际淹没线，水面正好交在岸上，不会插进土坡
        const x0 = Math.max(xs[a], -hw)
        const x1 = Math.min(xs[a + 1], hw)
        if (x1 - x0 < 0.05) continue
        const z0 = zs[b], z1 = zs[b + 1]
        const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2

        const w0 = this.wave(x0, z0, t, speed)
        const w1 = this.wave(x1, z0, t, speed)
        const w2 = this.wave(x1, z1, t, speed)
        const w3 = this.wave(x0, z1, t, speed)
        // 桥前壅水：水面自桥身上游微微抬高
        const bump = (flood && cz > 4 && cz < 60) ? 0.14 * (1 - (cz - 4) / 56) : 0
        const y = level + bump
        // 近岸水浅，透一点让河床露出来；深水处更实
        const depth = Math.max(0, level - B.groundY(Math.abs(cx)))
        const alpha = 0.46 + 0.26 * Math.min(1, depth / 6)
        const k = 0.97 + 0.06 * Math.sin(cx * 0.045 + cz * 0.018 + t * 0.5 * speed)
        R.pushPoly(sc, [
          [x0, y + w0, z0], [x1, y + w1, z0],
          [x1, y + w2, z1], [x0, y + w3, z1]
        ], C, { alpha: alpha, noCull: true, k: k })
      }
    }
  },

  wave(x, z, t, speed) {
    const u = t * speed
    return 0.09 * Math.sin(x * 0.34 + u * 1.7) +
           0.06 * Math.sin(z * 0.21 - u * 2.2) +
           0.04 * Math.sin((x + z) * 0.55 + u * 3.1)
  },

  // ==================== 粒子 / 水花 ====================

  initParticles() {
    const p = []
    for (let i = 0; i < 64; i++) {
      p.push({ x: 0, y: 0, z: 0, a: Math.random() })
    }
    this.parts = p
  },

  drawParticles(sc, dt, level, flood, flow, ev) {
    if (!flood) return
    const halfW = wetHalf(level)
    const v0 = ev.open.v0
    const v = ev.open.v
    const ps = this.parts
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]
      if (p.a === undefined) continue
      // 用生命周期驱动，避免大面积随机抖动
      p.a -= dt * 0.30
      if (p.a <= 0) {
        p.a = 1
        p.z = 90 + Math.random() * 60
        p.x = (Math.random() * 2 - 1) * Math.max(2, halfW * 0.92)
        p.y = level - 0.10 - Math.random() * 0.35
      }
      // 桥下洞口流速快，桥外是天然河道行进流速
      const inB = Math.abs(p.z) < 8 && inOpening(p.x, p.y)
      p.z -= (inB ? v : v0) * dt
      if (p.z < -160) p.a = 0

      const fade = p.a > 0.75 ? (1 - p.a) / 0.25 : (p.a < 0.25 ? p.a / 0.25 : 1)
      const bright = inB ? 1.0 : 0.72
      R.pushSprite(sc, p.x, p.y + 0.05, p.z, 0.55,
        236 * bright, 246 * bright, 250 * bright, 0.55 * fade)
    }
  },

  drawFoam(sc, level, flood, flow) {
    if (!flood) return
    const n = 40
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + level * 0.7
      // 出水口下方：水流过拱后被挑起来，翻出白花
      const z = -6.5 - (i % 5) * 2.4
      const x = Math.sin(a * 1.7 + i) * (12 + (i % 4) * 2)
      const y = level - 0.2 - (i % 3) * 0.5
      const inten = clamp(flow / 6, 0, 1)
      if (Math.abs(x) > 20) continue
      R.pushSprite(sc, x, y, z, 0.9 + (i % 3) * 0.5,
        240, 248, 252, 0.20 + 0.42 * inten)
    }
  },

  // ==================== 压力可视化 ====================

  /** 上游迎水面上的压力箭头：长度和颜色都按静水压强 p = ρgh 来 */
  drawPressure(sc, ev) {
    const level = ev.open.h
    const depthMax = Math.max(1.2, level - H.H_BED)
    const zTail = 5.6
    for (let x = -16; x <= 16; x += 3.2) {
      const top = Math.min(level, B.archIntrados(Math.abs(x)))
      const bot = Math.max(B.groundY(Math.abs(x)), H.H_BED)
      if (top - bot < 0.4) continue
      const rows = 3
      for (let r = 0; r < rows; r++) {
        const y = bot + (top - bot) * ((r + 0.5) / rows)
        if (y > level - 0.15) continue
        const t = clamp((level - y) / depthMax, 0, 1)
        const col = this.ramp(t)
        const len = 1.6 + 4.6 * t
        R.pushSegment(sc, x, y, zTail, x, y, zTail - len, 3.4,
          col[0], col[1], col[2], 0.88)
        R.pushTri(sc,
          [x, y, zTail - len - 1.5],
          [x, y - 0.85, zTail - len],
          [x, y + 0.85, zTail - len],
          col[0], col[1], col[2], 0.92)
      }
    }
  },

  ramp(t) {
    const stops = [
      [0.00, [46, 96, 148]],
      [0.35, [56, 156, 168]],
      [0.70, [218, 168, 76]],
      [1.00, [198, 66, 40]]
    ]
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i], b = stops[i + 1]
      if (t <= b[0]) {
        const k = (t - a[0]) / (b[0] - a[0])
        return [
          a[1][0] + (b[1][0] - a[1][0]) * k,
          a[1][1] + (b[1][1] - a[1][1]) * k,
          a[1][2] + (b[1][2] - a[1][2]) * k
        ]
      }
    }
    return stops[stops.length - 1][1]
  },

  // ==================== 2D 标注 ====================

  drawAnnotations(ctx, sc, t, flood, level, ev) {
    const pr = (x, y, z) => R.project(sc, x, y, z)
    ctx.save()
    ctx.lineWidth = 1
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    if (flood) {
      // 水位线：沿上游面拉一条虚线
      const a = pr(-34, level, 6.2), b = pr(34, level, 6.2)
      if (a && b) {
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'
        ctx.setLineDash([6, 5])
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke()
        ctx.setLineDash([])
        this.tag(ctx, (a[0] + b[0]) / 2, a[1] - 12,
          '水位 +' + level.toFixed(2) + ' m', '#ffffff', 'rgba(32,44,58,0.86)')
      }
    } else if (t > B.T.arch[0]) {
      // 净跨
      const y = -1.6
      const p0 = pr(-B.HALF_SPAN, y, 5.0), p1 = pr(B.HALF_SPAN, y, 5.0)
      if (p0 && p1) {
        ctx.strokeStyle = 'rgba(196,86,58,0.9)'
        ctx.beginPath()
        ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1])
        ctx.moveTo(p0[0], p0[1] - 5); ctx.lineTo(p0[0], p0[1] + 5)
        ctx.moveTo(p1[0], p1[1] - 5); ctx.lineTo(p1[0], p1[1] + 5)
        ctx.stroke()
        this.tag(ctx, (p0[0] + p1[0]) / 2, p0[1] + 14,
          '净跨 37.02 m', '#fdf6ec', 'rgba(158,62,40,0.88)')
      }
      // 矢高
      const f0 = pr(0, 0, 5.0), f1 = pr(0, B.RISE, 5.0)
      if (f0 && f1) {
        ctx.strokeStyle = 'rgba(196,86,58,0.9)'
        ctx.beginPath()
        ctx.moveTo(f0[0], f0[1]); ctx.lineTo(f1[0], f1[1])
        ctx.moveTo(f1[0] - 5, f1[1]); ctx.lineTo(f1[0] + 5, f1[1])
        ctx.stroke()
        this.tag(ctx, f1[0] + 40, (f0[1] + f1[1]) / 2,
          '矢高 7.23 m', '#fdf6ec', 'rgba(158,62,40,0.88)')
      }
      // 小拱
      if (this.data.open && t > B.T.small[0]) {
        const s = B.SMALL[0]
        const s0 = pr(s.xc, s.ys + s.h, 5.0)
        if (s0) {
          this.tag(ctx, s0[0], s0[1] - 22, '小拱 净跨 3.8 m', '#ffffff',
            'rgba(32,44,58,0.82)')
        }
      }
    }
    ctx.restore()
  },

  tag(ctx, x, y, text, fg, bg) {
    const w = ctx.measureText(text).width + 12
    ctx.fillStyle = bg
    this.roundRect(ctx, x - w / 2, y - 8, w, 16, 4)
    ctx.fill()
    ctx.fillStyle = fg
    ctx.fillText(text, x, y)
  },

  roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  },

  /** 屏幕左下的 28 道拱券示意条 */
  drawRingStrip(ctx) {
    if (this.data.mode !== 'build') return
    const n = B.RING_N
    const w = Math.min(150, this.cw - 60)
    // 底栏高度随机型不同，这里按经验值让开
    const x0 = 24, y0 = this.ch - 252
    const cw = w / n
    ctx.save()
    for (let i = 0; i < n; i++) {
      const built = this.st.t > this.bs.rings[i].t1
      const doing = !built && this.st.t > this.bs.rings[i].t0
      ctx.fillStyle = built ? 'rgba(196,86,58,0.92)'
        : (doing ? 'rgba(232,168,96,0.95)' : 'rgba(255,255,255,0.34)')
      ctx.fillRect(x0 + i * cw, y0, Math.max(1, cw - 1.6), 12)
    }
    ctx.font = '9px sans-serif'
    ctx.fillStyle = 'rgba(255,255,255,0.82)'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText('28 道拱券并列砌筑', x0, y0 - 15)
    ctx.restore()
  },

  // ==================== HUD 同步 ====================

  syncHud(ts, dt) {
    if (ts - this.hudAt < 110) return
    const gap = ts - this.hudAt
    this.hudAt = ts
    this.fpsAcc += gap; this.fpsN++
    const fps = this.fpsN >= 6 ? Math.round(1000 / (this.fpsAcc / this.fpsN)) : this.data.fps
    if (this.fpsN >= 6) { this.fpsAcc = 0; this.fpsN = 0 }

    const d = {}
    if (fps !== this.data.fps) d.fps = fps

    if (this.data.mode === 'build') {
      const t = this.st.t
      const pct = Math.round((t / B.TOTAL) * 100)
      if (pct !== this.data.progressPct) d.progressPct = pct
      const pi = phaseAt(t)
      if (pi !== this.data.phaseIdx) {
        d.phaseIdx = pi
        d.phaseName = PHASES[pi].name
        d.phaseDesc = PHASES[pi].desc
      }
      let n = 0
      const ticks = this.data.ringTicks
      let changed = false
      const next = ticks.slice()
      for (let i = 0; i < B.RING_N; i++) {
        const on = t > this.bs.rings[i].t0
        if (on) n++
        if (on !== next[i]) { next[i] = on; changed = true }
      }
      if (n !== this.data.builtCount) d.builtCount = n
      if (changed) d.ringTicks = next
    } else {
      const ev = H.evaluate(this.data.q)
      const o = ev.open, s = ev.solid
      d.readout = {
        h: o.h.toFixed(2),
        area: o.area.toFixed(0),
        v: o.v.toFixed(2),
        force: o.force.toFixed(0),
        backwater: o.backwater.toFixed(2),
        pMax: o.pMax.toFixed(0)
      }
      d.diff = {
        forcePct: s.force > 1 ? ((1 - o.force / s.force) * 100).toFixed(1) : '0.0',
        areaPct: s.area > 1 ? ((o.area / s.area - 1) * 100).toFixed(1) : '0.0',
        hDown: (s.h - o.h).toFixed(2)
      }
    }
    this.setData(d)
  },

  // ==================== 交互 ====================

  onTouchStart(e) {
    this.anim = null
    if (this.data.view !== 'free') this.setData({ view: 'free' })
    const ts = e.touches
    if (ts.length >= 2) {
      this.pinch0 = this.touchDist(ts)
      this.zoom0 = this.cam.zoom
    } else {
      this.pt = { x: ts[0].x, y: ts[0].y }
      this.yaw0 = this.cam.yaw
      this.pitch0 = this.cam.pitch
      this.pinch0 = 0
    }
  },

  onTouchMove(e) {
    const ts = e.touches
    if (ts.length >= 2 && this.pinch0) {
      const dd = this.touchDist(ts)
      this.cam.zoom = clamp(this.zoom0 * (this.pinch0 / Math.max(20, dd)), 0.22, 4.5)
      return
    }
    if (!this.pt || !ts.length) return
    const dx = ts[0].x - this.pt.x
    const dy = ts[0].y - this.pt.y
    this.cam.yaw = this.yaw0 - dx * 0.006
    this.cam.pitch = clamp(this.pitch0 + dy * 0.005, -0.45, 0.95)
  },

  onTouchEnd() { this.pt = null; this.pinch0 = 0 },

  touchDist(ts) {
    const dx = ts[0].x - ts[1].x, dy = ts[0].y - ts[1].y
    return Math.sqrt(dx * dx + dy * dy)
  },

  applyView(key) {
    const v = VIEWS[key]
    if (!v) return
    const tt = v.t || [0, 4.2, 0]
    const c = this.cam
    this.anim = {
      t: 0,
      from: { yaw: c.yaw, pitch: c.pitch, zoom: c.zoom, tx: c.tx, ty: c.ty, tz: c.tz },
      to: { yaw: v.yaw, pitch: v.pitch, zoom: v.zoom, tx: tt[0], ty: tt[1], tz: tt[2] }
    }
    this.setData({ view: key })
  },

  onTab(e) {
    const mode = e.currentTarget.dataset.mode
    if (mode === this.data.mode) return
    if (mode === 'flood') {
      this.st.t = B.TOTAL
      this.setData({ mode, playing: false })
      if (this.data.view === 'full') this.applyView('side')
    } else {
      this.st.t = 0
      this.setData({ mode, playing: true })
      this.applyView('full')
    }
  },

  onTogglePlay() {
    if (this.data.mode !== 'build') return
    const playing = !this.data.playing
    if (!playing && this.st.t >= B.TOTAL) this.st.t = 0
    this.setData({ playing })
  },

  onRestart() { this.st.t = 0; this.setData({ playing: true }) },
  onSeek(e) {
    const v = e.detail.value / 1000
    this.st.t = v * B.TOTAL
    this.setData({ playing: false })
  },
  onSpeed(e) {
    const map = [0.5, 1, 1.6, 2.4]
    this.setData({ speed: map[e.detail.value] || 1 })
  },

  onQ(e) {
    this.st.q = e.detail.value
    this.setData({ q: e.detail.value, autoFlood: false })
  },
  onToggleSpandrel() {
    const open = !this.data.open
    this.setData({ open })
  },
  onToggleAuto() {
    this.floodT = 0
    this.setData({ autoFlood: !this.data.autoFlood })
  },
  onView(e) { this.applyView(e.currentTarget.dataset.v) },
  onToggleAnno() { this.setData({ anno: !this.data.anno }) }
})
