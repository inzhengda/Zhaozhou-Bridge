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
    // "世界上最早的桥"这个说法不能给：郦道元《水经注》记的旅人桥（约公元 282 年）
    // 可能更早，只是没有存世。能站住的定语是"现存"——说课时被追问也不虚。
    desc: '净跨 ' + (2 * B.SMALL[1].a).toFixed(2) + ' m ×2、' +
      (2 * B.SMALL[0].a).toFixed(2) + ' m ×2 —— 现存最早的敞肩拱'
  },
  {
    t: B.T.deck[0], key: 'deck', name: '铺砌桥面',
    desc: '桥面随拱势微拱，连同引桥全长 ' + (2 * B.DECK_HALF).toFixed(1) + ' m'
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

/**
 * 反解流量：水位恰好涨到某标高时，Q 是多少。
 *
 * 分级过水的两个临界点不能写死成数字——水位是 hydro.js 按孔口出流算出来的，
 * 哪天改了系数或断面，写死的临界值就和画面上的水位对不上了。
 * 这里对 H.evaluate 做二分：水位随流量单调，三十几次就收敛到 1 m³/s 以内。
 */
function qAtLevel(level) {
  let lo = Q_MIN, hi = Q_MAX
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2
    if (H.evaluate(mid).open.h < level) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * 同一水位下，敞肩桥比实肩桥多出来的净过水断面——四个小拱此刻真正
 * 让出来的那一片。
 *
 * 「同一水位」这四个字是全部要点。敞肩桥过同样的流量，水位本来就涨得
 * 低些，若拿两条桥**各自**的水位去比，比的是两件不同的事，差数会小掉
 * 一多半（900 m³/s 下，同一水位是 17 m²，各自水位只剩 7 m²）。
 * HUD 的「敞肩之利」、过水断面图、敞肩对照图都走这一处，三处才对得上。
 */
function spandrelBonus(h) {
  return H.areaAt(h, H.TABLE_OPEN) - H.areaAt(h, H.TABLE_SOLID)
}

// 外侧那对券脚低、先漫过；内侧那对高，要再涨一截才够着。
//
// 判据取的是**起拱线**（spring），不是洞口最低点（sill）。洞口最低点太靠下
// ——外侧那对才 0.98 m，一档就落在 187 m³/s 上，三档会排成 37/670/443，
// 头一档细得写不下字。起拱线是"整孔开始泄水"的档位，拿它分档，尺子
// 三档匀称，说的也是真事；洞口见水那一刻交给卡片上的「初漫洞底」去讲。
//
// 取整到 1 m³/s：滑块本身就是整数，界线必须落在整数上，
// 否则提示里写 709、尺子却在 710 才翻档，对不上（差 0.4 m³/s，于水位是 3 mm）
const Q_OUTER = Math.round(qAtLevel(B.SMALL[1].spring))
const Q_INNER = Math.round(qAtLevel(B.SMALL[0].spring))

/**
 * 水量尺的三档。这是课文里那一句「发大水的时候，水还可以从四个小拱流出来」
 * 的可操作版本：滑块推到哪一段，哪几孔开始过水，学生自己推得出来。
 *
 * w 是各档的流量宽度，直接当 flex-grow 用——段与段的交界于是**正好**
 * 落在两个临界流量上，不用再去算百分比、也不用迁就滑块轨道的左右留白。
 */
const BANDS = [
  { label: '主拱过水', q: Math.round((Q_MIN + Q_OUTER) / 2), w: Q_OUTER - Q_MIN },
  { label: '外侧两孔', q: Math.round((Q_OUTER + Q_INNER) / 2), w: Q_INNER - Q_OUTER },
  { label: '内侧两孔', q: Math.round((Q_INNER + Q_MAX) / 2), w: Q_MAX - Q_INNER }
]
/**
 * 剖面卡片顶上那六个页签的说明。页签只有四个字，光看标签说不清
 * "这张图要我看什么"——一行说明补上，省得说课时还要另讲一句。
 * 键与 secTabs 里的 key 一一对应，漏了哪个会走 || 兜底，不会画成空白。
 */
const SEC_HINT = {
  long: '沿桥长剖开，宽度方向取桥中线',
  cross: '在拱顶把桥横着切开，看的是宽度方向',
  area: '同一个流量下，敞肩与实肩各能过多少水',
  rings: '28 道券怎么砌，又靠什么连成一体',
  span: '只差四个小拱，过水断面与自重差出多少',
  found: '五层条石直接坐在粗砂层上，未打桩'
}

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
    bands: BANDS,
    band: 1,              // 默认 900 m³/s 落在「外侧两孔」那一档
    qOuter: Q_OUTER,      // 外侧两孔的临界流量，尺子上的第一道界
    qInner: Q_INNER,      // 内侧两孔的临界流量
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
    thrust: false,        // 受力：把桥面荷载沿拱轴传到两岸桥台的路径画出来
    sec: false,           // 剖面图。开的时候 3D 上的标注一概让位
    // 剖面图里翻的是哪一张：'long' 纵剖面（沿桥长剖开）、'cross' 横剖面
    // （在拱顶横着切开）。默认仍是纵剖面，按钮文案和沿用习惯都不动
    secTab: 'long',
    // 尺寸数据的出处，静态不变量，见 utils/sources.js
    sources: SRC.GROUPS,
    annals: SRC.ANNALS,
    srcTabs: SRC.TABS,
    srcTab: SRC.TABS[0],
    srcOpen: false,
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
      topCmp: top + 180      // 敞肩对比卡（只在泄洪模式出现，压在读数卡之下）
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

    // ---- 水压箭头 ----
    // 两种箭头一次只画一种：开了「受力」就把水压箭头让出去。两套叠在
    // 一张画面上，学生分不清哪根是水推石头、哪根是桥自己往两边撑。
    // 水压箭头贴得太近会和水花糊满画面，拉近到 0.24 以内就不画了；
    // 受力那几支走 2D 层（见 drawForce），不受这个限制
    const tooClose = this.cam.zoom < 0.24
    if (flood && !this.data.thrust && !tooClose) this.drawPressure(sc, waterY, cam)

    R.flush(ctx, sc)

    // ---- 2D 覆盖层 ----
    // 剖面图铺开时，3D 上的标注和那道 28 券示意条一概收掉，画面上只留一张图
    if (this.data.sec) {
      this.drawSection(ctx)
    } else {
      if (this.data.anno) this.drawAnnotations(ctx, sc, t, flood, waterY, ev)
      if (flood && this.data.thrust) this.drawForce(ctx, sc)
      this.drawRingStrip(ctx)
    }
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

  /** 拆解时第 i 道券沿桥宽方向让开的距离。drawRings 与标注都要用，别各算一份 */
  ringDz(ex, i) {
    return (i - (B.RING_N - 1) / 2) * ex * SPLIT_STEP
  },

  /**
   * 拱轴上的一点：u = φ/HALF_TH（0 在拱顶、±1 在拱脚），r 是半径。
   * 返回坐标和**该处券的半宽**——券是收分的，拱脚 4.8 m、拱顶 4.5 m，
   * 所以券宽方向上的任何位置都得按所在角度折算，不能拿拱顶那个数一路使。
   * 与 mesh.archRingT 里 t = |φ|/hwRef 的插值口径保持一致。
   */
  archAt(u, r) {
    const phi = u * B.HALF_TH
    return {
      x: r * Math.sin(phi),
      y: B.CY + r * Math.cos(phi),
      hw: B.HW_CROWN + (B.HW_SPRING - B.HW_CROWN) * Math.abs(u)
    }
  },

  /**
   * 28 道并列拱券。
   *
   * ex 是拆解程度：每道券沿桥宽方向（z 轴）按序错开，28 道摊成一排，
   * 「整座桥其实是由 28 片独立的拱券并排拼起来的」一眼就看得见。
   * 摊开的同时把三种"横向联系"补上：券石之间的腰铁、横穿各券的铁拉杆、
   * 以及钩住最外那道券的勾石——28 片彼此不相连的券凭什么成为一个整体，
   * 全靠这三样。不摊开时缝宽为零、铁件又都埋在石缝里，一概不必画。
   */
  drawRings(sc, t, wo, ex) {
    const rings = this.bs.rings
    const N = rings.length
    // 摊开的步距。券本身只有 9/28 ≈ 0.32 m 宽：步距给大了（0.9 m 试过），
    // 28 道摊成一把稀稀拉拉的梳子，反倒看不出是一道道完整的券；
    // 0.5 m 让券宽与缝宽大致相当，摊开仍是一个"包"，缝隙又分明
    const dz = (i) => this.ringDz(ex, i)
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

    if (ex > 0.25 && t > B.T.arch[0] + B.RING_DUR) {
      this.drawWaistIron(sc, dz)
      this.drawTieBars(sc, dz)
      this.drawGouShi(sc, dz)
    }
  },

  /**
   * 腰铁：银锭形的小铁件，嵌在相邻两块**券石**的缝口里，把上下两块石头锁住。
   *
   * 它平躺在券面上，长轴顺着弧、短轴顺着券宽，所以画在 x-y 平面里、
   * 贴着拱背走：摊开时各道券各带各的那一串腰铁分开——腰铁管的是
   * 「**一道券自己**由许多块石头咬成一条石链」，这跟铁拉杆正好是两件事。
   *
   * 早先这里画的是沿券宽方向的一根根短杠，摊开以后成了 27 根横档，
   * 看着像是券与券之间被拉杆拉着——那是铁拉杆的活儿，画错位了。
   *
   * 尺寸比实物放大：真腰铁长约 20 cm，在这个比例下不到 1.5 px，照实画画不出来。
   * 资料页「腰铁」一条已注明本模型只画位置、不画真实尺寸。
   */
  drawWaistIron(sc, dz) {
    const N = B.RING_N
    // 一道券上沿弧排 7 处：拱顶一处，两侧各三处。再密就成了满屏的铁点，
    // 看不出是"一件一件"的铁活
    const US = [0, 0.25, -0.25, 0.5, -0.5, 0.75, -0.75]
    // 贴着拱背、略高一点。抬高这一档是给画家算法用的：腰铁与拱背只差
    // 几分米，深度排序容易翻，翻过来就被拱背整片盖掉
    const r = B.R_OUT + 0.12
    // 银锭的外形：两头宽、中间束腰，像一枚蝴蝶结。单位是米（已放大）
    const HL = 0.31, DE = 0.17, CI = 0.075, WL = 0.09
    const OUTLINE = [
      [-HL, -DE], [-HL, DE], [-WL, CI], [WL, CI],
      [HL, DE], [HL, -DE], [WL, -CI], [-WL, -CI]
    ]
    for (let i = 0; i < N; i++) {
      const zc = -1 + (2 * i + 1) / N      // 这道券在桥宽方向上的中心（按半宽归一）
      // 各道券沿弧错开一点。28 道若都用同一组 u，那 7 处会连成 7 条贯穿全桥
      // 的直线，摊开后又成了一排横档——正是要躲开的样子。错开之后才像是
      // 各道券各自券石缝里的铁活
      const off = (i % 5) * 0.045 - 0.09
      for (let k = 0; k < US.length; k++) {
        // 错位仍按左右对称来，免得整座桥看起来歪着
        const u = US[k] === 0 ? 0 : US[k] + (US[k] > 0 ? off : -off)
        const a = this.archAt(u, r)
        // 顺弧的切向与券宽方向都落在拱背的切平面里，腰铁就摊在这个平面上
        const phi = u * B.HALF_TH
        const tx = Math.cos(phi), ty = -Math.sin(phi)
        const z = dz(i) + zc * a.hw
        const pts = []
        for (let m = 0; m < 8; m++) {
          const s = OUTLINE[m][0], tt = OUTLINE[m][1]
          pts.push([a.x + tx * s, a.y + ty * s, z + tt])
        }
        R.pushPoly(sc, pts, [78, 74, 80], { k: 1, noCull: true })
      }
    }
  },

  /**
   * 铁拉杆（梁思成所称「铁梁」）：横穿 28 道券的拱背，全桥 9 根——
   * 大券 5 根、四个小拱各 1 根。摊开时只有它一路跨过所有缝隙，
   * 「28 片券凭什么连成一个整体」，这一眼看明白。四个小拱上那 4 根
   * 在拆解视图里画不出来：小拱本身就是拱肩的一部分，摊开时不在场。
   *
   * 两端露出券石面、做成圆帽。唐《赵州石桥铭》「九津九星横河中」的
   * 那个「九星」，当即指这 9 根铁拉杆露在外面的圆帽。
   */
  drawTieBars(sc, dz) {
    const N = B.RING_N
    // 大券上的 5 根。最外一对取 φ = 0.56·HALF_TH，那里拱背的横坐标约 11.5 m，
    // 正是内侧小拱的券脚——再往外，拱背上开着洞，铁拉杆没处放
    const US = [0, -0.28, 0.28, -0.56, 0.56]
    const r = B.R_OUT + 0.18
    // 分成小段画。一根杆二十几米长，只按两端算深度，它会"排在最近、
    // 压在整包券上面"；分到一两米一段，各段各按自己的深度排，才拦得住前头的券
    const SEG = 26
    for (let k = 0; k < US.length; k++) {
      const a = this.archAt(US[k], r)
      const z0 = dz(0) - a.hw
      const z1 = dz(N - 1) + a.hw
      for (let m = 0; m < SEG; m++) {
        const za = z0 + (z1 - z0) * m / SEG
        const zb = z0 + (z1 - z0) * (m + 1) / SEG
        R.pushSegment(sc, a.x, a.y, za, a.x, a.y, zb, 3.0, 76, 72, 80, 0.95)
      }
      this.tieCap(sc, a, z0 - 0.05)
      this.tieCap(sc, a, z1 + 0.05)
    }
  },

  /** 铁拉杆的圆帽：露在券石面外的那一小片圆铁。加大到这个尺寸才看得见 */
  tieCap(sc, a, z) {
    const RR = 0.30, n = 10
    const pts = []
    for (let i = 0; i < n; i++) {
      const th = i / n * Math.PI * 2
      pts.push([a.x + RR * Math.cos(th), a.y + RR * Math.sin(th), z])
    }
    R.pushPoly(sc, pts, [126, 118, 110], { k: 1, noCull: true })
  },

  /**
   * 勾石：护拱石两侧各 6 块，外端刻成曲尺形、向下钩住最外那道券，
   * 不叫它往外倒。梁思成 1933 年看到的正是这个，他同时说勾石与铁条
   * 「功效极有限」，真正管用的是桥身的收分——那句评语比勾石本身更值钱。
   *
   * 只画在最外两道券上，跟着它们一起摊开。石条本长 1.2 m，摊开的缝里
   * 塞不下，这里只画露出券面的钩头那一段；5 cm 的钩在这个比例下是 0.3 px，
   * 也照放大画。资料页「勾石」一条已注明本模型只画位置。
   */
  drawGouShi(sc, dz) {
    const N = B.RING_N
    // 沿弧 3 处、左右成对，共 6 块。位置落在拱肩那一段——护拱石上，
    // 正是文献里说的"护拱石的两侧"
    const US = [0.30, -0.30, 0.52, -0.52, 0.74, -0.74]
    const r = B.R_OUT + 0.14
    // 曲尺形：横臂顺券宽方向伸出去，外端折向下钩住券面。数字是米（已放大）
    const ARM = 0.90, TH = 0.26, DROP = 0.72, HOOK = 0.30
    for (let s = 0; s < 2; s++) {
      const i = s === 0 ? 0 : N - 1
      const out = s === 0 ? -1 : 1        // 朝桥外的方向
      for (let k = 0; k < US.length; k++) {
        const a = this.archAt(US[k], r)
        // 券朝外的那个面。再往外挪 7 cm，免得和券的端面叠在同一个平面上
        const zf = dz(i) + out * a.hw - out * 0.07
        const zi = zf - out * (HOOK + ARM)          // 横臂伸进石砌里的那一头
        const zb = zf - out * HOOK                  // 钩头的内侧
        const ys = a.y + TH / 2, yi = a.y - TH / 2  // 横臂的上下面
        const yb = ys - DROP                        // 钩尖
        // 整个曲尺躺在一个 x = 常数的平面里，用一整个多边形画出来，
        // 比几段线更像一块凿过的石头
        R.pushPoly(sc, [
          [a.x, yb, zf], [a.x, yb, zb], [a.x, yi, zb], [a.x, yi, zi],
          [a.x, ys, zi], [a.x, ys, zf]
        ], [104, 94, 82], { k: 1, noCull: true })
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

  /**
   * 拱的传力演示：桥面的重量是怎么走到两岸去的。
   *
   * 这是"没有桥墩为什么也不塌"的答案，分三层画，少一层就讲不通：
   *   一、桥面上的竖向荷载（朱红），沿桥长排开，压在拱背上；
   *   二、拱券把这份竖向压力转成**沿拱轴**的斜向压力（赭石），从拱顶一路递到拱脚；
   *   三、到了拱脚，力只剩向外的水平分量（朱红），由两岸桥台和台后填土顶住。
   * 看见第三层，学生才会明白拱桥不是"没有支座"，是把支座从河心挪到了两岸——
   * 拱脚外推的那两下，正是赵州桥为什么必须"两端牢牢扎在岸上"。
   *
   * 三组箭头的长短只表方向与先后，**不表力的比值**。真按比例画，
   * 拱脚那一支要长到画外去，而且本模型也没有算过桥体自重下的真实推力，
   * 不编这个数。画面里唯一给出的实数是最上面那行石方账，
   * 那是 bridge.js 按本题几何积出来的，有据可查。
   */
  drawThrust(ctx, pr) {
    // 力线贴在相机这一侧的立面上，避开近侧的桥身和栏板。
    // 这里的 z 只用来定投影位置，画出来的是 2D 线段——见 drawForce
    const zf = B.HW_SPRING + 0.25
    const red = 'rgba(192,57,43,0.95)'
    const ochre = 'rgba(162,112,44,0.95)'

    // 一、桥面荷载：沿桥长排开，压在拱背上
    for (let k = -4; k <= 4; k++) {
      const x = k * 5.4
      const y = B.deckTop(x)
      const a = pr(x, y + 4.6, zf), b = pr(x, y + 0.7, zf)
      if (a && b) this.arrow2(ctx, a, b, 2.4, red)
    }

    // 二、沿拱轴递压。取券厚的中线，切线朝拱脚，两半拱对称
    const rm = (B.R_IN + B.R_OUT) / 2
    for (let s = -1; s <= 1; s += 2) {
      for (let k = 0; k < 4; k++) {
        const phi = s * B.HALF_TH * (0.14 + 0.235 * k)
        const px = rm * Math.sin(phi)
        const py = B.CY + rm * Math.cos(phi)
        // 切向 dP/dφ = (cosφ, -sinφ)；左半拱 φ 为负，乘 s 后两支都朝拱脚
        const ux = s * Math.cos(phi)
        const uy = -s * Math.sin(phi)
        const L = 3.1
        const a = pr(px, py, zf), b = pr(px + ux * L, py + uy * L, zf)
        if (a && b) this.arrow2(ctx, a, b, 2.2, ochre)
      }
    }

    // 三、拱脚外推。尾巴钉在起拱点上，头收在离画幅边缘 14 px 处。
    // 长度不能写死：全景机位的视宽只有 46 m，起拱点（18.51 m）投影出来
    // 已经在屏幕的九成处，桥台外缘（23.5 m）本就在画外，
    // 写死 4 m 在 430 的机器上刚好出画，窄一点的机器就整支被切掉
    for (let s = -1; s <= 1; s += 2) {
      const a = pr(s * B.HALF_SPAN, -0.5, zf)
      if (!a) continue
      const bx = s > 0 ? this.cw - 14 : 14
      if (bx * s > a[0] * s) this.arrow2(ctx, a, [bx, a[1]], 2.8, red)
    }
  },

  /**
   * 一支带箭头的力线，两个端点是**屏幕坐标**。宽度单位是像素。
   *
   * 箭杆画到离尖端还有一小段就收住，剩下的交给三角头——
   * 杆一直画到尖上，细杆会从三角头的前角戳出来一个毛刺。
   */
  arrow2(ctx, a, b, w, color) {
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const L = Math.sqrt(dx * dx + dy * dy) || 1
    const ux = dx / L, uy = dy / L
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineCap = 'round'
    ctx.lineWidth = w
    ctx.beginPath()
    ctx.moveTo(a[0], a[1])
    ctx.lineTo(b[0] - ux * w * 3.2, b[1] - uy * w * 3.2)
    ctx.stroke()
    const hw = w * 2.4
    ctx.beginPath()
    ctx.moveTo(b[0], b[1])
    ctx.lineTo(b[0] - ux * w * 4.4 + uy * hw, b[1] - uy * w * 4.4 - ux * hw)
    ctx.lineTo(b[0] - ux * w * 4.4 - uy * hw, b[1] - uy * w * 4.4 + ux * hw)
    ctx.closePath()
    ctx.fill()
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

  /**
   * 受力那几支力线的落笔处。力线和文字都画在 2D 层。
   *
   * 为什么不走 renderer 的 3D 线段：这几支都在同一张立面上，投影出来的
   * 样子和 3D 线段没有分别，可泄洪时拱脚那一带整个泡在水面以下，
   * 走画家算法就会被半透明的水面染成一片发灰的紫红——"力"恰恰在最需要
   * 看清的地方糊掉了。2D 层压在水面之上，任何时候都是实的。
   */
  drawForce(ctx, sc) {
    const pr = (x, y, z) => R.project(sc, x, y, z)
    ctx.save()
    ctx.lineWidth = 1
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    this.drawThrust(ctx, pr)
    this.drawThrustLabels(ctx, pr)
    ctx.restore()
  },

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
      // 受力开着时尺寸标注一概让位——六支力线和四个尺寸挤在一张画面上，
      // 学生一样也记不住。力线本身由 drawForce 单独画，不受「标注」这个开关管
      if (this.data.thrust) { ctx.restore(); return }
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
          '净跨 ' + B.SPAN.toFixed(2) + ' m', '#fdf6ec', 'rgba(158,62,40,0.88)')
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
          '矢高 ' + B.RISE.toFixed(2) + ' m', '#fdf6ec', 'rgba(158,62,40,0.88)')
        // 矢跨比：坦拱是赵州桥最"反常识"的一处，值得单独点出来
        this.tag(ctx, f1[0] + 40, (f0[1] + f1[1]) / 2 + 18,
          '矢跨比 1 : ' + (B.SPAN / B.RISE).toFixed(2), '#fdf6ec', 'rgba(158,62,40,0.88)')
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
          this.tag(ctx, r0[0], r0[1] + 30, B.RING_N + ' 道拱券并列', '#ffffff',
            'rgba(32,44,58,0.82)')
        }
      }
      // 坦拱对照：把半圆拱的矢高标出来，和真拱的 7.23 m 并排一看就明白
      if (this.data.flat) {
        const c0 = pr(0, B.HALF_SPAN, 6.0)
        if (c0) {
          this.tag(ctx, c0[0], c0[1] - 14,
            '同跨半圆拱 矢高 ' + B.HALF_SPAN.toFixed(2) + ' m', '#fdf6ec', 'rgba(158,62,40,0.88)')
        }
      }
    }

    // 拆解时给摊开的券加说明。三样横向联系各点一句：腰铁咬的是**一道券
    // 自己**的券石，铁拉杆和勾石管的才是券与券之间——摊开来看才分得清
    if (this._ex > 0.25) {
      // 三句摞在拱顶上方。锚点抬到 RISE + 6.4：三枚牌子竖着要 44 px，
      // 抬低了最下面那枚就压在摊开的券上
      const a0 = pr(0, B.RISE + 6.4, 0)
      if (a0) {
        this.tag(ctx, a0[0], a0[1] - 10,
          B.RING_N + ' 道券，每道独立成拱', '#fdf6ec', 'rgba(158,62,40,0.88)')
        this.tag(ctx, a0[0], a0[1] + 12,
          '腰铁咬住本券的券石', '#ffffff', 'rgba(46,46,52,0.86)')
        this.tag(ctx, a0[0], a0[1] + 34,
          '铁拉杆横穿 28 券', '#e8e2d6', 'rgba(70,66,74,0.9)')
      }
      // 勾石的牌子。只横向跟到勾石投出来的位置，竖向**不**跟——挂到勾石
      // 头上就压在摊开的券上了，那一带全是竖条纹，牌子搁上去什么也读不出。
      // 取"三句说明下沿"和"勾石上方一档"里靠上的那个：拆解机位下前者在上，
      // 全景机位下后者在上，两种都躲得开桥
      const i = sc.ez >= 0 ? B.RING_N - 1 : 0
      const g = this.archAt(0.52, B.R_OUT + 0.14)
      const zp = this.ringDz(this._ex, i) + (i === 0 ? -1 : 1) * g.hw
      const g0 = pr(g.x, g.y, zp)
      if (a0 && g0) {
        const gx = clamp(g0[0], 96, this.cw - 96)
        const gy = Math.min(a0[1] + 70, g0[1] - 24)
        if (gy > 80) {
          this.tag(ctx, gx, gy, '勾石钩住最外一道券', '#fdf6ec', 'rgba(126,104,74,0.92)')
        }
      }
    }
    ctx.restore()
  },

  /**
   * 受力模式的三处标注。只讲"力从哪儿来、往哪儿去"，不复述尺寸。
   *
   * 最后那行石方账随敞肩/实肩切换换说法：这是整个演示里唯一一个
   * 有据可查的实数（bridge.js 按本题几何积出来的），箭头只表方向，
   * 数字才落实处。切一次实肩，学生看到的是同一座桥多背了 780 吨。
   */
  drawThrustLabels(ctx, pr) {
    const vol = B.SPANDREL.voidVol.toFixed(0)
    const ton = Math.round(B.SPANDREL.stone / 10) * 10

    const p0 = pr(0, B.deckTop(0) + 6.4, 5.0)
    if (p0) this.tag(ctx, p0[0], p0[1], '桥面荷载', '#fdf6ec', 'rgba(158,50,36,0.9)')

    // 压在拱洞里，但要躲开「水位 +x.xx m」那枚牌子（在全景机位下它就在
    // 水位线上方十几像素处），所以落到水位线**以下**一档
    const p1 = pr(0, B.RISE - 4.2, 5.0)
    if (p1) {
      this.tag(ctx, p1[0], p1[1], '重量沿拱轴递到拱脚',
        '#3a2c14', 'rgba(236,212,158,0.94)')
    }

    // 起拱点两侧各两枚，一上一下夹着那支外推的箭头。横向都定在
    // 起拱点正上方/正下方，投影出来在屏幕的 92% 处，牌宽 36 px 刚好不出画
    for (let s = -1; s <= 1; s += 2) {
      const a = pr(s * B.HALF_SPAN, 3.4, 5.0)
      if (a) this.tag(ctx, a[0], a[1], '桥台顶住', '#ffffff', 'rgba(32,44,58,0.86)')
      const b = pr(s * B.HALF_SPAN, -3.2, 5.0)
      if (b) this.tag(ctx, b[0], b[1], '拱脚外推', '#fdf6ec', 'rgba(158,50,36,0.9)')
    }

    // 石方账。这一行不能跟着世界坐标走：投影到高处会被右上那张
    // 「敞肩之利」卡盖住（那张卡是 WXML，层级在画布之上），
    // 索性钉在屏幕下缘往上 300 px 处——正好落在卡片之下、控制台之上
    this.tag(ctx, this.cw / 2, this.ch - 300, this.data.open
      ? '敞肩：四个洞省下 ' + vol + ' m³ 石方（约 ' + ton + ' 吨），两岸受压随之减轻'
      : '实肩：四个洞填实，桥身重 ' + ton + ' 吨，两岸多担这一份',
      '#fdf6ec', 'rgba(158,50,36,0.9)')
  },

  // ==================== 纵剖面 ====================

  /**
   * 纵剖面。沿桥长把桥剖开（不是横断面）。
   *
   * 这张图回答两个 3D 视角说不清的问题：
   *   一、四个小拱到底开在哪儿。它们横穿拱肩，从上往下看是洞、从侧面看是
   *       四个半圆，转到哪个角度总有一头被桥身挡着；剖面上一次全露出来。
   *   二、两岸为什么不沉。桥台只有 5 m 长的五层条石，下面直接坐在粗砂层上，
   *       没有桩。这一截总共 3.15 m 高，在全桥尺度上不到二十像素，
   *       不另放一张大样根本看不见——所以下面还有一张放大图。
   *
   * 几何全部取自 utils/bridge.js 里造 3D 模型用的那几个函数，不另立一套数字：
   * 剖面上量到的和 3D 里看到的是同一座桥。只有拱洞的顶不一样——3D 里侧墙从
   * "券背"起砌（省掉了券自己的厚度），剖面按真实石作画到"券脸"，这样才和
   * 泄洪时算过水断面用的那个洞一致。
   */
  drawSection(ctx) {
    const x0 = 14, x1 = this.cw - 14
    const y0 = this.data.topBtn + 34
    const y1 = this.ch - 316
    const PAPER = '#f8f3e8'
    const RED = '#b8452b'

    ctx.save()
    ctx.textBaseline = 'middle'

    // 卡片：淡影一层、本纸一层
    ctx.fillStyle = 'rgba(46,36,24,0.20)'
    this.roundRect(ctx, x0 + 2, y0 + 5, x1 - x0, y1 - y0, 14); ctx.fill()
    ctx.fillStyle = PAPER
    this.roundRect(ctx, x0, y0, x1 - x0, y1 - y0, 14); ctx.fill()

    // 六张图共用一个卡片，顶上一排页签来回换。
    // 页签画在 canvas 上、由 onTouchStart 分派点击，不另开 WXML 一层：
    // 卡片的高度是这里按机型量出来的（y0 跟着导航栏走、y1 让给下面的
    // 控件），WXML 那边再照抄一遍，迟早有一头对不上
    const tab = this.data.secTab
    const tabs = this.secTabs(x0, y0)
    this._secTabs = tabs
    ctx.textAlign = 'center'
    ctx.font = 'bold 12px sans-serif'
    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i]
      const on = t.key === tab
      this.roundRect(ctx, t.x, t.y, t.w, t.h, 6)
      if (on) {
        ctx.fillStyle = '#8e3b26'; ctx.fill()
      } else {
        ctx.fillStyle = 'rgba(158,132,96,0.14)'; ctx.fill()
        ctx.strokeStyle = 'rgba(158,132,96,0.42)'; ctx.lineWidth = 1
        this.roundRect(ctx, t.x + 0.5, t.y + 0.5, t.w - 1, t.h - 1, 6); ctx.stroke()
      }
      ctx.fillStyle = on ? PAPER : 'rgba(70,58,44,0.66)'
      ctx.fillText(t.label, t.x + t.w / 2, t.y + t.h / 2 + 0.5)
    }
    // 说明另起一行。原先它挂在最后一个页签右边，六个页签一铺满就没有
    // 那一块空档了；挪到下一行，六张图也就不用各留各的横向余量
    ctx.textAlign = 'left'
    ctx.font = '10px sans-serif'
    ctx.fillStyle = 'rgba(70,58,44,0.5)'
    ctx.fillText(SEC_HINT[tab] || SEC_HINT.long, x0 + 16, y0 + 45)

    // 卡片以内为界。地面那类多边形为了闭合要一直延伸到画幅之外，
    // 不裁就会糊到后面的 3D 场景上
    ctx.save()
    this.roundRect(ctx, x0, y0, x1 - x0, y1 - y0, 14)
    ctx.clip()
    ctx.strokeStyle = 'rgba(158,132,96,0.5)'
    ctx.lineWidth = 1
    this.roundRect(ctx, x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1, 14)
    ctx.stroke()

    // 六张图各画各的，都在这张卡片以内
    if (tab === 'cross') {
      this.secCross(ctx, x0, x1, y0, y1, PAPER, RED)
      ctx.restore(); ctx.restore(); return
    }
    if (tab === 'area') {
      this.secArea(ctx, x0, x1, y0, y1, PAPER, RED)
      ctx.restore(); ctx.restore(); return
    }
    if (tab === 'rings') {
      this.secRings(ctx, x0, x1, y0, y1, PAPER, RED)
      ctx.restore(); ctx.restore(); return
    }
    if (tab === 'span') {
      this.secSpan(ctx, x0, x1, y0, y1, PAPER, RED)
      ctx.restore(); ctx.restore(); return
    }
    if (tab === 'found') {
      this.secFound(ctx, x0, x1, y0, y1, PAPER, RED)
      ctx.restore(); ctx.restore(); return
    }

    // 版式。两块画幅按卡片实际高度分，不写死像素——小屏（812 高）上
    // 卡片只有三百出头，写死就把下面那张大样挤出卡片了。
    // 112 = 抬头 58（页签 22 + 说明一行 14 + 上下留白）+ 图注两行与标题 44
    //       + 底边留白 10，剩下的才是两张图。
    const avail = y1 - y0
    const rest = avail - 112
    const fH = rest * 0.44
    const iH = rest * 0.56

    // ---- 全桥 ----
    const fTop = y0 + 58
    const mpF = this.secMap(-27.6, 27.6, -3.9, 10.6, x0 + 18, x1 - 18, fTop, fTop + fH)
    this.secProfile(ctx, mpF, PAPER)
    this.secDimFull(ctx, mpF, RED, PAPER)

    // ---- 两行图注。数字写在这里而不是塞进图上：全桥那张横向只有
    //      6.6 px/m，小拱的洞不到 20 px 宽，洞里头放不下字 ----
    const capY = fTop + fH + 10
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillStyle = 'rgba(70,58,44,0.74)'
    ctx.fillText('拱肩小拱 ×4：每端两个，内孔净跨 ' + (2 * B.SMALL[0].a).toFixed(2) +
      ' m、外孔 ' + (2 * B.SMALL[1].a).toFixed(2) + ' m，两端对称', x0 + 20, capY)
    ctx.fillStyle = 'rgba(70,58,44,0.5)'
    // 券厚与圆心角都从模型现算。原先写死"1.03 m、圆心角 84°"，
    // 而 buildScene 按 37.02 / 7.23 反解出来的圆心角是 85°——图上画的
    // 和字上写的差一度，说课时正好被人拿量角器比着问。
    ctx.fillText('主拱 ' + B.RING_N + ' 道拱券并列砌筑，券厚 ' + (B.R_OUT - B.R_IN).toFixed(2) +
      ' m；矢跨比 1 : ' + (B.SPAN / B.RISE).toFixed(2) +
      '，圆心角 ' + (B.HALF_TH * 2 * 180 / Math.PI).toFixed(0) + '°', x0 + 20, capY + 15)

    // ---- 西端桥台大样 ----
    const iTop = capY + 34
    ctx.strokeStyle = 'rgba(158,132,96,0.3)'
    ctx.beginPath()
    ctx.moveTo(x0 + 18, iTop - 8); ctx.lineTo(x1 - 18, iTop - 8)
    ctx.stroke()
    ctx.font = 'bold 11px sans-serif'
    ctx.fillStyle = '#8e3b26'
    ctx.fillText('西端桥台与基础大样', x0 + 18, iTop + 5)
    ctx.font = '10px sans-serif'
    ctx.fillStyle = 'rgba(70,58,44,0.5)'
    ctx.fillText('五层条石直接坐在粗砂层上，未打桩', x0 + 140, iTop + 5)

    // 左边的七十像素留给纵向尺寸的字
    const mpI = this.secMap(-26.5, -B.HALF_SPAN, -4.0, 2.2, x0 + 74, x1 - 18, iTop + 14, iTop + iH)
    this.secProfile(ctx, mpI, PAPER)
    this.secDimInset(ctx, mpI, RED, PAPER)

    ctx.restore()
    ctx.restore()
  },

  /**
   * 剖面卡片顶上那六个页签的位置。画的和点的都用这一份，
   * 不各算一遍——各算一遍就是迟早有一头改漏。
   *
   * 标签一律四字：字数一样宽，六个页签才排成一条齐整的带子。
   * 宽度按最小机型倒推——卡片内宽 402 − 左右各 16 的留白 = 370，
   * 六个页签加五道缝正好 6×56 + 5×6 = 366，塞得下，不用换行。
   */
  secTabs(x0, y0) {
    const w = 56, h = 22, gap = 6
    const list = [
      ['long', '纵剖面图'], ['cross', '横剖面图'], ['area', '过水断面'],
      ['rings', '拱券分解'], ['span', '敞肩对照'], ['found', '桥台基础']
    ]
    const out = []
    for (let i = 0; i < list.length; i++) {
      out.push({
        key: list[i][0], label: list[i][1],
        x: x0 + 16 + i * (w + gap), y: y0 + 11, w: w, h: h
      })
    }
    return out
  },

  /**
   * 手指落的那一下是不是在页签上。在页签上就换图，并且把这一下吃掉——
   * 一个手指按在卡片顶上，本意是点按钮，若还照旧去转身后那座 3D 桥，
   * 就是没接住这一下。
   */
  hitSecTab(t) {
    const tabs = this._secTabs
    if (!tabs) return false
    for (let i = 0; i < tabs.length; i++) {
      const b = tabs[i]
      if (t.x >= b.x && t.x <= b.x + b.w && t.y >= b.y && t.y <= b.y + b.h) {
        if (b.key !== this.data.secTab) this.setData({ secTab: b.key })
        return true
      }
    }
    return false
  },

  /**
   * 拱顶横剖面。在拱顶把桥横着切开，看的是**宽度**方向。
   *
   * 这张图专答纵剖面答不了的那一问：28 道券到底在哪儿。
   * 纵剖面的切面正落在第 13、14 道券之间的券缝上（券 13 占 y −0.32..0，
   * 券 14 占 0..0.32），28 道在纵剖面里一道压一道、全叠成了同一条线，
   * 数不出数来。横着切才一道一道地摊开——这是这张图唯一的理由，
   * 所以券缝是它的正题，画得比别处重。
   *
   * 下半截那两条是「收分」：同一条拱，拱顶全宽 9.00 m、拱脚 9.60 m，
   * 每道券自 0.32 m 涨到 0.34 m。两条按上半截那张剖面的**同一个**绘图比
   * 画，量出来的那 0.30 m 才是真的；另配一个比例，画着好看而已。
   *
   * 尺寸一律取自 utils/bridge.js：与 3D 那座桥、与纵剖面是同一份数。
   */
  secCross(ctx, x0, x1, y0, y1, paper, RED) {
    const INK = 'rgba(64,54,42,0.6)'

    const HW = B.HW_CROWN                 // 拱顶半宽 4.5 m
    const DECK_HW = HW + 0.25             // 桥面比拱券略宽，挑出一点檐
    const RAIL_HW = DECK_HW - 0.16        // 栏板中线 4.59 m
    const zIn = B.archIntrados(0)         // 拱顶内弧
    const zOut = B.archExtrados(0)        // 拱顶外弧
    const zHau = B.haunchTop(0)           // 拱背，护拱石压在上面
    const zDeckB = B.deckBottom(0)
    const zDeckT = B.deckTop(0)
    const zRailT = zDeckT - 0.06 + 0.58   // 栏板顶。拱顶这一刀正落在
                                          // 一块栏板当中，切不到望柱
    const zTie = B.CY + B.R_OUT + 0.18    // 铁拉杆，压在拱背之上
    const cw = (2 * HW) / B.RING_N        // 拱顶每道券宽

    const avail = y1 - y0
    const zBot = zIn - 0.62, zTop = zRailT + 0.38
    // 左边留出 66 px 给竖着写的尺寸字，与纵剖面那张桥台大样同一个做法
    const rx0 = x0 + 66, rx1 = x1 - 16
    const sNat = (rx1 - rx0) / (2 * 5.45)
    // 横着的桥画在横着的卡片上，横向先到顶、竖向用不完：这张图的高就按
    // 横向定下来的那个比例给自己，多出来的全归下面两条。不写死像素——
    // 小屏（812 高）上卡片只有三百出头，写死就把下半截挤出卡片了
    const aH = Math.min(sNat * (zTop - zBot) + 8, (avail - 150) * 0.6)
    const aTop = y0 + 44
    const mp = this.secMap(-5.45, 5.45, zBot, zTop, rx0, rx1, aTop, aTop + aH)
    const P = mp.p
    const cx = (rx0 + rx1) / 2

    const rect = (xa, xb, za, zb, fill, stroke) => {
      const a = P(xa, za), b = P(xb, zb)
      ctx.beginPath()
      ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]),
        Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))
      ctx.fillStyle = fill; ctx.fill()
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke() }
    }
    const band = (hw, za, zb, fill, stroke) => rect(-hw, hw, za, zb, fill, stroke)

    // 画的次序就是砌的次序，与纵剖面那份 secProfile 一致：券、护拱石、
    // 侧墙、桥面，最后栏板。颜色同一个来源，两张剖面才对得上
    band(HW, zIn, zOut, '#9aa4aa', 'rgba(50,60,68,0.75)')           // 主拱券
    band(HW, zOut, zHau, '#bcb19d', INK)                             // 护拱石
    band(HW, zHau, zDeckB, '#c3bcac', INK)                           // 拱肩侧墙
    band(DECK_HW, zDeckB, zDeckT, '#cfc9bb', 'rgba(64,54,42,0.75)')  // 桥面
    for (let sg = -1; sg <= 1; sg += 2) {                            // 栏板
      rect(sg * RAIL_HW - 0.12, sg * RAIL_HW + 0.12, zDeckT - 0.06, zRailT,
        'rgba(196,188,174,0.9)', 'rgba(64,54,42,0.5)')
    }

    // 27 道券缝。这一层是这张图的正题
    ctx.strokeStyle = 'rgba(50,60,68,0.55)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let i = 1; i < B.RING_N; i++) {
      const a = P(-HW + i * cw, zIn), b = P(-HW + i * cw, zOut)
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1])
    }
    ctx.stroke()

    // 铁拉杆。它横穿 28 道券，而这一刀切在拱顶，杆恰好躺在切面里——
    // 于是它被顺着剖开，是一根长长的杆，不是断面上的一个圆点。
    // 早先这里画的是个圆点，那是把"横穿"当成了"垂直穿过纸面"，反了。
    // 真件直径约 0.10 m，在这个比例下三像素，按小程序一贯的做法放大画
    // （见 drawTieBars），图上只表位置
    const tieA = P(-HW - 0.34, zTie), tieB = P(HW + 0.34, zTie)
    ctx.fillStyle = '#4c4845'
    ctx.fillRect(tieA[0], tieA[1] - 2.6, tieB[0] - tieA[0], 5.2)
    for (let k = 0; k < 2; k++) {
      const tie = k ? tieB : tieA
      ctx.beginPath()
      ctx.arc(tie[0], tie[1], 2.6, 0, Math.PI * 2)
      ctx.fillStyle = '#4c4845'; ctx.fill()
      ctx.strokeStyle = paper; ctx.lineWidth = 1.2; ctx.stroke()
    }

    // 尺寸两道：券厚竖着量，字落在左边那片留白里；桥宽横着量在拱券之下
    ctx.font = '10px sans-serif'
    ctx.textBaseline = 'middle'
    this.secDim(ctx, mp, -5.0, zIn, -5.0, zOut,
      '券厚 ' + (zOut - zIn).toFixed(2) + ' m', RED, paper, -5.35, (zIn + zOut) / 2)
    this.secDim(ctx, mp, -HW, zBot + 0.28, HW, zBot + 0.28,
      '桥宽 ' + (2 * HW).toFixed(2) + ' m', RED, paper)

    // ---- 上半的图注。数字写在这里而不是塞进图上：这张图横向不到
    //      三十 px/m，券厚那一段只有三十像素高，洞里头放不下字 ----
    ctx.textAlign = 'left'
    ctx.font = '10px sans-serif'
    const capY = aTop + aH + 14
    ctx.fillStyle = 'rgba(70,58,44,0.74)'
    ctx.fillText('拱券 ' + B.RING_N + ' 道并列砌筑，各道独立砌成，不是一整块石头雕的', x0 + 20, capY)
    ctx.fillStyle = 'rgba(70,58,44,0.5)'
    ctx.fillText('券背上压一层护拱石，把 ' + B.RING_N + ' 道券连成一条；拱顶每道券宽 ' +
      cw.toFixed(2) + ' m', x0 + 20, capY + 15)
    // 拉杆这一句原先写的是"中间那个圆点是……"，画改成横杆之后没跟着改，
    // 图上画着杆、注里说圆点。它横穿 28 道券，这一刀切在拱顶，杆就躺在
    // 切面里被顺着剖开，是个长条；两头那两点是露在券外的圆帽。
    ctx.fillText('横穿 ' + B.RING_N + ' 道券的铁拉杆正在切面里，故画作长条；' +
      '两端圆帽露出券外', x0 + 20, capY + 30)

    // ---- 下半：收分 ----
    const dy = capY + 48
    ctx.strokeStyle = 'rgba(158,132,96,0.3)'
    ctx.beginPath()
    ctx.moveTo(x0 + 18, dy); ctx.lineTo(x1 - 18, dy)
    ctx.stroke()
    ctx.font = 'bold 11px sans-serif'
    ctx.fillStyle = '#8e3b26'
    ctx.fillText('收分：同一条拱在拱脚与拱顶的宽度，两截按同一比例画', x0 + 18, dy + 14)

    const barH = clamp(sNat * 1.1, 12, 34)
    const bandTop = dy + 28
    const bandBot = y1 - 8 - 29           // 底下还留两行图注
    const gap = clamp(bandBot - bandTop - 2 * barH, 16, 60)
    const blockH = 2 * barH + gap
    const bTop = bandTop + Math.max(0, (bandBot - bandTop - blockH) / 2)

    const bars = [
      { hw: HW, label: '拱顶 ' + (2 * HW).toFixed(2) + ' m' },
      { hw: B.HW_SPRING, label: '拱脚 ' + (2 * B.HW_SPRING).toFixed(2) + ' m' }
    ]
    ctx.font = '10px sans-serif'
    ctx.textBaseline = 'middle'
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i]
      const y = bTop + i * (barH + gap)
      const xa = cx - b.hw * mp.s, xb = cx + b.hw * mp.s
      ctx.fillStyle = '#9aa4aa'
      ctx.fillRect(xa, y, xb - xa, barH)
      ctx.strokeStyle = 'rgba(50,60,68,0.75)'
      ctx.lineWidth = 1
      ctx.strokeRect(xa + 0.5, y + 0.5, xb - xa - 1, barH - 1)
      // 28 道。条子横着不到三百像素，缝得真画出来，数才对得上
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'
      ctx.beginPath()
      for (let k = 1; k < B.RING_N; k++) {
        const x = xa + (xb - xa) * k / B.RING_N
        ctx.moveTo(x, y + 1.5); ctx.lineTo(x, y + barH - 1.5)
      }
      ctx.stroke()
      // 字压在一块清干净的底上，否则那道道的白缝从字上穿过去
      const lw = ctx.measureText(b.label).width
      ctx.fillStyle = '#9aa4aa'
      ctx.fillRect(xa + 6, y + 1, lw + 4, barH - 2)
      ctx.fillStyle = 'rgba(255,255,255,0.95)'
      ctx.fillText(b.label, xa + 8, y + barH / 2 + 0.5)
    }

    // 两道宽度之差。两根条子都居中，右边那一小段就是差值本身——
    // 0.30 m 在这个比例下只有九个像素，字挤不进两根端头之间，落到图注里写
    const y1c = bTop + barH / 2
    const y2c = bTop + barH + gap + barH / 2
    const e1 = cx + HW * mp.s
    const e2 = cx + B.HW_SPRING * mp.s + 6
    ctx.strokeStyle = RED
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(e1, y1c); ctx.lineTo(e2, y1c)
    ctx.moveTo(e1, y2c); ctx.lineTo(e2, y2c)
    ctx.moveTo(e2, y1c); ctx.lineTo(e2, y2c)
    ctx.moveTo(e1, y1c - 3); ctx.lineTo(e1, y1c + 3)
    ctx.moveTo(e2, y1c - 3); ctx.lineTo(e2, y1c + 3)
    ctx.moveTo(e2, y2c - 3); ctx.lineTo(e2, y2c + 3)
    ctx.stroke()

    const cap2Y = bTop + blockH + 14
    ctx.font = '10px sans-serif'
    ctx.fillStyle = 'rgba(70,58,44,0.74)'
    ctx.fillText('拱脚比拱顶每侧宽 ' + (B.HW_SPRING - HW).toFixed(2) + ' m（全宽 ' +
      (2 * B.HW_SPRING).toFixed(2) + ' m 对 ' + (2 * HW).toFixed(2) + ' m）', x0 + 20, cap2Y)
    ctx.fillStyle = 'rgba(70,58,44,0.5)'
    ctx.fillText('各道券自两端向中部逐层收窄、彼此挤紧——此即「收分」，也叫蜂腰', x0 + 20, cap2Y + 15)
  },

  /**
   * 卡片底下的图注。头一行深、后面浅——说课时眼睛先落在第一行，
   * 后面几行是补充说明。原先每张图各写各的 fillStyle 与 y+15，
   * 六张图就是六份，收成一处。
   */
  secNotes(ctx, x, y, notes) {
    ctx.textAlign = 'left'
    ctx.font = '10px sans-serif'
    for (let i = 0; i < notes.length; i++) {
      ctx.fillStyle = i === 0 ? 'rgba(70,58,44,0.74)' : 'rgba(70,58,44,0.5)'
      ctx.fillText(notes[i], x, y + i * 15)
    }
  },

  /**
   * 过水断面图。水位当横轴，桥下净过水面积当纵轴，一张图上两条线：
   * 敞肩（真桥，四个小拱凿穿）与实肩（假想的同形实肩桥，拱肩砌实）。
   *
   * 两条线之间那一块，就是四个小拱真正让出来的断面。它不是估的——
   * 两条线都由 hydro.js 的 areaAt 按桥的几何积出来，与泄洪动画里
   * 水面爬升读的是同一张表。说课时推一推滑块，游标跟着走，
   * 「敞肩之利」就从一句话变成图上一块量得出来的面积。
   *
   * 两条临界线标在**洞口的最低点**（SMALL[].sill）上，红线正是在那里
   * 离开土黄线的——越过哪一道，哪一对小拱开始过水。
   *
   * 别把它和滑块上那三档的分界混作一处：滑块的分界画在**起拱线**
   * （SMALL[].spring）上，那是一对小拱整孔开始泄水的档位，比起洞口
   * 见水晚得多（外侧那对：起拱线 3.91 m 对洞底 0.98 m）。两个数都真，
   * 指的是两件事，图上标的是前者、尺上标的是后者。
   */
  secArea(ctx, x0, x1, y0, y1, paper, red) {
    const l = x0 + 58, r = x1 - 24
    const t = y0 + 74, b = y1 - 96
    const H0 = H.H_BED, H1 = B.DECK_CROWN
    const AMAX = H.areaAt(H1, H.TABLE_OPEN)
    const px = function (h) { return l + (h - H0) / (H1 - H0) * (r - l) }
    const py = function (a) { return b - (a / AMAX) * (b - t) }

    // ---- 格网。水位每 2 m 一道；面积按量级挑一个整数档 ----
    ctx.font = '9px sans-serif'
    for (let h = 0; h <= H1; h += 2) {
      const X = px(h)
      ctx.strokeStyle = 'rgba(158,132,96,0.18)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(X, t); ctx.lineTo(X, b); ctx.stroke()
      ctx.textAlign = 'center'
      ctx.fillStyle = 'rgba(70,58,44,0.5)'
      ctx.fillText(String(h), X, b + 14)
    }
    const aStep = AMAX > 400 ? 200 : (AMAX > 180 ? 100 : 50)
    ctx.textAlign = 'right'
    for (let a = aStep; a < AMAX; a += aStep) {
      const Y = py(a)
      ctx.strokeStyle = 'rgba(158,132,96,0.14)'
      ctx.beginPath(); ctx.moveTo(l, Y); ctx.lineTo(r, Y); ctx.stroke()
      ctx.fillStyle = 'rgba(70,58,44,0.45)'
      ctx.fillText(String(a), l - 7, Y)
    }

    // ---- 两条曲线 ----
    const N = 90
    const curve = function (table) {
      const pts = []
      for (let i = 0; i <= N; i++) {
        const h = H0 + (H1 - H0) * (i / N)
        pts.push([px(h), py(H.areaAt(h, table))])
      }
      return pts
    }
    const pOpen = curve(H.TABLE_OPEN)
    const pSolid = curve(H.TABLE_SOLID)
    const between = function (up, dn, fill) {
      ctx.beginPath()
      ctx.moveTo(up[0][0], up[0][1])
      for (let i = 1; i < up.length; i++) ctx.lineTo(up[i][0], up[i][1])
      for (let i = dn.length - 1; i >= 0; i--) ctx.lineTo(dn[i][0], dn[i][1])
      ctx.closePath()
      ctx.fillStyle = fill
      ctx.fill()
    }
    // 先填实肩也有的那一块，再把两条线之间盖上去：
    // 土黄＝实肩也有，朱红＝只有敞肩才有。两块一叠，差别就是颜色之差
    between(pSolid, [[px(H0), b], [px(H1), b]], '#d6cbb2')
    between(pOpen, pSolid, 'rgba(184,69,43,0.20)')

    const line = function (pts, color, w) {
      ctx.beginPath()
      for (let i = 0; i < pts.length; i++) {
        if (i === 0) ctx.moveTo(pts[i][0], pts[i][1]); else ctx.lineTo(pts[i][0], pts[i][1])
      }
      ctx.strokeStyle = color
      ctx.lineWidth = w
      ctx.stroke()
    }
    line(pSolid, 'rgba(122,108,84,0.85)', 1.3)
    line(pOpen, red, 1.8)

    // ---- 轴。河床那一档不在整米格上，单独勒一道并标出来 ----
    ctx.strokeStyle = 'rgba(120,100,70,0.55)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(l, t); ctx.lineTo(l, b); ctx.lineTo(r, b)
    ctx.moveTo(px(H0), t); ctx.lineTo(px(H0), b)
    ctx.stroke()
    ctx.textAlign = 'left'
    ctx.font = '9px sans-serif'
    ctx.fillStyle = 'rgba(70,58,44,0.5)'
    ctx.fillText('河床', px(H0) + 4, b + 14)
    ctx.fillStyle = 'rgba(70,58,44,0.55)'
    ctx.fillText('桥下净过水面积 m²', x0 + 16, t - 10)

    // ---- 两条临界线：水位越过它，那一对小拱才开始过水 ----
    // 取洞底最低点（sill）而不是起拱线（spring）：红线正是从这里离开
    // 土黄那条曲线的，拐点就在线上。若画在起拱线上，线会比拐点靠右
    // 两米多，看着像是"过了线才慢慢开始"，其实早就分岔了。
    ctx.strokeStyle = 'rgba(96,138,160,0.9)'
    ctx.lineWidth = 1.2
    ctx.beginPath()
    for (let k = 0; k < B.SMALL.length; k++) {
      const X = px(B.SMALL[k].sill)
      if (X <= l + 2 || X >= r - 2) continue
      for (let yy = t; yy < b; yy += 7) {
        ctx.moveTo(X, yy); ctx.lineTo(X, Math.min(b, yy + 4))
      }
    }
    ctx.stroke()

    // ---- 此刻的水位。滑块一推，这道游标跟着走 ----
    const ev = H.evaluate(this.data.q)
    const hNow = ev.open.h
    if (hNow > H0) {
      const X = px(hNow)
      const aOpen = H.areaAt(hNow, H.TABLE_OPEN)
      const aSolid = H.areaAt(hNow, H.TABLE_SOLID)
      const dBonus = spandrelBonus(hNow)
      ctx.strokeStyle = 'rgba(184,69,43,0.7)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(X, py(aOpen)); ctx.lineTo(X, b); ctx.stroke()
      ctx.fillStyle = red
      ctx.beginPath(); ctx.arc(X, py(aOpen), 3, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#7a6c54'
      ctx.beginPath(); ctx.arc(X, py(aSolid), 2.4, 0, Math.PI * 2); ctx.fill()

      // 读数压在左上角：曲线自左下爬向右上，那一块始终空着
      const lines = [
        '水位 ' + hNow.toFixed(2) + ' m',
        '敞肩 ' + aOpen.toFixed(0) + ' m²',
        '实肩 ' + aSolid.toFixed(0) + ' m²',
        '多让 ' + dBonus.toFixed(0) + ' m²'
      ]
      const bw = 98, bh = lines.length * 12 + 8
      ctx.fillStyle = 'rgba(248,243,232,0.92)'
      this.roundRect(ctx, l + 6, t + 6, bw, bh, 4); ctx.fill()
      ctx.strokeStyle = 'rgba(158,132,96,0.4)'
      this.roundRect(ctx, l + 6.5, t + 6.5, bw - 1, bh - 1, 4); ctx.stroke()
      ctx.textAlign = 'left'
      for (let i = 0; i < lines.length; i++) {
        ctx.fillStyle = i === 1 ? red : 'rgba(70,58,44,0.78)'
        ctx.fillText(lines[i], l + 14, t + 14 + i * 12)
      }
    }

    // ---- 图例。压在右下角——曲线在那里已经爬到右上，这块空着 ----
    const lg = [[red, '敞肩（真桥）'], ['rgba(122,108,84,0.9)', '实肩（假想）']]
    const lw = 106, lh = 30
    const lx = r - lw - 6, ly = b - lh - 8
    ctx.fillStyle = 'rgba(248,243,232,0.92)'
    this.roundRect(ctx, lx, ly, lw, lh, 4); ctx.fill()
    ctx.font = '9px sans-serif'
    ctx.textAlign = 'left'
    for (let i = 0; i < lg.length; i++) {
      const yy = ly + 9 + i * 13
      ctx.strokeStyle = lg[i][0]; ctx.lineWidth = 1.8
      ctx.beginPath(); ctx.moveTo(lx + 7, yy); ctx.lineTo(lx + 22, yy); ctx.stroke()
      ctx.fillStyle = 'rgba(70,58,44,0.74)'
      ctx.fillText(lg[i][1], lx + 27, yy)
    }

    this.secNotes(ctx, x0 + 16, b + 34, [
      '朱红＝敞肩比实肩多让出来的水：四个小拱凿穿的净断面，沿桥长积分',
      '土黄＝同形实肩桥也能过的断面。两块之差就是「敞肩之利」的量',
      '横轴水位 m（河床 −1.00 m 起算），纵轴桥下净过水面积 m²',
      // 说法得跟着线走：线画在洞底最低点，就不该说成起拱线。
      // 洞口底边是斜的主拱外弧，最低点比起拱线低两三米
      '两道蓝虚线是内外两对小拱洞口的最低点，水位越过它，那一对开始过水'
    ])
  },

  /**
   * 拱券分解图。两件事常被混成一件，这张图把它们分开：
   *   上——「一道券自己」由许多块券石沿弧砌成一条石链，缝口里嵌银锭形
   *       的腰铁，把相邻两块锁住。腰铁管的是**本券之内**。
   *   下——「28 道券」凭什么成为一个整体：护拱石压顶、铁拉杆横穿。
   *       这两样管的是**券与券之间**。第三样横向联系是勾石，它在拱肩
   *       那一段而不在拱顶，这一刀切不到，只写进图注。
   *
   * 上图是拱顶那一段券身的立面，石缝按 0.35 m 一块照实排；
   * 下图在拱顶把桥横着切开，28 道券按真宽一道不省略。
   */
  secRings(ctx, x0, x1, y0, y1, paper, red) {
    const INK = 'rgba(50,60,68,0.75)'
    // 拱上任意一点：角 φ 处的半径与切向。φ 以拱顶为 0，朝 +x 为正
    const at = function (phi, r) {
      return [r * Math.sin(phi), B.CY + r * Math.cos(phi)]
    }

    // ---------------- 上半：拱顶一段券身的立面 ----------------
    // 横向取 ±5.5 m：刚好容下拱顶那道腰铁，以及两侧各约 5 m 处的
    // 另两道——3D 里 7 处腰铁就排在这个间距上，两张图的铁活对得上
    const aTop = y0 + 76
    const aBot = y0 + (y1 - y0) * 0.38
    const mpA = this.secMap(-5.5, 5.5, 6.60, 8.44, x0 + 26, x1 - 26, aTop, aBot)
    // 注意 mp.p 收的是两个数 (x, y)，不是一个点数组——at() 返回的得拆开传，
    // 否则 y 是 undefined，整批石缝和腰铁都投到 NaN 上，画出来什么都没有
    const PA = function (phi, r) {
      const q = at(phi, r)
      return mpA.p(q[0], q[1])
    }

    // 券身。两头竖直切断——这是"取了一段来看"，不是券到此为止
    this.bandBetween(ctx, mpA, {
      x0: -5.52, x1: 5.52, n: 48,
      fwd: B.archIntrados, back: B.archExtrados,
      fill: '#9aa4aa', stroke: INK
    })

    // 券石缝。沿弧每 0.35 m 一道，方向是径向——券石正是这么一块块砌上去的
    const STONE = 0.35
    const dphi = STONE / B.R_IN
    const nJ = Math.floor(Math.asin(5.52 / B.R_IN) / dphi)
    ctx.strokeStyle = 'rgba(44,54,62,0.62)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let i = -nJ; i <= nJ; i++) {
      const phi = i * dphi
      const p0 = PA(phi, B.R_IN), p1 = PA(phi, B.R_OUT)
      ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1])
    }
    ctx.stroke()

    // 腰铁。银锭形，长轴顺弧、骑在券石缝上。位置取 3D 里那 7 处
    // （u = 0, ±0.25…）中最靠拱顶的三个，两张图的铁活落在同一处。
    // 真腰铁长约 0.20 m，这里按 0.44 m 画——照实画不到三像素，看不出
    // 是个什么物件。资料页「腰铁」一条已注明本模型只画位置
    const IRON = [
      [-0.22, -0.080], [-0.22, 0.080], [-0.062, 0.035], [0.062, 0.035],
      [0.22, 0.080], [0.22, -0.080], [0.062, -0.035], [-0.062, -0.035]
    ]
    const U = [0, 0.25, -0.25]
    for (let k = 0; k < U.length; k++) {
      // 挪到最近的那道石缝上——腰铁是骑缝的，不落在石头当中
      const ph = Math.round(U[k] * B.HALF_TH / dphi) * dphi
      const ux = Math.sin(ph), uy = Math.cos(ph)
      const tx = Math.cos(ph), ty = -Math.sin(ph)
      // 嵌在券背以里 0.22 m 处，不是浮在面上——图上读作"埋进石头里的铁"
      const c = at(ph, B.R_OUT - 0.22)
      ctx.beginPath()
      for (let m = 0; m < IRON.length; m++) {
        const q = mpA.p(c[0] + tx * IRON[m][0] + ux * IRON[m][1],
          c[1] + ty * IRON[m][0] + uy * IRON[m][1])
        if (m === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1])
      }
      ctx.closePath()
      ctx.fillStyle = '#4c4845'
      ctx.fill()
      ctx.strokeStyle = 'rgba(248,243,232,0.75)'
      ctx.lineWidth = 1
      ctx.stroke()
    }

    this.secNotes(ctx, x0 + 16, aBot + 16, [
      '一道券：0.35 m 一块券石沿弧砌到拱脚，缝口里嵌银锭形腰铁',
      '腰铁骑在两块券石之间，沿弧约 5 m 一处——它管的是这一道券自己的石链'
    ])

    // ---------------- 下半：拱顶横切，28 道券按真宽并列 ----------------
    const bTop = aBot + 44
    const bBot = y1 - 78
    const HW = B.HW_CROWN
    const zIn = B.archIntrados(0), zOut = B.archExtrados(0)
    const zHau = B.haunchTop(0)
    const cw = 2 * HW / B.RING_N
    const mpB = this.secMap(-HW - 0.55, HW + 0.55, zIn - 1.0, zHau + 0.66,
      x0 + 40, x1 - 40, bTop, bBot)
    const PB = mpB.p
    const rect = function (xa, xb, za, zb, fill, stroke) {
      const p0 = PB(xa, za), p1 = PB(xb, zb)
      ctx.beginPath()
      ctx.rect(Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]),
        Math.abs(p1[0] - p0[0]), Math.abs(p1[1] - p0[1]))
      ctx.fillStyle = fill
      ctx.fill()
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke() }
    }

    // 28 道券。按真宽一道挨一道画：缝是切出来的，不是留出来的。
    // 这一档比例下每道不到十像素、缝只有一像素宽，所以描边要比别处重
    for (let i = 0; i < B.RING_N; i++) {
      rect(-HW + i * cw, -HW + (i + 1) * cw, zIn, zOut, '#9aa4aa', 'rgba(40,50,58,0.72)')
    }
    // 护拱石压在 28 道券的背上，把它们连成一条
    rect(-HW, HW, zOut, zHau, '#bcb19d', INK)

    // 铁拉杆。它在拱顶这一刀里顺着纸面走，所以是一根杆，不是断面的点
    const zTie = B.CY + B.R_OUT + 0.18
    rect(-HW - 0.34, HW + 0.34, zTie - 0.075, zTie + 0.075, '#4c4845', null)
    for (let sg = -1; sg <= 1; sg += 2) {
      const c = PB(sg * (HW + 0.34), zTie)
      ctx.beginPath(); ctx.arc(c[0], c[1], 2.4, 0, Math.PI * 2)
      ctx.fillStyle = '#4c4845'; ctx.fill()
      ctx.strokeStyle = paper; ctx.lineWidth = 1.2; ctx.stroke()
    }

    // 桥宽横着量。字压在券脚底下那片空档里
    ctx.font = '10px sans-serif'
    this.secDim(ctx, mpB, -HW, zIn - 0.55, HW, zIn - 0.55,
      '拱顶全宽 ' + (2 * HW).toFixed(2) + ' m　28 道 × ' + cw.toFixed(2) + ' m', red, paper)

    this.secNotes(ctx, x0 + 16, bBot + 20, [
      '28 道券并排放着，背上一齐压着护拱石；铁拉杆横穿，两端露出圆帽',
      '勾石是第三样横向联系，在拱肩那一段，这一刀切不到——见 3D 拆解'
    ])
  },

  /**
   * 敞肩与实肩的对照。同一张图里上下摞两座桥：上面是真桥（敞肩），
   * 下面是假想的同形实肩桥——拱肩砌实，四个小拱不存在。
   *
   * 两座用的是同一个 secProfile，只差一个 solid 开关，所以桥形、
   * 桥面、栏板处处对齐，看上去的差别就只是那四个洞。这正是要讲的：
   * 省下的石料和多走的洪水，全从那四个洞里来。
   */
  secSpan(ctx, x0, x1, y0, y1, paper, red) {
    const DY = -11.6                       // 下面那座整体下沉这么多米
    const aTop = y0 + 78
    const aBot = y1 - 92
    const mp = this.secMap(-20, 20, DY - 0.4, 11.2, x0 + 24, x1 - 24, aTop, aBot)

    // 上：真桥。四个洞填成朱红浅底，就是"只有这儿有"的那一块
    this.secProfile(ctx, mp, paper, { soil: false, hole: 'rgba(184,69,43,0.16)' })
    // 下：实肩。同一个函数、同一份几何，只是不凿洞
    this.secProfile(ctx, mp, paper, { soil: false, solid: true, dy: DY })

    // 一条分隔线，免得两座桥看着像一座
    const sep = mp.p(-20, DY + 11.2)
    ctx.strokeStyle = 'rgba(158,132,96,0.35)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x0 + 24, sep[1]); ctx.lineTo(x1 - 24, sep[1])
    ctx.stroke()

    // 两块牌子。都落在桥面之上那一片空处，压不到桥上
    const t1 = mp.p(-20, 10.9)
    this.tag(ctx, x0 + 78, t1[1] + 12, '敞肩 · 真桥', '#fdf6ec', 'rgba(158,62,40,0.88)')
    const t2 = mp.p(-20, 10.9 + DY)
    this.tag(ctx, x0 + 78, t2[1] + 12, '实肩 · 假想', '#fdf6ec', 'rgba(110,100,86,0.9)')

    // 两块量出来的数：省下的石料，与此刻多走的洪水
    const ev = H.evaluate(this.data.q)
    const dA = spandrelBonus(ev.open.h)
    const dH = ev.solid.h - ev.open.h
    this.secNotes(ctx, x0 + 24, y1 - 74, [
      '四个小拱凿掉 ' + B.SPANDREL.voidVol.toFixed(0) + ' m³ 石料，约 ' +
        (Math.round(B.SPANDREL.stone / 10) * 10) + ' 吨，占主拱拱肩断面的 ' +
        (B.SPANDREL.share * 100).toFixed(0) + '%',
      '同一水位下多让出 ' + dA.toFixed(0) + ' m² 过水断面；过同样的 ' +
        this.data.q + ' m³/s，洪水位因此低 ' + dH.toFixed(2) + ' m',
      '两座桥走同一个 secProfile，只差一个「凿不凿洞」的开关'
    ])
  },

  /**
   * 桥台与基础构造图。把纵剖面里那张小大样放到整张卡片上——
   * 那一截总共 3.15 m 高，在全桥尺度上不到二十像素，不说清楚，
   * 「赵州桥为什么能站住」这一问就答不到点子上：它没有打桩，
   * 直接把五层条石坐在河床的粗砂层上。
   *
   * 画法与尺寸仍走 secProfile / secDimInset，与纵剖面是同一份几何、
   * 同一份数字，两张图不会各说各的。
   */
  secFound(ctx, x0, x1, y0, y1, paper, red) {
    const aTop = y0 + 80
    const aBot = y1 - 118
    const mp = this.secMap(-27.6, -17.1, -4.4, 2.9, x0 + 22, x1 - 22, aTop, aBot)

    this.secProfile(ctx, mp, paper)
    this.secDimInset(ctx, mp, red, paper)

    // 地层。砂层没有画成另一块土——模型里它就是同一层土，
    // 这里只用一行字和一个引到河床上的短标记说明它是什么
    const P = mp.p
    const bed = P(-21.0, B.BED_Y)
    ctx.strokeStyle = 'rgba(120,100,70,0.75)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(bed[0] - 26, bed[1]); ctx.lineTo(bed[0] - 8, bed[1])
    ctx.stroke()
    ctx.textAlign = 'right'
    ctx.font = '10px sans-serif'
    ctx.fillStyle = 'rgba(70,58,44,0.7)'
    ctx.fillText('河床面', bed[0] - 30, bed[1])
    const sand = P(-25.4, -3.6)
    ctx.textAlign = 'left'
    ctx.fillText('粗砂层', sand[0], sand[1])

    this.secNotes(ctx, x0 + 22, y1 - 96, [
      '桥台长 ' + B.ABUT_LEN.toFixed(1) + ' m，台顶就是起拱线，' +
        '台身下接 ' + B.FOUND_N + ' 层条石，共 ' + (B.FOUND_N * B.FOUND_T).toFixed(2) + ' m',
      '条石底面标高 ' + B.FOUND_BOT.toFixed(2) + ' m，比河床还低 ' +
        (B.BED_Y - B.FOUND_BOT).toFixed(2) + ' m——整摞基础埋在河床以下',
      '天然地基，未打桩。粗砂层排水快、沉降小，是它能站住一千四百年的底子'
    ])
  },

  /**
   * 世界坐标 → 屏幕坐标。横竖共用一个缩放比，画出来的圆弧还是圆、
   * 量出来的角度也还是真角度；剖面图最忌横竖各放大一个倍数。
   */
  secMap(wx0, wx1, wy0, wy1, rx0, rx1, ry0, ry1) {
    const s = Math.min((rx1 - rx0) / (wx1 - wx0), (ry1 - ry0) / (wy1 - wy0))
    const mx = (wx0 + wx1) / 2, my = (wy0 + wy1) / 2
    const cx = (rx0 + rx1) / 2, cy = (ry0 + ry1) / 2
    return {
      s: s, wx0: wx0, wx1: wx1, wy0: wy0, wy1: wy1,
      rx0: rx0, ry0: ry0, rx1: rx1, ry1: ry1,
      p: function (x, y) { return [cx + (x - mx) * s, cy - (y - my) * s] }
    }
  },

  /**
   * 两条函数曲线之间那条带子。剖面图上石作的每一块都是这个形状：
   * 护拱石、主拱券、拱肩侧墙、桥面、栏板，还有凿出来的四个小拱洞——
   * 差别只在取哪两条边界、在哪个横向上取样、填什么色。
   *
   * 取样是"去程走一条、回程走另一条"，两条曲线不必分出谁上谁下：
   * 两趟合起来正好是这个闭合区域的轮廓，而 fill() 只看轮廓、
   * 不看绕序。所以拱券那一块可以拿内弧当去程、外弧当回程，
   * 名称不必别过来。
   *
   * 原先每一块都把"正着走一遍、倒着走一遍、closePath、fill、stroke"
   * 抄一遍，六份抄下来，改一处边界就得记住还有五处等着改。
   */
  bandBetween(ctx, mp, o) {
    const P = mp.p
    const n = o.n || 64
    const step = (o.x1 - o.x0) / n
    ctx.beginPath()
    for (let i = 0; i <= n; i++) {
      const p = P(o.x0 + step * i, o.fwd(o.x0 + step * i))
      if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1])
    }
    for (let i = n; i >= 0; i--) {
      const p = P(o.x0 + step * i, o.back(o.x0 + step * i))
      ctx.lineTo(p[0], p[1])
    }
    ctx.closePath()
    ctx.fillStyle = o.fill
    ctx.fill()
    if (o.stroke) {
      ctx.strokeStyle = o.stroke
      ctx.lineWidth = o.lw || 1
      ctx.stroke()
    }
  },

  /**
   * 地面线：在 [XL, XR] 上按 groundY 走一条。调用方自己决定是
   * closePath 之后填成土、还是就这么描一道线——制图习惯上地面线要
   * 一路穿过去，埋在地下的桥台和基础也照穿，"埋多深"这才读得出来。
   */
  groundPath(ctx, mp, XL, XR) {
    const P = mp.p
    const n = 90
    ctx.beginPath()
    for (let i = 0; i <= n; i++) {
      const x = XL + (XR - XL) * (i / n)
      const p = P(x, B.groundY(Math.abs(x)))
      if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1])
    }
  },

  /**
   * 一张剖面的石作部分。全桥和桥台大样共用这一份画法——大样只是换了个
   * map，几何一模一样，两张图不会出现对不上的地方。
   *
   * 画的次序就是砌的次序：先铺土，再桥台与基础，再拱券与护拱石，
   * 再拱肩侧墙，然后把四个小拱的洞凿出来，最后铺桥面、勒地面线。
   *
   * opt（可省）：
   *   solid  不凿四个小拱——画出假想的那座同形实肩桥，「敞肩对照」要用
   *   soil   关掉土、桥台、基础，只留桥身石作。对照那张一上一下摞两座桥，
   *          带上地基就成了两坨土，比不出什么
   *   dy     整座桥抬高 dy 米。同上：一个 map 里上下摞两座，靠这个错开
   *   hole   四个小拱的洞填什么色。默认填纸色；对照那张填一层朱红浅底，
   *          指出"只有这里有"的那一块
   */
  secProfile(ctx, mp, paper, opt) {
    const o = opt || {}
    const P = mp.p
    const dy = o.dy || 0
    // 上下摞两座桥时，边界函数统一垫高一档，省得每处各写一遍 +dy
    const sh = function (f) {
      return dy ? function (x) { return f(x) + dy } : f
    }
    // 地面线只在本画幅自己的横向上取样，这是第一层保险
    const XL = mp.wx0 - 2, XR = mp.wx1 + 2
    const INK = 'rgba(64,54,42,0.6)'

    // 第二层保险，也是真正管用的那一层：整张剖面裁在本画幅的框里。
    // 桥面、侧墙、地面这几样都是按整座桥的坐标画的（±32 m），大样那张
    // 横向放大五倍，投下来就是一块横贯整张卡片的大斜坡，把上面的全桥
    // 剖面整个盖掉。尺寸线在 secProfile 之外画，不受这道裁剪影响
    ctx.save()
    ctx.beginPath()
    ctx.rect(mp.rx0, mp.ry0, mp.rx1 - mp.rx0, mp.ry1 - mp.ry0)
    ctx.clip()

    // ---- 土：河床与两岸 ----
    if (o.soil !== false) {
      this.groundPath(ctx, mp, XL, XR)
      let q = P(XR, mp.wy0)
      // 收在画幅自己的底边上，不是卡片底边：两块画幅上下相邻，
      // 土要是一直铺到卡片底，下面那张大样和图注就全埋在土里了
      ctx.lineTo(q[0], q[1])
      q = P(XL, mp.wy0); ctx.lineTo(q[0], q[1])
      ctx.closePath()
      ctx.fillStyle = '#ded2b6'
      ctx.fill()

      // ---- 桥台。台身从起拱线砌到 -1.60 m ----
      for (let sg = -1; sg <= 1; sg += 2) {
        const a = P(sg * B.ABUT_X0, B.ABUT_BOT), b = P(sg * B.ABUT_X1, B.ABUT_BOT)
        const c = P(sg * B.ABUT_X1, B.ABUT_TOP), d = P(sg * B.ABUT_X0, B.ABUT_TOP)
        ctx.beginPath()
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1])
        ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1])
        ctx.closePath()
        ctx.fillStyle = '#a9a294'
        ctx.fill()
        ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.stroke()
      }

      // ---- 五层条石基础。每层向外出台 0.06 m，深浅相间才数得出"五" ----
      for (let sg = -1; sg <= 1; sg += 2) {
        for (let i = 0; i < B.FOUND_N; i++) {
          const yy1 = B.ABUT_BOT - i * B.FOUND_T
          const yy0 = yy1 - B.FOUND_T
          const xa = sg * (B.ABUT_X0 - 0.10 - i * 0.06)
          const xb = sg * (B.ABUT_X1 + 0.18 + i * 0.06)
          const a = P(xa, yy0), b = P(xb, yy0), c = P(xb, yy1), d = P(xa, yy1)
          ctx.beginPath()
          ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1])
          ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1])
          ctx.closePath()
          ctx.fillStyle = i % 2 ? '#9a9284' : '#b0a897'
          ctx.fill()
          ctx.strokeStyle = 'rgba(64,54,42,0.42)'
          ctx.lineWidth = 1
          ctx.stroke()
        }
      }
    }

    // ---- 护拱石。券背外面又贴的那一层，上边界就是拱背 ----
    const NH = 48
    const AX = B.HALF_SPAN
    this.bandBetween(ctx, mp, {
      x0: -AX, x1: AX, n: NH,
      fwd: sh(B.archExtrados), back: sh(B.haunchTop),
      fill: '#bcb19d', stroke: INK
    })

    // ---- 主拱券 ----
    this.bandBetween(ctx, mp, {
      x0: -AX, x1: AX, n: NH,
      fwd: sh(B.archIntrados), back: sh(B.archExtrados),
      fill: '#9aa4aa', stroke: 'rgba(50,60,68,0.75)'
    })

    // ---- 拱肩侧墙。下边界跟着拱背走，到桥台段落在起拱线上，
    //      再往外顺岸坡爬上去；上边界就是桥面底 ----
    this.bandBetween(ctx, mp, {
      x0: -B.DECK_HALF, x1: B.DECK_HALF, n: 220,
      fwd: sh(B.wallBottom), back: sh(B.deckBottom),
      fill: '#c3bcac', stroke: INK
    })

    // ---- 凿出四个小拱。下边界是拱背（起拱线本来就取在拱背上），上边界是
    //      券脸；凿完之后，剩下那圈石料里自然就含着券自己的厚度 ----
    for (let k = 0; !o.solid && k < B.SMALL.length; k++) {
      const sm = B.SMALL[k]
      for (let sg = -1; sg <= 1; sg += 2) {
        // sg = -1 那一侧 x0 > x1，区间是倒着走的。bandBetween 只认两端点、
        // 不认方向，倒着走画出来是一样的
        this.bandBetween(ctx, mp, {
          x0: sg * sm.x0, x1: sg * sm.x1, n: 20,
          fwd: sh(B.haunchTop),
          back: function (x) { return B.smallIntrados(sm, x) + dy },
          fill: o.hole || paper, stroke: 'rgba(50,60,68,0.7)'
        })
      }
    }

    // ---- 桥面 ----
    const ND = 64
    this.bandBetween(ctx, mp, {
      x0: -B.DECK_HALF, x1: B.DECK_HALF, n: ND,
      fwd: sh(B.deckTop), back: sh(B.deckBottom),
      fill: '#cfc9bb', stroke: 'rgba(64,54,42,0.75)'
    })

    // ---- 栏板望柱。它们立在桥面两侧，中线剖面上本来照不见，按制图习惯
    //      补一道浅色可见轮廓，顺带把 21 块栏板的缝也勒出来 ----
    const rTop = sh(function (x) { return B.deckTop(x) + 0.95 })
    this.bandBetween(ctx, mp, {
      x0: -B.DECK_HALF, x1: B.DECK_HALF, n: ND,
      fwd: sh(B.deckTop), back: rTop,
      fill: 'rgba(196,188,174,0.9)', stroke: 'rgba(64,54,42,0.5)'
    })
    ctx.strokeStyle = 'rgba(64,54,42,0.24)'
    ctx.beginPath()
    for (let i = 1; i < B.RAIL_PANEL; i++) {
      const x = -B.DECK_HALF + 2 * B.DECK_HALF * (i / B.RAIL_PANEL)
      const a = P(x, B.deckTop(x) + dy), b = P(x, rTop(x))
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1])
    }
    ctx.stroke()

    // ---- 地面线摆在最后：制图习惯上地面线要一路穿过去，埋在地下的
    //      桥台和基础也照穿，"埋多深"这才读得出来 ----
    if (o.soil !== false) {
      ctx.strokeStyle = 'rgba(120,100,70,0.62)'
      ctx.lineWidth = 1
      this.groundPath(ctx, mp, XL, XR)
      ctx.stroke()
    }

    ctx.restore()
  },

  /**
   * 剖面上的尺寸线。两点之间一道细线，两端带垂直端头；
   * 字默认压在线中间（垫一块纸色，线从字后面穿过），
   * 也可以另指一个落点，那时字贴着落的那个点写。
   */
  secDim(ctx, mp, ax, ay, bx, by, text, color, paper, lx, ly) {
    const A = mp.p(ax, ay), Z = mp.p(bx, by)
    const dx = Z[0] - A[0], dy = Z[1] - A[1]
    const L = Math.sqrt(dx * dx + dy * dy) || 1
    const ux = dx / L, uy = dy / L
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(A[0], A[1]); ctx.lineTo(Z[0], Z[1])
    const px = -uy * 4, py = ux * 4
    ctx.moveTo(A[0] - px, A[1] - py); ctx.lineTo(A[0] + px, A[1] + py)
    ctx.moveTo(Z[0] - px, Z[1] - py); ctx.lineTo(Z[0] + px, Z[1] + py)
    ctx.stroke()

    const onLine = lx === undefined
    const midX = (A[0] + Z[0]) / 2
    const at = onLine ? [midX, (A[1] + Z[1]) / 2] : mp.p(lx, ly)
    if (onLine) {
      const w = ctx.measureText(text).width + 6
      ctx.fillStyle = paper
      ctx.fillRect(at[0] - w / 2, at[1] - 7, w, 14)
      ctx.textAlign = 'center'
    } else {
      // 横着的尺寸线，字居中摆在线的上/下方；竖着的，字贴到线的外侧
      const horiz = Math.abs(dx) >= Math.abs(dy)
      ctx.textAlign = horiz ? 'center' : (at[0] < midX ? 'right' : 'left')
    }
    ctx.fillStyle = color
    ctx.fillText(text, at[0], at[1])
  },

  /**
   * 全桥剖面的尺寸。
   *
   * 只留净跨和矢高两道。别的数字不往图上放，是因为这张图横向只有
   * 6.6 px/m：一行「主拱券厚 1.03 m」写出来有七十来像素，等于十米多，
   * 无论落在哪儿都会压到小拱或拱肩上，引线也得斜穿半个拱。那些数字
   * 一律挪到图下去做图注，图上只留两道最要紧的尺寸。
   */
  secDimFull(ctx, mp, color, paper) {
    ctx.font = '10px sans-serif'
    ctx.textBaseline = 'middle'

    // 净跨。尺寸线就落在起拱线上——它的两端正好是两个拱脚，
    // 桥上再没有比这更现成的一条线了。字挪到左半边，避开拱顶下方
    // 那道竖直的矢高线
    this.secDim(ctx, mp, -B.HALF_SPAN, 0, B.HALF_SPAN, 0,
      '净跨 ' + B.SPAN.toFixed(2) + ' m', color, paper, -7.5, 1.15)

    // 矢高。竖直那条线落在 x = 0，字压在线中间
    this.secDim(ctx, mp, 0, 0, 0, B.RISE, '矢高 ' + B.RISE.toFixed(2) + ' m', color, paper)
  },

  /** 桥台大样的尺寸 */
  secDimInset(ctx, mp, color, paper) {
    ctx.font = '10px sans-serif'
    ctx.textBaseline = 'middle'
    const fBot = B.ABUT_BOT - B.FOUND_N * B.FOUND_T

    // 台身。尺寸线走在台顶之上、拱背之下那条空档里
    this.secDim(ctx, mp, -B.ABUT_X1, 0.32, -B.ABUT_X0, 0.32,
      '台身 ' + B.ABUT_LEN.toFixed(1) + ' m', color, paper)

    // 五层条石。字贴在线左侧的画幅留白里，右端要停在埋深线之外，
    // 否则那道竖着的尺寸线会从字上穿过去
    this.secDim(ctx, mp, -24.55, B.ABUT_BOT, -24.55, fBot,
      '五层条石 ' + (B.FOUND_N * B.FOUND_T).toFixed(2) + ' m', color, paper, -25.8, -2.6)

    // 基底的埋深。量到河床面——桥台就落在这层粗砂上，台底又比河床
    // 低了 0.6 m，所以整摞基础埋深 2.15 m。数字从模型里算，不写死
    this.secDim(ctx, mp, -25.4, B.BED_Y, -25.4, fBot,
      '河床以下 ' + (B.BED_Y - fBot).toFixed(2) + ' m', color, paper, -25.8, -1.45)
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
    ctx.fillText(B.RING_N + ' 道拱券并列砌筑', x0, y0 - 15)
    ctx.restore()
  },

  // ==================== HUD 同步 ====================

  syncHud(ts, dt) {
    if (ts - this.hudAt < 110) return
    this.hudAt = ts

    const d = {}
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
      // 此刻落在水量尺的第几档。档位界线就是那两个临界流量，
      // 和 BANDS 用同一对数，尺上和卡上的说法不会打架
      const bd = this.bandsAt(this.data.q)
      if (bd !== this.data.band) d.band = bd

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
      // 内、外两对小拱不一样高（起拱线 6.05 / 3.91），所以是分级过水的：
      // 水先够着外侧那对，再涨一截才轮到内侧那对。这一条比百分比直观。
      //
      // 每对分两个说法，因为洞口底下那条边是斜的（主拱外弧），
      // 「水刚够着洞口最低点」和「水漫过券脚」差了将近 3 m：
      //   过  水 —— 水位已过起拱线，整孔在泄
      //   初漫洞底 —— 只漫过洞口最外侧那一条，刚开始过水
      // 早先只有「过水 / 不过水」两态，判据是起拱线，于是水位 2.3 m 时
      // 卡片上写着「尚无一孔过水」，紧挨着的「敞肩之利」却已经有 2 m² 了。
      const flowing = []
      for (let i = 0; i < B.SMALL.length; i++) {
        const s = B.SMALL[i]
        const name = (i === 0 ? '内侧' : '外侧') + ' 2 个'
        if (o.h > s.spring) flowing.push(name + '过水')
        else if (o.h > s.sill) flowing.push(name + '初漫洞底')
      }
      // 同一水位下，敞肩桥比实肩桥多出来的那一块过水断面，
      // 就是此刻四个小拱真正让出来的净面积——敞肩拱的贡献值直接量出来了
      // 取整不带小数，是为了和剖面图那两张印出来的数一模一样。
      // 三处（这里、过水断面、敞肩对照）本来都走 spandrelBonus，
      // 若小数位各写各的，17.1 与 17 并排摆着，说课时还是要解释一遍
      const smallA = spandrelBonus(o.h)
      const sp = {
        flowing: flowing.length ? flowing.join(' + ') : '尚无一孔过水',
        nowArea: smallA.toFixed(0)
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
    const ts = e.touches
    // 剖面卡片顶上的页签是画在 canvas 里的，够不着 bindtap，只能在这里
    // 认领。认领了就直接返回：这一下是点按钮，不是转桥
    if (this.data.sec && ts.length === 1 && this.hitSecTab(ts[0])) return
    this.anim = null
    if (this.data.view !== 'free') this.setData({ view: 'free' })
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
      // 泄洪的机位只剩全景和小拱两档了，进屋就落在全景；
      // 上一轮已经停在某一档（比如「小拱」）就别再动镜头
      if (this.data.view !== 'full' && this.data.view !== 'small') {
        this.applyView('full')
      }
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
    this.setData({
      q: e.detail.value, band: this.bandsAt(e.detail.value), autoFlood: false
    })
  },

  /** 此刻落在第几档水量上：过了几个临界流量 */
  bandsAt(q) {
    if (q < Q_OUTER) return 0
    if (q < Q_INNER) return 1
    return 2
  },

  /** 水量尺。点哪一档就跳到哪一档的中位流量，讲课时不必去拖滑块对位置 */
  onBand(e) {
    const q = +e.currentTarget.dataset.q
    if (!q || q === this.data.q) return
    this.st.q = q
    this.setData({ q: q, band: this.bandsAt(q), autoFlood: false })
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
   * 受力。开着的时候水压箭头让位——两套箭头叠在一张画面上，
   * 学生分不清哪根是水推石头、哪根是桥自己往两边撑，不如一次只讲一件事。
   *
   * 打开时把机位拉回全景：这三层力讲的是"整座桥怎么把重量卸到两岸"，
   * 凑在「小拱」那个特写机位上，荷载箭头和拱脚那两支全在画外，
   * 只剩中间几支没头没尾的赭色线，反而讲不通。跟坦拱对照一个道理。
   */
  onToggleThrust() {
    const thrust = !this.data.thrust
    this.setData({ thrust })
    if (thrust) this.applyView('full')
  },

  /** 纵剖面图和「数据出处」是同一类浮层，两张卡片同时铺开会打架，互斥 */
  onToggleSec() {
    const sec = !this.data.sec
    this.setData({ sec: sec, srcOpen: sec ? false : this.data.srcOpen })
  },

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
      this.setData({ srcOpen: true, playing: false, sec: false })
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
