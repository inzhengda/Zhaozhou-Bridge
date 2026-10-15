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
const SRC = require('../../utils/sources.js')

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

// 机位预设。桥是 64.4 m × 11 m 的一条扁带，竖屏上下又窄，
// 所以机位要压得很低很平——相机一抬高，视线俯下去，前襟的河滩就顶掉半屏，
// 桥缩成远处一条细带。俯仰角都取在 0.05 rad 上下（三度）。
// 再平（0.03 以下）地平线就沉下去，天空反倒占掉一半；
// 再陡（0.10 以上）水面又顶上来。0.05 左右天地各半，桥正好压在地平线上。
// 高度目标 ty 取 3.4 而不是默认的 4.2：视线略低于拱顶（7.23 m），
// 拱背才能在天上留出弧形轮廓，而不是被压在地平线上。
//
// 四个小拱在 |x| 11.60~19.41 之间（内 2.85 靠拱顶、外 3.81 靠桥台），
// 所以「小拱」机位对着这一段的中腰，而不是桥台外面。
// 竖屏是 430 × 900 的一条窄画幅，视野内的**高度**是宽度的两倍多：
// 视高永远是视宽的两倍多（430 × 900 的窄画幅），而桥本身才 10 m 高，
// 无论怎么取机位，桥都只能是横贯画面的一条带——这是赵州桥自己的比例
// （64.4 m 长、10 m 高），不是机位没摆好。所以"桥看着小"这件事只能
// 在**横向**上补：把视宽收到 46 m 上下，让 64.4 m 的桥身两端顶出画外，
// 主拱（37 m）占到画幅的七成，桥就撑满了画面，两岸和河流退成背景。
// 早先 zoom 给到 0.95（视宽 70 m），整条桥是装下了，可左右各空出 3 m 灰扑扑的滩地，
// 桥被挤在中间一条，看着当然小。
//
// yaw 也要压住（拖动转视角时另有 clampOrbit() 兜底）。0.10 时相机已经挪到 |x| ≈ 16 m 的河滩上，
// 右手边十几米就是岸坡，前襟换成一大片土黄；压到 0.02~0.035，
// 相机架在河道中线上，左右对称，前襟是水不是滩。
const VIEWS = {
  // 全景：视宽约 46 m，桥身两端（±32.2 m）各切掉几个引桥段，
  // 主拱、四个小拱、桥台全在画内，引桥则"跑出画外"接上两岸
  full:  { yaw: 0.035, pitch: 0.050, zoom: 0.62, t: [0, 3.4, 0], name: '全景' },
  // 正视：再拉近一档，视宽约 41 m，桥台外缘（±23.5 m）刚够露全，
  // 主拱和四个小拱占满画幅。yaw 压到 0.02，相机基本架在河道中线上
  side:  { yaw: 0.02,  pitch: 0.045, zoom: 0.55, t: [0, 3.6, 0], name: '正视' },
  // 拱下：机位压到水面附近，仰起头看拱腹。视宽约 20 m，主拱横贯整个画幅。
  //
  // pitch 只能给到 -0.03 上下，因为俯仰角还管着机位高度：eye.y = ty + d·sin(pitch)，
  // 这一档 d ≈ 61 m，pitch 每多负 0.01，机位就往下掉 0.61 m。给到 -0.05 机位就
  // 沉到水面以下，被兜底的那句 eye.y < 1.2 抬回 1.2 m —— 机位一改，取景全变，
  // 桥会被顶到画幅下缘、上面空出一大片天。所以想再压低机位，只能同时抬 ty，
  // 而 ty 是画面中心，抬高了桥又往下跑，两头不讨好，-0.03 / ty 4.6 是试出来的。
  // yaw 也压到 0.10：再大相机就挪到岸坡上，前襟整片土黄，桥被顶到画幅顶边
  under: { yaw: 0.10,  pitch: -0.030, zoom: 0.27, t: [0, 4.6, 0], name: '拱下' },
  // 小拱特写。视宽 11 m，一对小拱（11.60~19.41，宽 7.8 m）占掉七成画幅。
  // 再往下压就撞到最近距离 26 m 的下限，两个洞两头都会被切掉
  small: { yaw: 0.20,  pitch: 0.03,  zoom: 0.15, t: [15.5, 5.6, 0], name: '小拱' }
}

const Q_MIN = 150
// 上限卡在主拱拱顶内弧（标高 7.23 m）之下：水位一旦越过拱顶，整座桥就没顶了，
// 那已经不是「泄洪」而是溃坝，模型里也没有对应的过水断面。
// 1300 对应水位 6.93 m，内侧那对小拱（起拱线 6.05 m）已经过得挺畅，
// 四孔同时泄洪的样子看得全。
const Q_MAX = 1300
// 默认水量取在外侧两个小拱刚过水、主拱拱腹还露着 2 m 净空的区间（水位约 4.8 m）。
// 两个约束夹出来的：低了小拱不过水，敞肩之利全是 0；
// 再高主拱就快淹平了，画面只剩一片水，桥本身看不见。
const Q_DEF = 900
const DETAIL_ZOOM_ON = 0.42   // 拉近到这个倍率以下才加密拱石分段
const DETAIL_ZOOM_OFF = 0.56  // 回退阈值留点余量，免得在临界点上反复重建
const SPLIT_STEP = 0.5      // 拆解时相邻两券沿桥宽方向让开多少米
const WX = 52               // 水面半宽
// 拖动转视角时，机位的横坐标（桥长方向）不许越过这里。
// 相机一荡到岸上，前襟就换成十几米见方的一大片土，河退到画幅外，
// "河是河、岸是岸"就没了——用户转着看时最刺眼的就是这个。
// 26 m 取在河滩（|x| ≤ 24 是平滩）外沿：机位始终悬在河道上方，
// 前襟还有水；同时四个预设里最靠边的「小拱」（机位在 x ≈ 23）也够得着，
// 一碰就被夹住、镜头一跳。
const ORBIT_X = 26

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v) }

function phaseAt(t) {
  let k = 0
  for (let i = 0; i < PHASES.length; i++) if (t >= PHASES[i].t) k = i
  return k
}

/** 水面能漫到多宽：把 groundY 反解出来，水面正好停在岸坡上 */
function wetHalf(h) {
  if (h <= B.BED_Y) return 0
  if (h <= 0) return 17 + 3 * (h - B.BED_Y)
  if (h <= B.BANK_KNEE_Y) return 24 + (B.BANK_KNEE - 24) * (h / B.BANK_KNEE_Y)
  if (h <= B.BANK_H) {
    return B.BANK_KNEE + (B.BANK_X - B.BANK_KNEE) *
      (h - B.BANK_KNEE_Y) / (B.BANK_H - B.BANK_KNEE_Y)
  }
  return WX
}

/**
 * 桥前壅水：水冲下来顶在桥身上，桥上游那一侧的水面会微微壅高。
 *
 * 这里必须是 z 的**连续**函数。早先按格心算、每个水面格子加一个常数，
 * 相邻两行水面就差了零点零几米——远景里水面几乎与视线平行，
 * 这点高差投影出来就是一两像素的空隙，一整片水面上浮出一排排虚线。
 * 两端取零，接得上远处的平水面。
 */
function backwater(z, flood) {
  if (!flood || z <= 2 || z >= 70) return 0
  return 0.15 * Math.sin(Math.PI * (z - 2) / 68)
}

/**
 * 该竖剖面上、水面以下能过水的区间。
 *
 * 同一个 x 上可能有两段：主拱洞（河床 → 主拱内弧），以及小拱洞
 * （主拱拱背 → 小拱内弧）。两段之间夹着拱券和护拱石，水是流不过去的，
 * 所以必须返回区间数组而不是一个上下界。
 */
function wetBands(x, level) {
  const ax = Math.abs(x)
  const out = []
  const g = B.groundY(ax)
  if (ax <= B.HALF_SPAN) {
    const t = Math.min(level, B.archIntrados(ax))
    if (t > g) out.push([g, t])
  }
  // 小拱洞的下界是**主拱拱背**：洞口一直凿到拱背上，水于是贴着拱背流过去
  const s = B.smallAt(x)
  if (s) {
    const b = B.haunchTop(x)
    const t = Math.min(level, B.smallIntrados(s, x))
    if (t > b) out.push([b, t])
  }
  return out
}

/** 该点是否在桥下洞口范围内（水能从这里流过去） */
function inOpening(x, y) {
  const bands = wetBands(x, Infinity)
  for (let i = 0; i < bands.length; i++) {
    if (y >= bands[i][0] && y < bands[i][1]) return true
  }
  return false
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
    flat: false,          // 坦拱对照：叠一道同跨的半圆拱虚影
    split: false,         // 并列砌券拆解：28 道券沿桥宽散开
    // 泄洪
    q: Q_DEF,
    open: true,
    autoFlood: false,
    view: 'full',
    anno: true,
    readout: { h: 0, area: 0, v: 0, backwater: 0, force: 0, pMax: 0 },
    diff: { forcePct: 0, areaPct: 0, hDown: 0 },
    // 四个小拱的静态账，由 bridge.js 从本题几何积出来（不随水量变）
    sp: {
      voidArea: B.SPANDREL.voidArea.toFixed(1),
      voidVol: B.SPANDREL.voidVol.toFixed(0),
      stone: Math.round(B.SPANDREL.stone / 10) * 10,      // 取整到十吨
      share: (B.SPANDREL.share * 100).toFixed(0),         // 占主拱拱肩面积的比例
      flowing: '尚无一孔过水',                             // 此刻过水的是哪几孔小拱
      nowArea: '0.0'                                      // 此刻小拱让出的过水断面 m²
    },
    // 尺寸数据的出处，静态不变量，见 utils/sources.js
    sources: SRC.GROUPS,
    srcTabs: SRC.TABS,
    srcTab: SRC.TABS[0],
    srcOpen: false,
    fps: 0,
    // 顶部安全区，onLoad 里按状态栏 + 胶囊按钮量出来（px）。见 measureTop
    topTitle: 64, topBtn: 120, topCard: 152, topCmp: 250
  },

  // ==================== 生命周期 ====================

  /**
   * 覆盖层顶部要让开多少像素。
   *
   * 原来各层的 top 都写成 calc(Nrpx + env(safe-area-inset-top))，
   * 可 safe-area-inset-top 只在刘海屏的 iOS 上才有值，模拟器和安卓上
   * 一律是 0——标题就正好顶在状态栏和右上角的胶囊按钮（··· 和 ⊙）上。
   * 索性自己量：状态栏高度 + 胶囊底边。取不到胶囊就按状态栏 + 44 兜底
   * （比多数机型实际需要的略大一点，宁可往下多让一些）。
   *
   * 返回的是 px，直接写进行内 style 用。
   */
  measureTop() {
    const wi = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {}
    const sb = wi.statusBarHeight || 20
    let top = sb + 44
    if (wx.getMenuButtonBoundingClientRect) {
      const mb = wx.getMenuButtonBoundingClientRect()
      if (mb && mb.width > 0 && mb.bottom > 0) top = mb.bottom + 8
    }
    return top
  },

  onLoad() {
    this.st = { t: 0, q: Q_DEF }
    // 顶部四层的落位。层级之间用固定间距，改字号时才不用一处处重算：
    // 抬头（含副题）≈ 56 px、右下角那枚「数据出处」≈ 26 px
    const top = this.measureTop()
    this.setData({
      topTitle: top,
      topBtn: top + 56,      // 数据出处 / FPS，压在抬头右下
      topCard: top + 88,     // 营造阶段卡 / 泄洪读数卡
      topCmp: top + 186      // 敞肩对比卡（只在泄洪模式出现，压在其他卡之下）
    })
    // 开画就落在「全景」机位上，和 VIEWS.full 保持一致
    const v0 = VIEWS.full
    this.cam = {
      yaw: v0.yaw, pitch: v0.pitch, zoom: v0.zoom,
      tx: v0.t[0], ty: v0.t[1], tz: v0.t[2]
    }
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
    this.detailOn = false   // 开局在远景，拱石用粗分段
    this.ex = 0             // 拆解程度 0~1，跟着 data.split 缓动
    this._ex = 0            // 本帧实际用的值，drawPieces 读它
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

    // 拆解程度缓慢跟随开关，散开与并拢都有个过程，看得清券是怎么分开的
    const want = this.data.split ? 1 : 0
    if (this.ex !== want) {
      const k = dt / 0.9
      this.ex += want > this.ex ? Math.min(k, want - this.ex) : -Math.min(k, this.ex - want)
      if (Math.abs(this.ex - want) < 0.004) this.ex = want
    }

    this.stepCameraAnim(dt)
    this.stepDetail()
    this.draw(dt)
    this.syncHud(ts, dt)
    this.canvas.requestAnimationFrame(this.tick)
  },

  /**
   * 拱石精度随相机远近切换：拱券在远处只有几十像素宽，
   * 每道券再切 26 段纯属浪费；拉到跟前时才需要看出券石的砌缝。
   * 重建一次场景约 14 ms，因此只在跨越阈值那一帧做，不做逐帧判断。
   */
  stepDetail() {
    const z = this.cam.zoom
    const want = this.detailOn ? (z < DETAIL_ZOOM_OFF) : (z < DETAIL_ZOOM_ON)
    if (want === !!this.detailOn) return
    if (!B.setDetail(want)) return
    this.detailOn = want
    this.bs = B.buildScene()
    this.static = { terrain: this.bs.terrain }
    this.rc = []            // 拱券缓存的网格是按旧分段建的，全部作废
    this.rcN = 0
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

  /** 观察距离。桥全长 64.4 m，按视锥自动退到能装下的距离 */
  camDist(zoom) {
    const aspect = this.cw / Math.max(1, this.ch)
    const need = 74
    const base = need / (2 * Math.tan(38 * Math.PI / 360) * Math.max(0.34, Math.min(aspect, 1.9)))
    return clamp(base * zoom, 26, 340)
  },

  /**
   * 把机位按回河道里（见 ORBIT_X）。eye.x = tx + d·cos(pitch)·sin(yaw)，
   * 反解出对 yaw 的允许区间。d 随 zoom 变，所以拉近时能荡得开、
   * 拉远时只能小幅侧一侧——恰好把相机的活动范围锁在河面上。
   * 拆解动画走的是另一条路（stepCameraAnim 直接改 cam），不经过这里，
   * 那一段要转到 yaw 1.0 看 28 道券，不受影响。
   */
  clampOrbit() {
    const c = this.cam
    const k = this.camDist(c.zoom) * Math.cos(c.pitch)
    if (k < 0.01) return
    let s = (ORBIT_X - c.tx) / k
    if (s > 1) s = 1
    if (s < -1) s = -1
    const lim = Math.asin(s)
    if (c.yaw > lim) c.yaw = lim
    if (c.yaw < -lim) c.yaw = -lim
  },

  camera() {
    const c = this.cam
    const d = this.camDist(c.zoom)
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
    // 雾按相机到桥的距离定，而不是按场景尺度：这样拉近拉远时
    // 远景（滩地、水面的尽头）始终在同一处化进天空，不会露出硬边。
    // 雾带要够宽——雾是按面心算的，带子一窄，相邻的两格水面就会
    // 明暗突变，在远景里裂成一道道横向条带。
    sc.fog = { r: 208, g: 210, b: 202, near: d * 0.95, far: d * 2.1 }

    const flood = this.data.mode === 'flood'
    const t = flood ? B.TOTAL : this.st.t
    const q = flood ? this.data.q : 0

    let ev = null
    if (flood) ev = H.evaluate(q)
    // 营造时是常水位：水面压在起拱线（标高 0）以下，拱脚和桥台都是干的。
    // 原来取 +0.9 m，等于把常水位抬到起拱线之上，河滩和桥台全泡在水里
    const waterY = flood ? ev.open.h : -0.35
    const waterDepth = flood ? Math.max(1.2, ev.open.h - H.H_BED) : 1.0

    // ---- 静态地形 ----
    R.pushMesh(sc, this.static.terrain, null, {
      waterY: waterY, waterDepth: waterDepth
    })
    // 压强热力色只在泄洪时上身。营造时河浅、桥台埋在砂里，
    // 埋深处的 p = ρgh 会把桥台染成通红，看着像出了错
    const wo = { waterY: waterY, waterDepth: waterDepth, waterTint: flood }

    // ---- 营造中的构件 ----
    const solid = !this.data.open
    this._ex = this.ex
    this.drawPieces(sc, t, solid, wo)

    // ---- 坦拱对照 ----
    // 拆解状态下 28 道券已经摊开，再叠一道半圆拱虚影就太乱，所以不画
    if (this.data.flat && this._ex < 0.02) this.drawFlatCompare(sc, t, cam)

    // ---- 水面 ----
    const flow = flood ? ev.open.v : 0.5
    this.drawWater(sc, waterY, t, flood, wetHalf(waterY), cam.eye[2], d)

    // ---- 水流粒子 & 水花 ----
    this.drawParticles(sc, dt, waterY, flood, flow, ev)
    this.drawFoam(sc, waterY, flood, flow)

    // ---- 压力箭头 ----
    // 贴得太近时箭头和水花会糊满画面，索性不画
    const tooClose = this.cam.zoom < 0.24
    if (flood && !tooClose) this.drawPressure(sc, waterY, cam)

    R.flush(ctx, sc)

    // ---- 2D 覆盖层 ----
    if (this.data.anno) this.drawAnnotations(ctx, sc, t, flood, waterY, ev)
    this.drawRingStrip(ctx)
  },

  /** 构件的装配动画：位移 + 缩放 + 泛红高亮 */
  drawPieces(sc, t, solid, wo) {
    const ex = this._ex
    // 拆解时只留 28 道券：桥台、侧墙、桥面就是把券裹起来的，留着就看不见券
    if (ex > 0.02) {
      this.drawRings(sc, t, wo, ex)
      return
    }
    const ps = this.bs.pieces
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]
      if (solid && p.hideInSolid) continue
      const raw = (t - p.t0) / (p.t1 - p.t0)
      if (raw <= 0) continue
      const pr = raw > 1 ? 1 : raw

      const mesh = (solid && p.alt) ? p.alt : p.mesh
      const e = M.easeOutCubic(pr)
      const wp = { waterY: wo.waterY, waterDepth: wo.waterDepth, waterTint: wo.waterTint }

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

    this.drawRings(sc, t, wo, 0)
  },

  /**
   * 坦拱对照：在原拱的同一条起拱线上，叠一道**同跨的半圆拱**虚影。
   *
   * 半圆拱的矢高 = 跨度的一半 = 18.51 m，是赵州桥 7.23 m 的两倍半还多。
   * 虚影一罩上去，「为什么赵州桥要把拱做得这么扁」就不用讲了——
   * 半圆拱的桥面得从河面爬到近 20 m 高，两岸引道要拉出去几百米；
   * 而这个扁拱只抬到 7.23 m，桥面几乎是平着过河的，车马才上得去。
   *
   * 虚影画在靠相机那一侧的立面（同 w 平面），与真拱轮廓同处一张剖面，
   * 比较才成立；再补一道从半圆拱顶到真拱顶的竖直虚线，量出高差。
   */
  drawFlatCompare(sc, t, cam) {
    if (t < B.T.arch[0] + B.RING_DUR) return
    const R0 = B.HALF_SPAN                 // 半圆拱半径 = 跨度的一半
    const zf = (cam.eye[2] >= 0 ? 1 : -1) * (B.HW_SPRING + 0.3)
    const col = [192, 57, 43]
    // 虚线：每隔一段空一段，比实线更像"参考线"，不会跟真拱的边混淆。
    // 段数不能多——步距按弧长算，44 段时每段才 0.7 m，在这个机位下
    // 投影不到 6 px，一整道弧就散成了一圈红点，看着像噪点
    const n = 18
    for (let i = 0; i < n; i++) {
      if (i % 2) continue
      const a0 = Math.PI * ((n - i) / n), a1 = Math.PI * ((n - i - 1) / n)
      R.pushSegment(sc,
        R0 * Math.cos(a0), R0 * Math.sin(a0), zf,
        R0 * Math.cos(a1), R0 * Math.sin(a1), zf,
        2.0, col[0], col[1], col[2], 0.9)
    }
    // 拱顶高差：从半圆拱顶（0, 18.51）落到真拱顶（0, 7.23）
    const yTop = R0
    const yReal = B.RISE
    const segs = 14
    for (let i = 0; i < segs; i += 2) {
      R.pushSegment(sc, 0, yTop + (yReal - yTop) * (i / segs), zf,
        0, yTop + (yReal - yTop) * ((i + 1) / segs), zf,
        2.0, col[0], col[1], col[2], 0.9)
    }
  },

  /**
   * 28 道并列拱券。
   *
   * ex 是拆解程度：每道券沿桥宽方向（z 轴）按序错开，28 道摊成一排，
   * 「整座桥其实是由 28 片独立的拱券并排拼起来的」一眼就看得见。
   * 摊开的同时在券与券之间补上腰铁——正是那些嵌在两券缝里的铁件，
   * 才把 28 片彼此不相连的券锁成一个整体。不摊开时缝宽为零，
   * 腰铁也就藏进石头里，不必画。
   */
  drawRings(sc, t, wo, ex) {
    const rings = this.bs.rings
    const N = rings.length
    // 摊开的步距。券本身只有 9/28 ≈ 0.32 m 宽：步距给大了（0.9 m 试过），
    // 28 道摊成一把稀稀拉拉的梳子，反倒看不出是一道道完整的券；
    // 0.5 m 让券宽与缝宽大致相当，摊开仍是一个"包"，缝隙又分明
    const step = ex * SPLIT_STEP
    const dz = (i) => (i - (N - 1) / 2) * step
    for (let i = 0; i < N; i++) {
      const rg = rings[i]
      if (t <= rg.t0) continue
      const idx = (t - rg.t0) / (rg.t1 - rg.t0)
      const qp = idx > 1 ? 1 : idx

      let mask = 0
      if (i === 0 || rings[i - 1].t0 > t) mask |= 1
      if (i === N - 1 || rings[i + 1].t0 > t) mask |= 2

      const m = this.ringMesh(i, qp, mask)
      const opt = { waterY: wo.waterY, waterDepth: wo.waterDepth, waterTint: wo.waterTint }
      if (qp < 1) {
        const off = 1 - qp
        opt.color = this.hiColor(B.C.arch, off * 0.75)
        opt.bright = 1 + 0.14 * off
      }
      R.pushMeshT(sc, m, 0, 0, dz(i), opt)

      // 龙门石：砌到 87% 时从上方落进拱顶
      if (qp > 0.87) {
        const kp = clamp((qp - 0.87) / 0.13, 0, 1)
        const ky = (1 - M.easeOutBack(kp)) * 3.2
        R.pushMeshT(sc, this.keyMesh(i), 0, ky, dz(i), {
          waterY: wo.waterY, waterDepth: wo.waterDepth, waterTint: wo.waterTint,
          bright: kp < 1 ? 1.2 : 1
        })
      }
    }

    if (ex > 0.25 && t > B.T.arch[0] + B.RING_DUR) this.drawWaistIron(sc, dz, ex)
  },

  /**
   * 腰铁：嵌在相邻两道券的缝里、把两片石头咬住的铁件。
   *
   * 画在拱背（外弧）一侧，沿弧长每隔一段一个。长度正好等于摊开后的缝宽，
   * 缝越宽铁件拉得越长，散开的时候就成了 27 根拉住各券的拉杆。
   * 底色用铁青灰，比石色深一档，在青灰石上压得住又不刺眼。
   */
  drawWaistIron(sc, dz, ex) {
    const N = B.RING_N
    // 半径取券厚的中线：腰铁是嵌在石缝里的，不会露在拱腹或拱背上
    const rMid = (B.R_IN + B.R_OUT) / 2
    // 半拱上取 4 处，两侧对称共 8 处。再多就成了满屏的横线，
    // 腰铁本身是稀疏的铁件，太密反而看不出是"一件一件"的铁活
    const n = 4
    for (let i = 0; i + 1 < N; i++) {
      // 该缝的 z 分数位置。券是收分的，z 半宽随拱脚到拱顶从 4.8 收到 4.5，
      // 所以缝面不是一个平面，逐点按该处的半宽算
      const zf = -1 + 2 * (i + 1) / N
      const oa = dz(i), ob = dz(i + 1)
      for (let k = 0; k < n; k++) {
        const u = (k + 0.5) / n
        for (let s = -1; s <= 1; s += 2) {
          const phi = s * B.HALF_TH * u
          const hw = B.HW_CROWN + (B.HW_SPRING - B.HW_CROWN) * u
          const z = zf * hw
          const x = rMid * Math.sin(phi)
          const y = B.CY + rMid * Math.cos(phi)
          // 两头各往石缝里多伸 0.16 m：腰铁是嵌进两侧券石里的，
          // 只画到缝口就成了一排悬空的短杠。宽度是**像素**不是米（见 renderer.js）
          R.pushSegment(sc, x, y, z + oa - 0.16, x, y, z + ob + 0.16, 5.0,
            70, 68, 74, 0.95)
        }
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

  /**
   * 水面。
   *
   * 沿 z（水流方向）的范围跟着相机走：从相机身后一点开始，
   * 往桥那一侧伸到 1.7 倍观察距离——这个距离已经落在雾的 far 之外，
   * 所以水面的尽头是化进天色里的，不会在画面上留一条生硬的地平线。
   * 桥附近仍然保持密分段，画家算法在那里才排得对。
   */
  drawWater(sc, level, t, flood, halfW, camZ, dist) {
    const zNear = camZ + dist * 0.42
    const zFar = camZ - dist * 2.5
    // 分格表和地形**必须用同一张**（B.TERRAIN_ZS / B.TERRAIN_XS）。
    // 两张表各切各的，同一片水域上地形格和水面格的深度就不是一回事，
    // 深度大的那块先画、小的后画，河面上就会裂出一道道没入水的干河床。
    // 共用一张表之后同一格水域的两个面深度几乎相等，排序里"水后压"的
    // 先后就自然对上了（详见 bridge.js 里 TERRAIN_ZS 的注释）。
    const zs = []
    const zAll = B.TERRAIN_ZS
    for (let i = 0; i < zAll.length; i++) {
      const v = zAll[i]
      if (v > zFar + 1 && v < zNear - 1) zs.push(v)
    }
    zs.push(zFar, zNear)
    zs.sort(function (a, b) { return a - b })
    const xs = B.TERRAIN_XS
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
        const cx = (x0 + x1) / 2

        const w0 = this.wave(x0, z0, t, speed)
        const w1 = this.wave(x1, z0, t, speed)
        const w2 = this.wave(x1, z1, t, speed)
        const w3 = this.wave(x0, z1, t, speed)
        // 壅水按 z 的**角点值**算，同一行相邻两格共用一条边的两个角，
        // 值必然相同，水面严丝合缝地拼在一起（详见 backwater 的注释）
        const ya = level + backwater(z0, flood)
        const yb = level + backwater(z1, flood)
        // 近岸水浅，透一点让河床露出来；深水处更实
        const depth = Math.max(0, level - B.groundY(Math.abs(cx)))
        const alpha = 0.46 + 0.26 * Math.min(1, depth / 6)
        // 这里刻意不按格心给亮度：水面每格是一个平涂的四边形，
        // 格心亮度一旦随位置变，远格与近格之间就会裂出横向的硬条带。
        // 水面质感交给四个角的 wave() 起伏和随深度的透明度。
        R.pushPoly(sc, [
          [x0, ya + w0, z0], [x1, ya + w1, z0],
          [x1, yb + w2, z1], [x0, yb + w3, z1]
        ], C, { alpha: alpha, noCull: true })
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

  /**
   * 出水口下方的翻花。
   *
   * 两处必须留意：花要贴在水面**之上**（压在水面以下会被半透明的水面
   * 盖住，看着像水下浮着一堆白方块）；z、y 要连续抖动，
   * 早先用 `(i % 3)` 这类取模来分散，40 朵花会码成一个整齐的 3×5 网格，
   * 在水面上拉出一排排虚线。
   */
  drawFoam(sc, level, flood, flow) {
    if (!flood) return
    const n = 26
    const inten = clamp(flow / 6, 0, 1)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + level * 0.7
      const r = (i * 37) % 11 / 11          // 0~1 的确定性抖动
      const q = (i * 53) % 13 / 13
      const z = -5.5 - r * 12
      const x = Math.sin(a * 1.7 + i) * (12 + q * 7)
      if (Math.abs(x) > 20) continue
      const y = level + 0.05 + q * 0.30
      R.pushSprite(sc, x, y, z, 0.45 + q * 0.7,
        240, 248, 252, 0.16 + 0.34 * inten)
    }
  },

  // ==================== 压力可视化 ====================

  /**
   * 水压箭头：长度和颜色都按该点的静水压强 p = ρgh 来。
   *
   * 箭头取**拱腹的法线方向**，箭头尖顶在拱腹石上、尾巴留在水里，
   * 也就是"水从洞里往外顶石头"的样子：拱顶处朝上、拱脚处朝外豁，
   * 正是一圈自下而上把拱往外推的力。这样画有两个好处——
   * 一是受力方向和真实的拱腹水压力一致（水压垂直于受水面），
   * 二是箭头躺在 xy 平面里，正视还是斜视都看得见；
   * 早先沿水流方向（z 向）画的箭头在正视机位下完全被压成了几个小方块。
   *
   * 小拱也照画：水位漫过哪一对起拱线，那一对洞里就多出一圈箭头，
   * 「小拱替主拱分掉了一部分水压」就是这么看出来的。
   */
  drawPressure(sc, level, cam) {
    const head = Math.max(1.2, level - H.H_BED)
    // 箭头贴在相机这一侧的立面上，否则会被近侧的侧墙挡掉
    const zf = (cam && cam.eye[2] >= 0 ? 1 : -1) * (B.HW_SPRING + 0.25)
    const arc = (cx, cy, rIn, phi0, phi1, n) => {
      for (let i = 0; i <= n; i++) {
        const phi = phi0 + (phi1 - phi0) * (i / n)
        const sp = Math.sin(phi), cp = Math.cos(phi)
        const y = cy + rIn * cp
        if (y > level - 0.25) continue          // 露出水面的拱腹不吃水压
        const t = clamp((level - y) / head, 0, 1)
        const col = this.ramp(t)
        // 箭杆长、宽都按压强走。宽度单位是米，别给大了——
        // 给到两三米，一支两三米长的箭头就摊成了楔形块，
        // 一圈排开互相糊在一起，看着像一团乱线
        const len = 1.4 + 4.0 * t
        const x = cx + rIn * sp
        // 半径方向即拱腹外法线，箭头自洞内指向石体
        const ux = sp, uy = cp
        const tx = x - ux * len, ty = y - uy * len
        R.pushSegment(sc, tx, ty, zf, x, y, zf, 0.45 + 0.55 * t,
          col[0], col[1], col[2], 0.9)
        const hx = uy, hy = -ux                  // 垂直于箭杆
        R.pushTri(sc,
          [x + ux * 1.15, y + uy * 1.15, zf],
          [x + hx * 0.62, y + hy * 0.62, zf],
          [x - hx * 0.62, y - hy * 0.62, zf],
          col[0], col[1], col[2], 0.94)
      }
    }
    // 主拱：整条弧上都布，但只画到水面以下那一段
    arc(0, B.CY, B.R_IN, -B.HALF_TH, B.HALF_TH, 24)
    // 四个小拱
    for (let i = 0; i < B.SMALL.length; i++) {
      const s = B.SMALL[i]
      if (level <= s.spring + 0.2) continue
      for (let k = -1; k <= 1; k += 2) {
        arc(k * s.xc, s.cy, s.R, -s.th, s.th, 8)
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
        // 矢跨比：坦拱是赵州桥最"反常识"的一处，值得单独点出来
        this.tag(ctx, f1[0] + 40, (f0[1] + f1[1]) / 2 + 18,
          '矢跨比 1 : 5.12', '#fdf6ec', 'rgba(158,62,40,0.88)')
      }
      // 四个小拱：内 2.85 靠拱顶、外 3.81 靠桥台，各自标净跨
      if (this.data.open && t > B.T.small[0]) {
        for (let i = 0; i < B.SMALL.length; i++) {
          const s = B.SMALL[i]
          // 小拱内弧的拱顶标高处
          const top = s.spring + s.f
          const s0 = pr(s.xc, top, 5.0)
          if (!s0) continue
          this.tag(ctx, s0[0], s0[1] - 20,
            '小拱 净跨 ' + (2 * s.a).toFixed(2) + ' m',
            '#ffffff', 'rgba(32,44,58,0.82)')
        }
      }
      // 28 道拱券：贴着近端拱脚标一句
      if (t > B.T.arch[0] + B.RING_DUR) {
        const r0 = pr(-B.HALF_SPAN, 1.2, 5.0)
        if (r0) {
          this.tag(ctx, r0[0], r0[1] + 30, '28 道拱券并列', '#ffffff',
            'rgba(32,44,58,0.82)')
        }
      }
      // 坦拱对照：把半圆拱的矢高标出来，和真拱的 7.23 m 并排一看就明白
      if (this.data.flat) {
        const c0 = pr(0, B.HALF_SPAN, 6.0)
        if (c0) {
          this.tag(ctx, c0[0], c0[1] - 14,
            '同跨半圆拱 矢高 18.51 m', '#fdf6ec', 'rgba(158,62,40,0.88)')
        }
      }
    }

    // 拆解时给摊开的券加一句说明，并点出腰铁
    if (this._ex > 0.25) {
      const a0 = pr(0, B.RISE + 4.0, 0)
      if (a0) {
        this.tag(ctx, a0[0], a0[1] - 10,
          '28 道券，每道独立成拱', '#fdf6ec', 'rgba(158,62,40,0.88)')
        this.tag(ctx, a0[0], a0[1] + 12,
          '券间以腰铁相咬', '#ffffff', 'rgba(46,46,52,0.86)')
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
      // 内、外两对小拱的券脚不一样高（6.05 / 3.91 —— 各自落在主拱拱背上，
      // 拱背越靠拱顶越高），所以是分级过水的：水先漫过外侧那对，
      // 再涨 2 m 才够着内侧那对。这一条比百分比直观
      const flowing = []
      for (let i = 0; i < B.SMALL.length; i++) {
        if (o.h > B.SMALL[i].spring) {
          flowing.push((i === 0 ? '内' : '外') + ' 2 个')
        }
      }
      // 同一水位下，敞肩桥比实肩桥多出来的那一块过水断面，
      // 就是此刻四个小拱真正让出来的净面积——敞肩拱的贡献值直接量出来了
      const smallA = H.areaAt(o.h, H.TABLE_OPEN) - H.areaAt(o.h, H.TABLE_SOLID)
      const sp = {
        flowing: flowing.length ? flowing.join(' + ') : '尚无一孔过水',
        nowArea: smallA.toFixed(1)
      }
      if (sp.flowing !== this.data.sp.flowing ||
          sp.nowArea !== this.data.sp.nowArea) {
        const next = {}
        for (const k in this.data.sp) next[k] = this.data.sp[k]
        next.flowing = sp.flowing
        next.nowArea = sp.nowArea
        d.sp = next
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
      this.clampOrbit()   // 距离一变，允许的侧偏角也跟着变
      return
    }
    if (!this.pt || !ts.length) return
    const dx = ts[0].x - this.pt.x
    const dy = ts[0].y - this.pt.y
    this.cam.yaw = this.yaw0 - dx * 0.006
    this.cam.pitch = clamp(this.pitch0 + dy * 0.005, -0.45, 0.95)
    this.clampOrbit()
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
  onToggleAnno() { this.setData({ anno: !this.data.anno }) },

  /**
   * 数据出处面板。打开时把营造动画挂起，关掉再接着放。
   *
   * 挂起前的播放状态得单独记在 this 上：面板铺满大半个屏幕，动画在底下空转
   * 没意义；但也不能直接把 playing 置 false 就算完——关面板时再去读
   * this.data.playing 读到的已经是刚置下的那个 false，动画就再也起不来了。
   */
  onToggleSrc() {
    if (!this.data.srcOpen) {
      this._wasPlaying = this.data.playing
      this.setData({ srcOpen: true, playing: false })
    } else {
      this.setData({ srcOpen: false, playing: !!this._wasPlaying })
    }
  },

  onSrcTab(e) { this.setData({ srcTab: e.currentTarget.dataset.t }) },

  /** 坦拱对照：叠半圆拱虚影。叠上去就得是正视，斜着看不出一高一矮 */
  onToggleFlat() {
    const flat = !this.data.flat
    this.setData({ flat, anno: flat ? true : this.data.anno })
    if (flat) this.applyView('side')
  },

  /**
   * 并列砌券拆解。拆到一半再点就是装回去。
   *
   * 拆解的前提是桥已经砌完，所以顺手把进度拉到末了；机位也要挪到斜上方，
   * 28 道券是沿桥宽方向摊开的，正面看只能看见最前面那一道。
   */
  onToggleSplit() {
    const split = !this.data.split
    this.setData({ split, playing: false })
    if (split) {
      this.st.t = B.TOTAL
      this.anim = {
        t: 0,
        from: { yaw: this.cam.yaw, pitch: this.cam.pitch, zoom: this.cam.zoom,
                tx: this.cam.tx, ty: this.cam.ty, tz: this.cam.tz },
        //   机位要转到接近侧向（yaw ≈ 1.0，也就是 57°）：28 道券是沿桥宽
        //   方向摊开的，正面看它们几乎重合，摊开也只是一片密排的横线。
        //   转过来才看得出是一道道**各自独立**的拱券
        to: { yaw: 1.00, pitch: 0.12, zoom: 0.36, tx: 0, ty: 4.0, tz: 0 }
      }
    } else {
      this.applyView('full')
    }
  }
})
