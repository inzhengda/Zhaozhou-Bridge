#!/usr/bin/env node
/**
 * 离屏出图：在 Node 里**原样跑 pages/index/index.js 的 draw()**，
 * 输出 SVG，再用无头 Chrome 转成 PNG 供人眼验收。
 *
 * 为什么值得存在：改一次渲染器要切微信开发者工具、等模拟器、再看，
 * 一轮十几秒，而且没法一次出六个角度对比着挑。这个脚本把那一轮压成
 * 一条命令，出来的还是矢量图——说课 PPT 里用比截屏清晰得多。
 *
 * 关键点是**不复制绘图代码**。bridge.js / mesh.js / renderer.js / mat4.js /
 * hydro.js 全是 CommonJS 且不碰 wx.*，所以可以直接 require；页面本身也只要
 * 把全局 Page / wx stub 掉就能加载。于是离屏图和真机图共用同一份 draw()，
 * 不存在"离线一套、线上另一套"的漂移。
 *
 * 用法：
 *   node tools/render.js                  # 出全部镜头
 *   node tools/render.js --only=flood     # 只出名字里带 flood 的
 *   node tools/render.js --scale=2        # 2 倍分辨率
 *   node tools/render.js --list           # 列出镜头名
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { SvgContext } = require('./ctx-svg.js')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(__dirname, 'out')

// ---------------------------------------------------------------------------
// 小程序全局 stub。必须在 require 页面**之前**装好。
// ---------------------------------------------------------------------------
let OPTIONS = null
global.Page = (o) => { OPTIONS = o }
global.wx = {
  getWindowInfo: () => ({ pixelRatio: 2, statusBarHeight: 44, windowWidth: 430, windowHeight: 900 }),
  getSystemInfoSync: () => ({ pixelRatio: 2, statusBarHeight: 44 }),
  getMenuButtonBoundingClientRect: () => ({ width: 87, height: 32, top: 52, bottom: 84, left: 320, right: 407 }),
  createSelectorQuery: () => ({ select: () => ({ fields: () => ({ exec: () => {} }) }) })
}

const B = require(path.join(ROOT, 'utils/bridge.js'))
const R = require(path.join(ROOT, 'utils/renderer.js'))
require(path.join(ROOT, 'pages/index/index.js'))

if (!OPTIONS) {
  console.error('页面没注册上：index.js 里没找到 Page(...) 调用')
  process.exit(1)
}

// 机位预设。与 index.js:69 的 VIEWS 保持一致——离屏图要和真机取景对得上，
// 否则验收就失去意义了。改那边记得改这边。
const VIEWS = {
  full: { yaw: 0.035, pitch: 0.050, zoom: 0.62, t: [0, 3.4, 0] },
  side: { yaw: 0.02, pitch: 0.045, zoom: 0.55, t: [0, 3.6, 0] },
  under: { yaw: 0.10, pitch: -0.030, zoom: 0.27, t: [0, 4.6, 0] },
  small: { yaw: 0.20, pitch: 0.03, zoom: 0.15, t: [15.5, 5.6, 0] }
}

const Q_MIN = 150
const Q_DEF = 900

/**
 * 造一个"已经 onLoad + onReady 完"的页面实例。
 *
 * 之所以能这么干：OPTIONS 上的方法都是普通函数，Object.assign 复制过来之后
 * this 指向副本，和真机上挂到页面实例上是一回事。要补的只是 onLoad/onReady
 * 里那几行初始化——把它们照抄一遍，而不是去调 onReady（那条路要走
 * wx.createSelectorQuery 的回调，绕）。
 */
function makePage({ w, h, data, view, cam, detail }) {
  const page = Object.assign({}, OPTIONS)

  page.data = Object.assign({}, OPTIONS.data, data || {})
  page.data.ringTicks = OPTIONS.data.ringTicks.slice()
  page.setData = (o) => Object.assign(page.data, o)

  page.cw = w
  page.ch = h
  page.ctx = new SvgContext(w, h)
  page.scene = R.createScene()

  // setDetail 是有状态的：不显式设一次，上一张图的精度会漏给下一张
  B.setDetail(!!detail)
  page.bs = B.buildScene()
  page.static = { terrain: page.bs.terrain, scenery: page.bs.scenery }

  // ---- onLoad 那几行 ----
  page.st = { t: 0, q: Q_DEF }
  const v = VIEWS[view || 'full']
  page.cam = { yaw: v.yaw, pitch: v.pitch, zoom: v.zoom, tx: v.t[0], ty: v.t[1], tz: v.t[2] }
  if (cam) Object.assign(page.cam, cam)
  page.running = true
  page.last = 0
  page.hudAt = 0
  page.floodT = 0
  page.rc = []
  page.rcN = 0
  page.colCache = {}
  page.detailOn = !!detail
  page.ex = page.data.split ? 1 : 0
  page._ex = page.ex
  page._ready = true

  page.initParticles()
  return page
}

// ---------------------------------------------------------------------------
// 镜头表
// ---------------------------------------------------------------------------
const BUILT = B.TOTAL          // 营造完成的时刻
const W = 430, H = 900         // 与模拟器 iPhone 12/13 一致

const SHOTS = [
  { name: 'build-full', note: '营造完成 · 全景', view: 'full', detail: true, data: { mode: 'build', anno: true }, t: BUILT },
  { name: 'build-side', note: '营造完成 · 正视', view: 'side', detail: true, data: { mode: 'build', anno: true }, t: BUILT },
  { name: 'build-under', note: '拱下仰视', view: 'under', detail: true, data: { mode: 'build', anno: true }, t: BUILT },
  { name: 'build-small', note: '小拱特写', view: 'small', detail: true, data: { mode: 'build', anno: true }, t: BUILT },
  // 斜 45° 俯视：面深度排序问题最容易在这种角度暴露（桥面断片、洞被填死）
  { name: 'diag', note: '斜视角 · 桥面完整性检查', detail: true, data: { mode: 'build', anno: false }, t: BUILT,
    cam: { yaw: 0.62, pitch: 0.16, zoom: 0.30, tx: 0, ty: 3.6, tz: 0 } },
  { name: 'build-mid', note: '营造中 · 砌到第 14 道券', view: 'side', detail: true, data: { mode: 'build', anno: true }, t: 9.0 },
  { name: 'build-flat', note: '坦拱对照', view: 'full', detail: true, data: { mode: 'build', flat: true, anno: true }, t: BUILT },
  // 拆解那一张必须转到侧向才看得见——券是沿桥宽摊开的，正面看几乎重合。
  // 这个机位抄的是 onToggleSplit 里那段动画的终点（index.js:2306）
  {
    name: 'split', note: '拆解 28 券', detail: true,
    data: { mode: 'build', split: true, anno: false }, t: BUILT, split: 1,
    cam: { yaw: 1.00, pitch: 0.12, zoom: 0.36, tx: 0, ty: 4.0, tz: 0 }
  },
  { name: 'flood-900', note: '泄洪 q=900 · 外侧两孔过水', view: 'full', detail: true, data: { mode: 'flood', q: 900 }, t: BUILT },
  { name: 'flood-1300', note: '泄洪 q=1300 · 四孔全开', view: 'full', detail: true, data: { mode: 'flood', q: 1300 }, t: BUILT },
  { name: 'flood-small', note: '泄洪 · 小拱过水特写', view: 'small', detail: true, data: { mode: 'flood', q: 1150 }, t: BUILT },
  { name: 'thrust', note: '受力 · 沿拱轴传力', view: 'side', detail: true, data: { mode: 'flood', q: 900, thrust: true }, t: BUILT },
  { name: 'sec-long', note: '剖面图 · 纵剖面', view: 'full', detail: true, data: { mode: 'flood', q: 900, sec: true, secTab: 'long' }, t: BUILT },
  { name: 'sec-cross', note: '剖面图 · 横剖面', view: 'full', detail: true, data: { mode: 'flood', q: 900, sec: true, secTab: 'cross' }, t: BUILT },
  { name: 'sec-area', note: '剖面图 · 过水断面', view: 'full', detail: true, data: { mode: 'flood', q: 900, sec: true, secTab: 'area' }, t: BUILT },
  { name: 'sec-area-max', note: '剖面图 · 过水断面 q=1300', view: 'full', detail: true, data: { mode: 'flood', q: 1300, sec: true, secTab: 'area' }, t: BUILT },
  { name: 'sec-rings', note: '剖面图 · 拱券分解', view: 'full', detail: true, data: { mode: 'flood', q: 900, sec: true, secTab: 'rings' }, t: BUILT },
  { name: 'sec-span', note: '剖面图 · 敞肩对照', view: 'full', detail: true, data: { mode: 'flood', q: 900, sec: true, secTab: 'span' }, t: BUILT },
  { name: 'sec-found', note: '剖面图 · 桥台基础', view: 'full', detail: true, data: { mode: 'flood', q: 900, sec: true, secTab: 'found' }, t: BUILT }
]

// ---------------------------------------------------------------------------
// SVG → PNG（无头 Chrome）
// ---------------------------------------------------------------------------
const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].find((p) => fs.existsSync(p))

function toPng(svgPath, pngPath, w, h, scale) {
  execFileSync(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-sandbox',
    `--force-device-scale-factor=${scale}`,
    `--window-size=${w},${h}`,
    `--screenshot=${pngPath}`,
    'file://' + svgPath
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2)
  const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7)
  const scale = parseFloat((args.find((a) => a.startsWith('--scale=')) || '').slice(8)) || 1
  const noOutline = args.includes('--no-outline')
  const noPrefix = args.includes('--plain') ? '' : (noOutline ? 'noout-' : '')
  if (R.setOutline) R.setOutline(!noOutline)

  if (args.includes('--list')) {
    for (const s of SHOTS) console.log(`${s.name.padEnd(16)} ${s.note}`)
    return
  }

  if (!CHROME) {
    console.error('找不到 Chrome / Chromium，没法把 SVG 转成 PNG。只写 SVG 也行，但没法看图。')
    process.exit(1)
  }
  fs.mkdirSync(OUT, { recursive: true })

  const shots = only ? SHOTS.filter((s) => s.name.includes(only)) : SHOTS
  if (!shots.length) {
    console.error(`没有名字匹配 "${only}" 的镜头。--list 看全部。`)
    process.exit(1)
  }

  for (const shot of shots) {
    const t0 = Date.now()
    const page = makePage({
      w: W, h: H, view: shot.view, cam: shot.cam, detail: shot.detail, data: shot.data
    })
    page.st.t = shot.t === undefined ? BUILT : shot.t
    if (shot.split !== undefined) { page.ex = shot.split; page._ex = shot.split }

    page.draw(0.016)

    const svgPath = path.join(OUT, `${noPrefix}${shot.name}.svg`)
    const pngPath = path.join(OUT, `${noPrefix}${shot.name}.png`)
    const svg = page.ctx.toSVG()
    fs.writeFileSync(svgPath, svg)
    toPng(svgPath, pngPath, W, H, scale)

    const faces = page.scene.stats || { faces: 0, drawn: 0, culled: 0, clipped: 0 }
    console.log(
      `${shot.name.padEnd(16)} ${shot.note.padEnd(34)}` +
      ` 面 ${String(faces.faces).padStart(6)} 画 ${String(faces.drawn).padStart(6)}` +
      ` 剔 ${String(faces.culled).padStart(6)} 裁 ${String(faces.clipped).padStart(5)}` +
      `  ${(svg.length / 1024).toFixed(0)} KB  ${Date.now() - t0} ms`
    )
  }
  console.log(`\n出图在 ${path.relative(process.cwd(), OUT)}/`)
}

main()
