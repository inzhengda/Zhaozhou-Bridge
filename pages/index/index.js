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
const QUIZ = require('./quiz-data.js')

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
    desc: '净跨 3.8 m ×2、2.85 m ×2 —— 现存最早的敞肩拱'
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
  // pitch 抬到 0.10：压平的视角看洞里只有一条缝，抬高一点才能读出洞的进深
  small: { yaw: 0.20,  pitch: 0.10,  zoom: 0.15, t: [15.5, 6.0, 0], name: '小拱' },

// 营造机位：建造模式的默认落点，高空斜俯看 28 道并列拱券。
//
// 正面平视时 28 道券前后重叠，画面上只剩最外一道券和侧墙，
// "并列砌券"这个核心讲点完全看不出来。抬高俯角（pitch 0.75 ≈ 43°，
// 取"俯视 45°"的观感但留一点立面）：拱弧的立面可见度 =
// cos(pitch)·cos(yaw) ≈ 0.58，拱的弧线仍在；券沿桥宽方向的错层
// 投影 9.6·sin(0.65) ≈ 5.8 m，加上高机位的近大远小，道道分得开。
// yaw 0.65 沿用拆解机位验证过的区间（0.68~0.80 不穿树冠，
// 略收一点让画面多带桥身）；zoom 0.45 视宽约 33 m，主拱段撑满画幅。
// 目标压到 ty 3.0，拱背在画面中线上方，券层铺在下半幅。
build: { yaw: 0.65, pitch: 0.75, zoom: 0.45, t: [0, 3.0, 0], name: '营造' }
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

// 外侧那对券脚低、先过水；内侧那对高，要再涨一档才够着。
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

// ==================== 部位拾取（点哪，看哪） ====================
// 锚点是每个部位在屏幕上的"点击热点"，cam 是聚焦后的落点机位。
// 数值全部取自 bridge.js 的几何，不写死——几何一改锚点跟着走。
// 小拱、桥台左右对称各一枚，点哪一头飞哪一头。
const PARTS = (function () {
  const si = B.SMALL[0], so = B.SMALL[1]
  const yIn = si.spring + si.f + 0.35
  const yOut = so.spring + so.f + 0.35
  const list = [
    {
      id: 'arch', name: '主拱',
      l1: '净跨 37.02 m · 矢高 7.23 m · 矢跨比 1 : 5.12',
      l2: '28 道拱券纵向并列，每道独立成拱、可单独抽换',
      minT: B.T.arch[1],
      hit: [0, 4.3, 0],
      cam: { yaw: 0.10, pitch: -0.02, zoom: 0.30, tx: 0, ty: 4.4, tz: 0 }
    },
    {
      id: 'rings', name: '28 道并列拱券',
      l1: '每道券宽约 0.32 m，自两端拱脚对称砌向拱顶',
      l2: '一道受损只换一道，整桥不致倾覆',
      minT: B.T.arch[1],
      hit: [0, 1.1, 4.4],
      cam: { yaw: 0.95, pitch: 0.12, zoom: 0.38, tx: 0, ty: 3.6, tz: 0 }
    },
    {
      id: 'deck', name: '桥面',
      l1: '随拱势微拱，宽 9.0 m',
      l2: '连同桥堍全长 64.4 m，可通车马',
      minT: B.T.deck[1],
      hit: [0, 9.3, 0],
      cam: { yaw: 0.03, pitch: 0.05, zoom: 0.45, tx: 0, ty: 6.0, tz: 0 }
    },
    {
      id: 'rail', name: '栏板望柱',
      l1: '两侧石栏板，全桥分 22 间',
      l2: '望柱与栏板一路排开，随桥势起伏',
      minT: B.T.rail[1],
      hit: [0, 10.0, 2.2],
      cam: { yaw: 0.30, pitch: 0.10, zoom: 0.42, tx: 0, ty: 7.2, tz: 0 }
    }
  ]
  for (let sg = -1; sg <= 1; sg += 2) {
    list.push({
      id: 'so' + sg, name: '敞肩小拱 · 外侧',
      l1: '净跨 3.81 m，券脚就坐在主拱拱背上',
      l2: '券脚低，洪水先从这里泄出（' + Q_OUTER + ' m³/s 起）',
      minT: B.T.small[1],
      hit: [sg * so.xc, yOut, 0],
      cam: { yaw: 0.20, pitch: 0.10, zoom: 0.15, tx: sg * so.xc, ty: 6.0, tz: 0 }
    })
    list.push({
      id: 'si' + sg, name: '敞肩小拱 · 内侧',
      l1: '净跨 2.85 m，券脚比外侧那对高出约 2 m',
      l2: '水涨到 ' + Q_INNER + ' m³/s 才够着券脚，洪峰时四孔齐泄',
      minT: B.T.small[1],
      hit: [sg * si.xc, yIn, 0],
      cam: { yaw: 0.20, pitch: 0.10, zoom: 0.17, tx: sg * si.xc, ty: 6.2, tz: 0 }
    })
    list.push({
      id: 'ab' + sg, name: '桥台与地基',
      l1: '长 5 m 五层条石，直接坐在粗砂层上，未打桩',
      l2: '拱脚的水平推力全靠两岸桥台与台后填土顶住',
      minT: B.T.base[1],
      hit: [sg * 21, 1.2, 0],
      cam: { yaw: 0.16, pitch: 0.05, zoom: 0.33, tx: sg * 19.5, ty: 2.6, tz: 0 }
    })
  }
  return list
})()

// ==================== 说课导览 ====================
// 九步，一步一个知识点，相机与开关都替用户摆好——录屏时按"下一步"就行。
// 每步的 setup 字段会写进 data；t / q / view / split 单独处理。
const TOUR = [
  {
    name: '全桥 · 总起',
    text: '现存最早的敞肩石拱桥。隋开皇至大业年间（595—605），匠师李春主持建成，连同桥堍全长 64.4 m。',
    view: 'full', t: B.TOTAL, data: { mode: 'build' }
  },
  {
    name: '坦拱之利',
    text: '净跨 37.02 m，矢高 7.23 m，矢跨比约 1 : 5.12。同样的跨径改用半圆拱，矢高要 18.51 m——坦拱桥面才能近乎平地过河，车马上下省力。',
    view: 'side', data: { mode: 'build', flat: true }
  },
  {
    name: '敞肩小拱 · 分级过水',
    text: '四个小拱的券脚就坐在主拱拱背上。洪水先漫过外侧两孔（' + Q_OUTER + ' m³/s 起），涨到 ' + Q_INNER + ' m³/s 内侧两孔也泄。',
    view: 'small', q: Math.round((Q_OUTER + Q_INNER) / 2), data: { mode: 'flood' }
  },
  {
    name: '28 道拱券并列',
    text: '桥不是一整块拱，是 28 道独立拱券纵向并列砌成的，每道自成拱券——一道受损不致全桥倾覆。',
    data: { mode: 'build' },
    split: true
  },
  {
    name: '横向联系',
    text: '券石之间嵌腰铁咬住本券的券石，9 根铁拉杆横穿 28 券，护拱石两侧的勾石钩住最外一道。并列的券靠这三样连成一个整体。',
    data: { mode: 'build' },
    split: true
  },
  {
    name: '受力路径',
    text: '桥面荷载沿拱轴压向两脚，到拱脚只剩向外的水平推力，由两岸桥台与台后地基顶住——河心不立桥墩，桥却千年不塌。',
    view: 'full', data: { mode: 'build', thrust: true }
  },
  {
    name: '泄洪 · 小拱分洪',
    text: '水位漫过外侧券脚，两孔先泄。敞肩之利都是实算值：过水断面增大、冲击力与上游壅水降低，读数卡上的数随水量变。',
    view: 'full', q: Math.round((Q_OUTER + Q_INNER) / 2), data: { mode: 'flood' }
  },
  {
    name: '洪峰 · 四孔全开',
    text: '洪峰时水位逼到 6.9 m，四孔齐泄，减杀水势、减轻桥身侧压，主拱洞仍保有断面行洪。',
    view: 'full', q: 1200, data: { mode: 'flood' }
  },
  {
    name: '收束 · 地位',
    text: '1961 年列入第一批全国重点文物保护单位；1991 年被美国土木工程师学会选定为「国际土木工程历史古迹」（第 12 处）。',
    view: 'full', data: { mode: 'build' }
  }
]

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
    sec: false,           // 纵剖面图。开的时候 3D 上的标注一概让位
    // 部位聚焦：focus 是信息卡内容，focusId 用于高亮圈与去重
    focus: null,
    focusId: null,
    // 说课导览：null 关闭，0..8 是当前步
    tour: null, tourIdx: 0, tourTotal: TOUR.length, tourName: '', tourText: '',
    // 尺寸数据的出处，静态不变量，见 utils/sources.js
    sources: SRC.GROUPS,
    annals: SRC.ANNALS,
    srcTabs: SRC.TABS,
    srcTab: SRC.TABS[0],
    srcOpen: false,
    quizOpen: false, quizIdx: 0, quizPick: null, quizDone: false,
    QUIZ: QUIZ,
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
    this.animT = 0      // 泄洪档位动画的相位钟：波线、流线、涟漪共用
    // 顶部四层的落位。层级之间用固定间距，改字号时才不用一处处重算：
    // 抬头（含副题）≈ 56 px、右下角那枚「数据出处」≈ 26 px
    const top = this.measureTop()
    this.setData({
      topTitle: top,
      topBtn: top + 56,      // 数据出处 / FPS，压在抬头右下
      topCard: top + 88,     // 营造阶段卡 / 泄洪读数卡
      topCmp: top + 180      // 敞肩对比卡（只在泄洪模式出现，压在读数卡之下）
    })
    // 开画就是建造模式，落在「营造」机位上，和 VIEWS.build 保持一致：
    // 高空斜俯看 28 道并列拱券，层次分明；正面平视时它们前后重叠
    const v0 = VIEWS.build
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
      this.static = { terrain: this.bs.terrain, scenery: this.bs.scenery }
      this.cartMesh = this.buildCartMesh()

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


  /** 独轮/双轮推车：平台 + 两个轮 + 货箱，建模在 x=0 处，跑起来靠 pushMeshT 平移 */
  buildCartMesh() {
    const { slabMesh, mesh, C } = B
    const y0 = B.deckTop(0)
    const parts = []
    // 平台 3.0 x 0.25 x 1.8
    parts.push(slabMesh(-1.5, 1.5, y0 + 0.55, y0 + 0.80, -0.9, 0.9, C.rail))
    // 货箱 2.0 x 0.9 x 1.2
    parts.push(slabMesh(-1.0, 1.0, y0 + 0.80, y0 + 1.70, -0.6, 0.6, C.span))
    // 两轮：薄棱柱当圆轮用（简化，半径 0.55）
    for (const sz of [-1.0, 1.0]) {
      const m = mesh.newMesh()
      const pts = []
      const nSeg = 10
      for (let i = 0; i < nSeg; i++) {
        const a = (i / nSeg) * Math.PI * 2
        pts.push([0.55 * Math.sin(a), 0.55 * Math.cos(a)])
      }
      mesh.prismZ(m, pts, sz - 0.07, sz + 0.07, C.span)
      parts.push(m)
    }
    // 合并成一个 mesh
    const cart = mesh.newMesh()
    for (const m of parts) {
      const offset = cart.pos.length / 3
      cart.pos.push(...m.pos)
      for (const f of m.faces) cart.faces.push({ ...f, i: f.i + offset })
    }
    return cart
  },

  // 马车动载状态
  cartX: 0, cartDir: 1, cartMesh: null,

  tick(ts) {
    if (!this.running || !this._ready) return
    const dt = this.last ? Math.min(0.1, (ts - this.last) / 1000) : 0.016
    this.last = ts
    this.animT += dt

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
    } else if (this.st.q !== this.data.q) {
      // 水位呈现值向滑块目标指数逼近：点档位、拖滑块时水面是涨落过去的，
      // 不是瞬移；读数卡也读呈现值，数字才和画面里的水对得上
      const k = 1 - Math.exp(-dt / 0.35)
      const diff = this.data.q - this.st.q
      this.st.q += Math.abs(diff) < 1 ? diff : diff * k
    }

    // 拆解程度缓慢跟随开关，散开与并拢都有个过程，看得清券是怎么分开的
    const want = this.data.split ? 1 : 0
    if (this.ex !== want) {
      const k = dt / 0.9
      this.ex += want > this.ex ? Math.min(k, want - this.ex) : -Math.min(k, this.ex - want)
      if (Math.abs(this.ex - want) < 0.004) this.ex = want
    }

    // 马车动载：受力模式下独轮来回走，力跟着走
    if (this.data.thrust && !this.data.sec && !this.data.focus) {
      this.cartX += this.cartDir * dt * 3.2
      if (this.cartX > 14) { this.cartX = 14; this.cartDir = -1 }
      if (this.cartX < -14) { this.cartX = -14; this.cartDir = 1 }
    }
    // 松手惯性：手势里采到的角速度按指数衰减继续带一段，快甩多转、慢拖不飘
    if (this.spin && !this.anim) {
      const c = this.cam
      c.yaw += this.spin.vyaw * dt
      c.pitch = clamp(c.pitch + this.spin.vpitch * dt, -0.45, 0.95)
      this.clampOrbit()
      const decay = Math.exp(-dt / 0.4)
      this.spin.vyaw *= decay
      this.spin.vpitch *= decay
      if (Math.abs(this.spin.vyaw) < 0.02 && Math.abs(this.spin.vpitch) < 0.02) this.spin = null
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
    this.static = { terrain: this.bs.terrain, scenery: this.bs.scenery }
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
    // d 允许镜头表显式给定：近景机位（树冠这类）不受全景视锥的
    // camDist 约束，否则"特写"实际在 190 m 外拍，什么都看不清
    const d = this.cam.d != null ? this.cam.d : this.camDist(c.zoom)
    const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch)
    const target = [c.tx, c.ty, c.tz]
    const eye = [
      target[0] + d * cp * Math.sin(c.yaw),
      target[1] + d * sp,
      target[2] + d * cp * Math.cos(c.yaw)
    ]
    if (eye[1] < 1.2) eye[1] = 1.2
    // 视线不许钻进地形：长焦侧后机位就算眼睛在岸顶上方，视线朝
    // 目标下俯，还是会在两岸陡坡段扎进地里——画面被一条地平带
    // 拦腰截断，桥"消失"。沿视线采样比高，视线高度对 eye[1] 是
    // 线性的，亏空除以各自的 u 取最大，一次解出精确抬升量
    let lift = 0
    // 目标本身贴地/入土时（如对岸坡近景），视线近段必然贴坡，按全段
    // 采样会解出天文数字的抬升把构图炸掉——这类目标近段直接跳过。
    // 解不封顶：极端手势（贴水仰视远望）穿堤亏空本来就要几十米，
    // 抬到位才能保住"视线永不穿地"这条硬约束，宁可视野抬高也不让
    // 一条土坎拦腰截断桥
    const grounded = target[1] < B.groundY(Math.abs(target[0])) + 2
    for (let s = 1; s <= 48; s++) {
      const u = s / 48
      if (grounded && u < 0.3) continue
      const x = target[0] + (eye[0] - target[0]) * u
      const y = target[1] + (eye[1] - target[1]) * u
      // 余量 2.5 m：贴着坡顶切过去桥会藏进岸坡的视线阴影里，
      // 高一点变成"越顶斜视"，河谷里的桥面和拱上部都露出来
      const need = (B.groundY(Math.abs(x)) + 2.5 - y) / u
      if (need > lift) lift = need
    }
    if (lift > 0) eye[1] += lift
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
    const q = flood ? this.st.q : 0

    let ev = null
    if (flood) ev = H.evaluate(q)
    // 营造时是常水位：水面压在起拱线（标高 0）以下，拱脚和桥台都是干的。
    // 原来取 +0.9 m，等于把常水位抬到起拱线之上，河滩和桥台全泡在水里
    const waterY = flood ? ev.open.h : -0.35
    const waterDepth = flood ? Math.max(1.2, ev.open.h - H.H_BED) : 1.0

    // ---- 静态地形 ----
    R.pushMesh(sc, this.static.terrain, null, {
      waterY: waterY, waterDepth: waterDepth,
      // 地形是开放的高度场：两岸的陡坡格几乎立起来，法线朝水平方向，
      // 从岸顶那侧看是"背面"，会被剔除——桥台周围就漏出天空，桥台
      // 像悬在雾里。地形不做背面剔除，多画的只是几十个背格
      noCull: true,
      // seam：顺序 AA 的边缘合成只有 75% 覆盖，大平面上就是满屏格线。
      // 地形和水面这两片"大平面"必须同色描边压缝；桥体面小、色彩碎，
      // 缝陷在纹理里看不见，就不花这笔描边开销了
      seam: true
    })
    // 岸上景物：官道、纤道、树、村舍，跟着地形一起受水位浸染
    const scN = this.static.scenery
    R.pushMesh(sc, scN.road, null, { waterY: waterY, waterDepth: waterDepth })
    R.pushMesh(sc, scN.greens, null, { waterY: waterY, waterDepth: waterDepth })
    R.pushMesh(sc, scN.houses, null, { waterY: waterY, waterDepth: waterDepth })
    // 压强热力色只在泄洪时上身。营造时河浅、桥台埋在砂里，
    // 埋深处的 p = ρgh 会把桥台染成通红，看着像出了错
    const wo = { waterY: waterY, waterDepth: waterDepth, waterTint: flood }

    // ---- 营造中的构件 ----
    const solid = !this.data.open
    this._ex = this.ex
    this.drawPieces(sc, t, solid, wo)

    // ---- 马车（受力模式下动载来回走）----
    if (this.cartMesh && this.data.thrust && !this.data.sec && !this.data.focus && !flood) {
      const dy = B.deckTop(this.cartX) - B.deckTop(0)
      // 推车轮底贴着桥面，和桥面挂同一排序偏置，陡视角下轮子不会被桥面啃掉
      R.pushMeshT(sc, this.cartMesh, this.cartX, dy, 0, { ...wo, dBias: -0.35 })
    }

    // ---- 坦拱对照 ----
    // 拆解状态下 28 道券已经摊开，再叠一道半圆拱虚影就太乱，所以不画
    if (this.data.flat && this._ex < 0.02) this.drawFlatCompare(sc, t, cam)

    // ---- 水面 ----
    const flow = flood ? ev.open.v : 0.5
    const bd = flood ? this.data.band : 0
    // 波幅随档位走：枯水近于静水，外侧两孔起浪，四孔全开再抬高；
    // 洪峰（水位 6.2 m 以上）再乘一档——"水大浪高"不用讲，看着就是
    const peak = flood && waterY > 6.2
    const amp = flood ? 0.9 + bd * 0.45 + (peak ? 0.35 : 0) : 1
    this.drawWater(sc, waterY, this.animT, flood, wetHalf(waterY), cam.eye[2], d, amp)
    this.drawReflections(sc, waterY, flood)

    // ---- 水流粒子 & 水花 ----
    this.drawParticles(sc, dt, waterY, flood, flow, ev)
    this.drawFoam(sc, waterY, flood, flow)

    // ---- 洞内流线与出口涟漪 ----
    // 数量与组数随档位走（对照 HTML 教学页同一套语言）：枯水主拱一条，
    // 外侧两孔起加小拱流线与出口涟漪，四孔全开加密、洪峰加桥台激荡
    if (flood) {
      this.drawStreamlines(sc, waterY, ev, this.animT, bd)
      this.drawRipples(sc, waterY, this.animT, bd)
    }

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
      // 受力不再绑定泄洪模式：营造模式下讲"重量怎么走到两岸"同样成立
      if (this.data.thrust) this.drawForce(ctx, sc)
      if (this.data.focusId) this.drawFocusRing(ctx)
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
      const wp = { waterY: wo.waterY, waterDepth: wo.waterDepth, waterTint: wo.waterTint, dBias: p.dBias }

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

      // 每道拱整道出现：不逐段生长，起手从拱心 75% 缩放弹到 100%，0.3 秒到位
      const m = this.ringMesh(i, 1, mask)
      const opt = { waterY: wo.waterY, waterDepth: wo.waterDepth, waterTint: wo.waterTint }
      if (qp < 1) {
        const e = M.easeOutCubic(qp)
        const s = 0.75 + 0.25 * e
        const off = 1 - e
        opt.color = this.hiColor(B.C.arch, off * 0.55)
        opt.bright = 1 + 0.12 * off
        const mat = M.m4Mul(M.m4Translate(0, 0, dz(i)), M.m4ScaleAt([0, B.CY, 0], s))
        R.pushMesh(sc, m, mat, opt)
      } else {
        R.pushMeshT(sc, m, 0, 0, dz(i), opt)
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
   * 资料页「腰铁」一条已注明只画位置、不画真实尺寸。
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
   * 也照放大画。资料页「勾石」一条已注明只画位置。
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
  drawWater(sc, level, t, flood, halfW, camZ, dist, amp) {
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

        const w0 = this.wave(x0, z0, t, speed, amp)
        const w1 = this.wave(x1, z0, t, speed, amp)
        const w2 = this.wave(x1, z1, t, speed, amp)
        const w3 = this.wave(x0, z1, t, speed, amp)
        // 壅水按 z 的**角点值**算，同一行相邻两格共用一条边的两个角，
        // 值必然相同，水面严丝合缝地拼在一起（详见 backwater 的注释）
        const ya = level + backwater(z0, flood)
        const yb = level + backwater(z1, flood)
        // 近岸水浅，透一点让河床露出来；深水处更实。
        const depth = Math.max(0, level - B.groundY(Math.abs(cx)))
        const alpha = 0.44 + 0.20 * Math.min(1, depth / 9)
        // 坡度放缓（/9）、对比收窄（±0.10）：相邻格的 alpha 台阶压到
        // 0.02 上下，格子拼缝就退到可视阈以下；深水饱和值也从 0.72
        // 降到 0.64，深浅水域的交界不再是一刀切的硬边
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

  wave(x, z, t, speed, amp) {
    const A = amp === undefined ? 1 : amp
    const u = t * speed
    return A * (0.09 * Math.sin(x * 0.34 + u * 1.7) +
                0.06 * Math.sin(z * 0.21 - u * 2.2) +
                0.04 * Math.sin((x + z) * 0.55 + u * 3.1))
  },

  /**
   * 主拱倒影 + 顺流微光。近 140 m 的河面占了全景画幅的大半，一块匀色
   * 半透明平面会把空间感全部抹掉；倒影（拱与倒影合成满月，这座桥最
   * 出名的水景）和两条随浪起伏的亮带给水面装上「内容」。
   * 倒影往相机方向拉伸：低角度看水面，像落在桥脚前方的水面上，
   * 拱顶处拉得最长——0.9 倍拱高，正好和拱洞拼成一轮「满月」。
   */
  drawReflections(sc, waterY, flood) {
    if (waterY < -1.2) return
    const sp = flood ? 1 : 0.35
    const N = 14
    // 主拱倒影：近缘贴水面线，远缘按内弧高度向镜头方向拉伸，分 5 段
    // 画。整条带一个 alpha 会把倒影印成一整块边界生硬的深色矩形；
    // 真实倒影是离桥越近越浓、往镜头方向融进水色的，所以按远缘分段
    // 衰减，段与段只差 0.04，拼起来是一道渐变的影
    const zAt = (i, u) => {
      const x = -B.HALF_SPAN + (2 * B.HALF_SPAN * i) / N
      const arch = B.archIntrados(x)
      // 近缘从 z 5.3 起步：贴着桥脚画会被桥身自己挡住（低角度掠射），
      // 前移到桥前开阔水面，"拱+倒影"的画面才立得起来
      return [x, 5.3 + 0.9 * Math.max(0.3, arch - waterY) * u]
    }
    const K = 5
    for (let s = 0; s < K; s++) {
      const u0 = s / K, u1 = (s + 1) / K
      const band = []
      for (let i = 0; i <= N; i++) {
        const p = zAt(i, u0)
        band.push([p[0], waterY - 0.02 + this.wave(p[0], p[1], this.animT, sp) * 0.55, p[1]])
      }
      for (let i = N; i >= 0; i--) {
        const p = zAt(i, u1)
        band.push([p[0], waterY - 0.02 + this.wave(p[0], p[1], this.animT, sp) * 0.55, p[1]])
      }
      R.pushPoly(sc, band, [34, 52, 56],
        { alpha: 0.24 * (1 - 0.78 * (u0 + u1) / 2), noCull: true, dBias: -3 })
    }

    // 顺流的两条微光：水面的方向感全靠它，没有它水面就是一块塑料板
    for (let sg = -1; sg <= 1; sg += 2) {
      const gx = sg * 5.5
      const band = []
      for (let i = 0; i <= 8; i++) {
        const z = -70 + 140 * i / 8
        band.push([gx - 0.8, waterY + 0.02 + this.wave(gx, z, this.animT, sp) * 0.8, z])
      }
      for (let i = 8; i >= 0; i--) {
        const z = -70 + 140 * i / 8
        band.push([gx + 0.8 + sg * 0.5,
          waterY + 0.05 + this.wave(gx + 1.6, z, this.animT, sp) * 0.8, z])
      }
      R.pushPoly(sc, band, [210, 222, 214], { alpha: 0.17, noCull: true, dBias: -2 })
    }
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

  // ==================== 泄洪档位动画 ====================

  /**
   * 洞内流线：主拱洞与小拱洞里顺着水流方向的短划线 + 一枚箭头。
   *
   * 线的数量随档位加密——枯水主拱一条，外侧两孔起三条，四孔全开五条；
   * 相位随洞内流速推进，"线多了、跑快了"就是洪水的进程，不用读数。
   *
   * 不用 canvas 的 setLineDash：这些线要走画家算法的 3D 队列，在桥洞里
   * 才会被桥身正确遮挡。所以把线切成短段，段位随时间向下游平移——
   * 段长 1.05 m、周期 1.7 m，相位取模，速度跟洞内流速 v 走。
   */
  drawStreamlines(sc, level, ev, t, band) {
    const v = ev.open.v
    const inten = clamp(0.42 + v * 0.10, 0.42, 0.85)
    const xs = band >= 2 ? [-12, -6, 0, 6, 12] : band >= 1 ? [-9, 0, 9] : [0]
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i]
      const bands = wetBands(x, level)
      if (!bands.length) continue
      const y = Math.min(level - 0.35, bands[0][1] - 0.22)
      if (y <= bands[0][0] + 0.12) continue
      this.dashLine(sc, x, y, -9.5, 9.5, t, v, inten)
    }
    // 小拱洞：外侧那对（band ≥ 1）与内侧那对（band = 2）
    for (let i = 0; i < B.SMALL.length; i++) {
      const s = B.SMALL[i]
      const open = s.key === 'outer' ? band >= 1 : band >= 2
      if (!open || level <= s.spring + 0.15) continue
      const top = B.smallIntrados(s, s.xc)
      const bot = B.haunchTop(s.xc)
      const y = Math.min(level - 0.30, top - 0.20)
      if (y <= bot + 0.12) continue
      for (let sg = -1; sg <= 1; sg += 2) {
        this.dashLine(sc, sg * s.xc, y, -3.4, 3.4, t, v, inten)
      }
    }
  },

  /** 一条沿 z 的 dash 流线 + 中腰一枚指向下游（-z）的箭头 */
  dashLine(sc, x, y, z0, z1, t, v, inten) {
    const per = 1.7, seg = 1.05
    let start = z1 - ((t * (1.2 + v * 0.55)) % per + per) % per
    while (start > z0) {
      const a = Math.max(z0, start - seg)
      if (start < z1) {
        R.pushSegment(sc, x, y, start, x, y, a, 0.34, 236, 246, 252, 0.62 * inten)
      }
      start -= per
    }
    const zm = (z0 + z1) / 2
    R.pushTri(sc,
      [x, y, zm - 0.85], [x, y + 0.26, zm + 0.30], [x, y - 0.26, zm + 0.30],
      236, 246, 252, Math.min(1, 0.55 * inten + 0.15))
  },

  /**
   * 出口涟漪：水从洞口涌出，在水面上留下一圈圈扩散的环。
   * 三圈错相、透明度随半径衰减；环抬到水面之上 5 cm——压在水面以下
   * 会被半透明的水面盖掉一半。组数随档位走：外侧两孔起主拱洞与外侧
   * 小拱各出涟漪，四孔全开加内侧小拱，洪峰（水位 6.2 m 以上）再补
   * 桥台迎水面的激荡。
   */
  drawRipples(sc, level, t, band) {
    if (band < 1) return
    const spots = []
    for (let sg = -1; sg <= 1; sg += 2) {
      spots.push([sg * B.SMALL[1].xc, 5.6])   // 外侧小拱出口
      spots.push([sg * 11, 5.6])              // 主拱洞出口涡区
    }
    if (band >= 2) {
      for (let sg = -1; sg <= 1; sg += 2) spots.push([sg * B.SMALL[0].xc, 5.6])
    }
    const peak = level > 6.2
    if (peak) {
      for (let sg = -1; sg <= 1; sg += 2) {
        spots.push([sg * 21.2, 6.3], [sg * 16.2, 6.3])   // 桥台迎水面激荡
      }
    }
    for (let i = 0; i < spots.length; i++) {
      for (let k = 0; k < 3; k++) {
        const u = (t * (0.55 + (i % 3) * 0.05) + k / 3 + i * 0.17) % 1
        const r = 0.45 + u * 2.3
        const a = 0.36 * (1 - u) * (peak ? 1.15 : 1)
        if (a < 0.03) continue
        this.ring(sc, spots[i][0], level + 0.05, spots[i][1], r, r * 0.82, a)
      }
    }
  },

  /** 水面上的一圈涟漪：12 段细线围成椭圆（z 向压扁 0.82 顺流向拉长感） */
  ring(sc, cx, cy, cz, rx, rz, alpha) {
    const n = 12
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2
      R.pushSegment(sc,
        cx + rx * Math.cos(a0), cy, cz + rz * Math.sin(a0),
        cx + rx * Math.cos(a1), cy, cz + rz * Math.sin(a1),
        0.26, 242, 250, 255, alpha)
    }
  },

  /** 聚焦部位的高亮圈：锚点投影处两道脉冲圆环，朱红，2D 层压在最后 */
  drawFocusRing(ctx) {
    let part = null
    for (let i = 0; i < PARTS.length; i++) {
      if (PARTS[i].id === this.data.focusId) { part = PARTS[i]; break }
    }
    if (!part) return
    const pr = R.project(this.scene, part.hit[0], part.hit[1], part.hit[2])
    if (!pr) return
    const pu = 0.5 + 0.5 * Math.sin(this.animT * 3.1)
    ctx.strokeStyle = 'rgba(196,86,58,0.95)'
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.arc(pr[0], pr[1], 17 + 4 * pu, 0, Math.PI * 2); ctx.stroke()
    ctx.strokeStyle = 'rgba(196,86,58,0.4)'
    ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.arc(pr[0], pr[1], 26 + 5 * pu, 0, Math.PI * 2); ctx.stroke()
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
   * 拱脚那一支要长到画外去，而且这里也没有算桥体自重下的真实推力，
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


    // 马车动载：荷载箭头跟着车走
    const cx = this.cartX
    if (cx !== 0 || this.cartDir !== 1) {
      const cy = B.deckTop(cx)
      const a = pr(cx, cy + 4.6, zf), b = pr(cx, cy + 0.7, zf)
      if (a && b) {
        this.arrow2(ctx, a, b, 3.2, 'rgba(220,80,40,0.95)')
        const lx = pr(cx, cy + 5.3, zf)
        if (lx) { ctx.fillStyle = 'rgba(220,80,40,0.95)'; ctx.fillText('活载', lx[0], lx[1]) }
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

    // 拆解时给摊开的券加说明。三样横向联系各点一句：腰铁咬的是**一道券
    // 自己**的券石，铁拉杆和勾石管的才是券与券之间——摊开来看才分得清
    if (this._ex > 0.25) {
      // 三句摞在拱顶上方。锚点抬到 RISE + 6.4：三枚牌子竖着要 44 px，
      // 抬低了最下面那枚就压在摊开的券上
      const a0 = pr(0, B.RISE + 6.4, 0)
      if (a0) {
        this.tag(ctx, a0[0], a0[1] - 10,
          '28 道券，每道独立成拱', '#fdf6ec', 'rgba(158,62,40,0.88)')
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

    ctx.textAlign = 'left'
    ctx.font = 'bold 14px sans-serif'
    ctx.fillStyle = '#8e3b26'
    ctx.fillText('纵剖面', x0 + 18, y0 + 21)
    ctx.font = '10px sans-serif'
    ctx.fillStyle = 'rgba(70,58,44,0.5)'
    ctx.fillText('沿桥长剖开，宽度方向取桥中线', x0 + 68, y0 + 21)

    // 卡片以内为界。地面那类多边形为了闭合要一直延伸到画幅之外，
    // 不裁就会糊到后面的 3D 场景上
    ctx.save()
    this.roundRect(ctx, x0, y0, x1 - x0, y1 - y0, 14)
    ctx.clip()
    ctx.strokeStyle = 'rgba(158,132,96,0.5)'
    ctx.lineWidth = 1
    this.roundRect(ctx, x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1, 14)
    ctx.stroke()

    // 版式。两块画幅按卡片实际高度分，不写死像素——小屏（812 高）上
    // 卡片只有三百出头，写死就把下面那张大样挤出卡片了。
    // 90 = 抬头 36 + 图注两行与标题 44 + 底边留白 10，剩下的才是两张图。
    const avail = y1 - y0
    const rest = avail - 90
    const fH = rest * 0.44
    const iH = rest * 0.56

    // ---- 全桥 ----
    const fTop = y0 + 36
    const mpF = this.secMap(-27.6, 27.6, -3.9, 10.6, x0 + 18, x1 - 18, fTop, fTop + fH)
    this.secProfile(ctx, mpF, PAPER)
    this.secDimFull(ctx, mpF, RED, PAPER)

    // ---- 两行图注。数字写在这里而不是塞进图上：全桥那张横向只有
    //      6.6 px/m，小拱的洞不到 20 px 宽，洞里头放不下字 ----
    const capY = fTop + fH + 10
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillStyle = 'rgba(70,58,44,0.74)'
    ctx.fillText('拱肩小拱 ×4：每端两个，内孔净跨 2.85 m、外孔 3.81 m，两端对称', x0 + 20, capY)
    ctx.fillStyle = 'rgba(70,58,44,0.5)'
    ctx.fillText('主拱 28 道拱券并列砌筑，券厚 1.03 m；矢跨比 1 : 5.12，圆心角 84°', x0 + 20, capY + 15)

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
    const mpI = this.secMap(-26.5, -18.51, -4.0, 2.2, x0 + 74, x1 - 18, iTop + 14, iTop + iH)
    this.secProfile(ctx, mpI, PAPER)
    this.secDimInset(ctx, mpI, RED, PAPER)

    ctx.restore()
    ctx.restore()
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
   * 一张剖面的石作部分。全桥和桥台大样共用这一份画法——大样只是换了个
   * map，几何一模一样，两张图不会出现对不上的地方。
   *
   * 画的次序就是砌的次序：先铺土，再桥台与基础，再拱券与护拱石，
   * 再拱肩侧墙，然后把四个小拱的洞凿出来，最后铺桥面、勒地面线。
   */
  secProfile(ctx, mp, paper) {
    const P = mp.p
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
    ctx.beginPath()
    let q = P(XL, B.groundY(Math.abs(XL)))
    ctx.moveTo(q[0], q[1])
    for (let i = 1; i <= 90; i++) {
      const x = XL + (XR - XL) * (i / 90)
      q = P(x, B.groundY(Math.abs(x)))
      ctx.lineTo(q[0], q[1])
    }
    // 收在画幅自己的底边上，不是卡片底边：两块画幅上下相邻，
    // 土要是一直铺到卡片底，下面那张大样和图注就全埋在土里了
    q = P(XR, mp.wy0); ctx.lineTo(q[0], q[1])
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

    // ---- 护拱石。券背外面又贴的那一层，上边界就是拱背 ----
    const NH = 48
    ctx.beginPath()
    let f = true
    for (let i = 0; i <= NH; i++) {
      const x = -B.HALF_SPAN + 2 * B.HALF_SPAN * (i / NH)
      const p = P(x, B.archExtrados(x))
      if (f) { ctx.moveTo(p[0], p[1]); f = false } else ctx.lineTo(p[0], p[1])
    }
    for (let i = NH; i >= 0; i--) {
      const x = -B.HALF_SPAN + 2 * B.HALF_SPAN * (i / NH)
      const p = P(x, B.haunchTop(x))
      ctx.lineTo(p[0], p[1])
    }
    ctx.closePath()
    ctx.fillStyle = '#bcb19d'
    ctx.fill()
    ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.stroke()

    // ---- 主拱券 ----
    ctx.beginPath()
    f = true
    for (let i = 0; i <= NH; i++) {
      const x = -B.HALF_SPAN + 2 * B.HALF_SPAN * (i / NH)
      const p = P(x, B.archIntrados(x))
      if (f) { ctx.moveTo(p[0], p[1]); f = false } else ctx.lineTo(p[0], p[1])
    }
    for (let i = NH; i >= 0; i--) {
      const x = -B.HALF_SPAN + 2 * B.HALF_SPAN * (i / NH)
      const p = P(x, B.archExtrados(x))
      ctx.lineTo(p[0], p[1])
    }
    ctx.closePath()
    ctx.fillStyle = '#9aa4aa'
    ctx.fill()
    ctx.strokeStyle = 'rgba(50,60,68,0.75)'; ctx.lineWidth = 1; ctx.stroke()

    // ---- 拱肩侧墙。下边界跟着拱背走，到桥台段落在起拱线上，
    //      再往外顺岸坡爬上去；上边界就是桥面底 ----
    const NW = 220
    ctx.beginPath()
    f = true
    for (let i = 0; i <= NW; i++) {
      const x = -B.DECK_HALF + 2 * B.DECK_HALF * (i / NW)
      const p = P(x, B.wallBottom(x))
      if (f) { ctx.moveTo(p[0], p[1]); f = false } else ctx.lineTo(p[0], p[1])
    }
    for (let i = NW; i >= 0; i--) {
      const x = -B.DECK_HALF + 2 * B.DECK_HALF * (i / NW)
      const p = P(x, B.deckBottom(x))
      ctx.lineTo(p[0], p[1])
    }
    ctx.closePath()
    ctx.fillStyle = '#c3bcac'
    ctx.fill()
    ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.stroke()

    // ---- 凿出四个小拱。下边界是拱背（起拱线本来就取在拱背上），上边界是
    //      券脸；凿完之后，剩下那圈石料里自然就含着券自己的厚度 ----
    for (let k = 0; k < B.SMALL.length; k++) {
      const sm = B.SMALL[k]
      for (let sg = -1; sg <= 1; sg += 2) {
        const NC = 20
        ctx.beginPath()
        for (let i = 0; i <= NC; i++) {
          const x = sg * (sm.x0 + (sm.x1 - sm.x0) * (i / NC))
          const p = P(x, B.haunchTop(x))
          if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1])
        }
        for (let i = NC; i >= 0; i--) {
          const x = sg * (sm.x0 + (sm.x1 - sm.x0) * (i / NC))
          const p = P(x, B.smallIntrados(sm, x))
          ctx.lineTo(p[0], p[1])
        }
        ctx.closePath()
        ctx.fillStyle = paper
        ctx.fill()
        ctx.strokeStyle = 'rgba(50,60,68,0.7)'
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }

    // ---- 桥面 ----
    const ND = 64
    ctx.beginPath()
    f = true
    for (let i = 0; i <= ND; i++) {
      const x = -B.DECK_HALF + 2 * B.DECK_HALF * (i / ND)
      const p = P(x, B.deckTop(x))
      if (f) { ctx.moveTo(p[0], p[1]); f = false } else ctx.lineTo(p[0], p[1])
    }
    for (let i = ND; i >= 0; i--) {
      const x = -B.DECK_HALF + 2 * B.DECK_HALF * (i / ND)
      const p = P(x, B.deckBottom(x))
      ctx.lineTo(p[0], p[1])
    }
    ctx.closePath()
    ctx.fillStyle = '#cfc9bb'
    ctx.fill()
    ctx.strokeStyle = 'rgba(64,54,42,0.75)'; ctx.lineWidth = 1; ctx.stroke()

    // ---- 栏板望柱。它们立在桥面两侧，中线剖面上本来照不见，按制图习惯
    //      补一道浅色可见轮廓，顺带把 21 块栏板的缝也勒出来 ----
    const rTop = function (x) { return B.deckTop(x) + 0.95 }
    ctx.beginPath()
    f = true
    for (let i = 0; i <= ND; i++) {
      const x = -B.DECK_HALF + 2 * B.DECK_HALF * (i / ND)
      const p = P(x, B.deckTop(x))
      if (f) { ctx.moveTo(p[0], p[1]); f = false } else ctx.lineTo(p[0], p[1])
    }
    for (let i = ND; i >= 0; i--) {
      const x = -B.DECK_HALF + 2 * B.DECK_HALF * (i / ND)
      const p = P(x, rTop(x))
      ctx.lineTo(p[0], p[1])
    }
    ctx.closePath()
    ctx.fillStyle = 'rgba(196,188,174,0.9)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(64,54,42,0.5)'; ctx.lineWidth = 1; ctx.stroke()
    ctx.strokeStyle = 'rgba(64,54,42,0.24)'
    ctx.beginPath()
    for (let i = 1; i < B.RAIL_PANEL; i++) {
      const x = -B.DECK_HALF + 2 * B.DECK_HALF * (i / B.RAIL_PANEL)
      const a = P(x, B.deckTop(x)), b = P(x, rTop(x))
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1])
    }
    ctx.stroke()

    // ---- 地面线摆在最后：制图习惯上地面线要一路穿过去，埋在地下的
    //      桥台和基础也照穿，"埋多深"这才读得出来 ----
    ctx.strokeStyle = 'rgba(120,100,70,0.62)'
    ctx.lineWidth = 1
    ctx.beginPath()
    f = true
    for (let i = 0; i <= 90; i++) {
      const x = XL + (XR - XL) * (i / 90)
      const p = P(x, B.groundY(Math.abs(x)))
      if (f) { ctx.moveTo(p[0], p[1]); f = false } else ctx.lineTo(p[0], p[1])
    }
    ctx.stroke()

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
      '净跨 37.02 m', color, paper, -7.5, 1.15)

    // 矢高。竖直那条线落在 x = 0，字压在线中间
    this.secDim(ctx, mp, 0, 0, 0, B.RISE, '矢高 7.23 m', color, paper)
  },

  /** 桥台大样的尺寸 */
  secDimInset(ctx, mp, color, paper) {
    ctx.font = '10px sans-serif'
    ctx.textBaseline = 'middle'
    const fBot = B.ABUT_BOT - B.FOUND_N * B.FOUND_T

    // 台身。尺寸线走在台顶之上、拱背之下那条空档里
    this.secDim(ctx, mp, -B.ABUT_X1, 0.32, -B.ABUT_X0, 0.32, '台身 5.0 m', color, paper)

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
    ctx.fillText('28 道拱券并列砌筑', x0, y0 - 15)
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
      // 洪水过程播放中把呈现流量回写滑块与档位尺：水面在脉冲，
      // 读数卡、滑块、{{q}} 文本三处说的始终是同一个数，
      // 尺的点亮跟着脉冲爬升而不是停在旧档
      let qShown = this.data.q
      if (this.data.autoFlood) {
        qShown = Math.round(this.st.q)
        if (qShown !== this.data.q) d.q = qShown
      }
      // 此刻落在水量尺的第几档。档位界线就是那两个临界流量，
      // 和 BANDS 用同一对数，尺上和卡上的说法不会打架
      const bd = this.bandsAt(qShown)
      if (bd !== this.data.band) d.band = bd

      const ev = H.evaluate(this.st.q)
      const o = ev.open, s = ev.solid
      const ro = {
        h: o.h.toFixed(2),
        area: o.area.toFixed(0),
        v: o.v.toFixed(2),
        force: o.force.toFixed(0),
        backwater: o.backwater.toFixed(2),
        pMax: o.pMax.toFixed(0)
      }
      if (JSON.stringify(ro) !== JSON.stringify(this.data.readout)) d.readout = ro
      const df = {
        forcePct: s.force > 1 ? ((1 - o.force / s.force) * 100).toFixed(1) : '0.0',
        areaPct: s.area > 1 ? ((o.area / s.area - 1) * 100).toFixed(1) : '0.0',
        hDown: (s.h - o.h).toFixed(2)
      }
      if (JSON.stringify(df) !== JSON.stringify(this.data.diff)) d.diff = df
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
    if (Object.keys(d).length) this.setData(d)
  },

  // ==================== 交互 ====================

  onTouchStart(e) {
    this.anim = null
    // 新手势接管：上一把的惯性停掉，速度采样归零重来
    this.spin = null
    this.vyaw = 0
    this.vpitch = 0
    this.moveAt = 0
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
      // tap 判定：按下位置与时刻记下来，onTouchEnd 里没怎么动才算点
      this.tap0 = { x: ts[0].x, y: ts[0].y, at: Date.now() }
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
    // 采手指角速度给惯性用：单帧差分噪声大，掺三成上一帧的值抹平
    const now = Date.now()
    if (this.moveAt) {
      const mdt = Math.max(0.008, (now - this.moveAt) / 1000)
      const ivy = (-(ts[0].x - this.lastX) * 0.006) / mdt
      const ivp = ((ts[0].y - this.lastY) * 0.005) / mdt
      this.vyaw = 0.7 * this.vyaw + 0.3 * ivy
      this.vpitch = 0.7 * this.vpitch + 0.3 * ivp
    }
    this.lastX = ts[0].x
    this.lastY = ts[0].y
    this.moveAt = now
  },

  onTouchEnd(e) {
    // 轻点 = 没怎么移动、也没按多久：落到部位锚点附近就聚焦，点空了收掉
    const t0 = this.tap0
    this.pt = null; this.pinch0 = 0; this.tap0 = null
    // 松手惯性：手指 90 ms 内还在动就把角速度带进 tick，上限压住别甩过头
    if (this.moveAt && Date.now() - this.moveAt < 90) {
      const vy = clamp(this.vyaw, -2.4, 2.4)
      const vp = clamp(this.vpitch, -2.4, 2.4)
      if (Math.abs(vy) > 0.15 || Math.abs(vp) > 0.15) {
        this.spin = { vyaw: vy, vpitch: vp }
      }
    }
    if (!t0 || !e || !e.changedTouches || !e.changedTouches.length) return
    const tt = e.changedTouches[0]
    const dx = tt.x - t0.x, dy = tt.y - t0.y
    if (dx * dx + dy * dy > 81 || Date.now() - t0.at > 420) return
    this.pickPart(tt.x, tt.y)
  },

  touchDist(ts) {
    const dx = ts[0].x - ts[1].x, dy = ts[0].y - ts[1].y
    return Math.sqrt(dx * dx + dy * dy)
  },

  /**
   * 点选部位。锚点投到屏幕后取 40 px 内最近者——两枚对称部位各自投影，
   * 点哪头飞哪头。点空处则收掉聚焦卡，相当于教学页里的 Esc。
   * build 模式下还没砌出来的部位不参与拾取（minT 是它落位的时刻）。
   */
  pickPart(px, py) {
    if (this.data.sec || this.data.quizOpen || this.data.srcOpen || this.data.tour !== null) return
    const sc = this.scene
    if (!sc || !sc.vp) return
    let best = null, bd = 1e9
    for (let i = 0; i < PARTS.length; i++) {
      const p = PARTS[i]
      if (this.data.mode === 'build' && this.st.t < p.minT) continue
      const s = R.project(sc, p.hit[0], p.hit[1], p.hit[2])
      if (!s) continue
      const dx = s[0] - px, dy = s[1] - py
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < 40 && d < bd) { bd = d; best = p }
    }
    if (!best) {
      if (this.data.focusId) this.setData({ focus: null, focusId: null })
      return
    }
    const c = this.cam
    this.anim = {
      t: 0,
      from: { yaw: c.yaw, pitch: c.pitch, zoom: c.zoom, tx: c.tx, ty: c.ty, tz: c.tz },
      to: best.cam
    }
    this.setData({
      focus: { name: best.name, l1: best.l1, l2: best.l2 },
      focusId: best.id
    })
  },

  onFocusClose() { this.setData({ focus: null, focusId: null }) },

  // ==================== 说课导览 ====================

  onTourOpen() {
    this.setData({ tour: 0, playing: false, sec: false, srcOpen: false, focus: null, focusId: null })
    this.applyTourStep(0)
  },

  onTourNext() {
    const next = this.data.tour + 1
    if (next >= TOUR.length) { this.onTourExit(); return }
    this.setData({ tour: next })
    this.applyTourStep(next)
  },

  onTourPrev() {
    if (this.data.tour <= 0) return
    const prev = this.data.tour - 1
    this.setData({ tour: prev })
    this.applyTourStep(prev)
  },

  onTourExit() { this.setData({ tour: null }) },

  /** 第 i 步：可选开关先归零，再按该步落模式、档位与机位 */
  applyTourStep(i) {
    const s = TOUR[i]
    const d = {
      tourIdx: i, tourName: s.name, tourText: s.text,
      playing: false, flat: false, thrust: false, split: false,
      autoFlood: false, sec: false, srcOpen: false
    }
    if (s.data) for (const k in s.data) d[k] = s.data[k]
    if (s.t !== undefined) this.st.t = s.t
    if (s.q !== undefined) { d.q = s.q; d.band = this.bandsAt(s.q) }
    if (s.split) {
      d.split = true
      this.st.t = B.TOTAL
      const c = this.cam
      this.anim = {
        t: 0,
        from: { yaw: c.yaw, pitch: c.pitch, zoom: c.zoom, tx: c.tx, ty: c.ty, tz: c.tz },
        // 与 onToggleSplit 同一机位：28 道券沿桥宽摊开，得转到侧向看
        to: { yaw: 0.75, pitch: 0.12, zoom: 0.36, tx: 0, ty: 4.0, tz: 0 }
      }
      d.view = 'free'
    } else if (s.view) {
      this.applyView(s.view)
    }
    this.setData(d)
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
      // 泄洪只有敞肩态：营造页若开过实肩对照，切回来要重置，否则小拱被实肩填死
      this.setData({ mode, playing: false, open: true, focus: null, focusId: null })
      // 泄洪的机位只剩全景和小拱两档了，进屋就落在全景；
      // 上一轮已经停在某一档（比如「小拱」）就别再动镜头
      if (this.data.view !== 'full' && this.data.view !== 'small') {
        this.applyView('full')
      }
    } else {
      this.st.t = 0
      this.setData({ mode, playing: true, focus: null, focusId: null })
      this.applyView('build')
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
    // 只记目标值：水面呈现值 st.q 在 tick 里缓动跟上来，不瞬移
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
    // 目标值交给 tick 缓动：跳档瞬间水面从当前位置涨落过去
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
  onQuizOpen() {
    this.setData({ quizOpen: true, quizIdx: 0, quizPick: null, quizDone: false, sec: false, srcOpen: false, tour: null })
  },
  onQuizClose() { this.setData({ quizOpen: false }) },
  onQuizPick(e) {
    if (this.data.quizPick !== null) return
    const i = +e.currentTarget.dataset.i
    this.setData({ quizPick: i })
  },
  onQuizNext() {
    if (this.data.quizIdx + 1 < QUIZ.length) {
      this.setData({ quizIdx: this.data.quizIdx + 1, quizPick: null })
    } else {
      this.setData({ quizDone: true })
    }
  },
  onQuizRestart() { this.setData({ quizIdx: 0, quizPick: null, quizDone: false }) },

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
        //   机位要转到接近侧向（yaw 0.68，39°）：28 道券是沿桥宽方向
        //   摊开的，正面看它们几乎重合，摊开也只是一片密排的横线。
        //   转过来才看得出是一道道**各自独立**的拱券。yaw 不给到 1.0：
        //   ±1.0 的视线正好从东岸大树（±36,21）/（±40,-23）的冠心里穿过
        //   去；0.75-0.80 时近岸坡树群（x≈±32，z 6~45）的八面体冠以 32 m
        //   的真实深度压在 70 m 外的水面上，冠沿在深蓝水面上像一块悬空
        //   的绿贴图。0.68 把冠沿整个挪进右下的岸地里，树冠落在地平线
        //   上，物理和视觉就都顺了。pitch 抬到 0.22：脚下贴脸的湿滩涂
        //   退出主画幅，扇形展开仍保留八成半宽
        to: { yaw: 0.68, pitch: 0.22, zoom: 0.36, tx: 0, ty: 4.0, tz: 0 }
      }
    } else {
      // 合拢回到营造机位：和建造初始同一视角，券层层次仍在，
      // 不会又跳回正面把 28 道券叠成一团
      this.applyView('build')
    }
  }
})
