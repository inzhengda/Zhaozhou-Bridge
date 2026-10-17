// 全手势空间扫雷：枚举用户能摇出来的每一个机位，沿视线细采样，
// 找"视线穿地"和"抬升量异常"。这是把'某些角度透视 bug'从抽查
// 变成穷举的验收脚本。零输出 = 通过。
const BASE = require('path').resolve(__dirname, '..')
global.wx = {
  getWindowInfo: () => ({ pixelRatio: 2, statusBarHeight: 44, windowWidth: 430, windowHeight: 900 }),
  getSystemInfoSync: () => ({ pixelRatio: 2, statusBarHeight: 44 }),
  getMenuButtonBoundingClientRect: () => ({ width: 87, height: 32, top: 52, bottom: 84, left: 320, right: 407 }),
  createSelectorQuery: () => ({ select: () => ({ fields: () => ({ exec: () => {} }) }) })
}
let OPTIONS = null
global.Page = (o) => { OPTIONS = o }
const B = require(BASE + '/utils/bridge.js')
require(BASE + '/pages/index/index.js')
const page = Object.assign({}, OPTIONS)
page.data = Object.assign({}, OPTIONS.data)
page.cw = 430; page.ch = 900

// 地面标高：解析 groundY + 岸膝外平台的起伏上限（bankRelief 未导出，取包络 0.9）
const ground = (x) => B.groundY(Math.abs(x)) + (Math.abs(x) > 46 ? 0.9 : 0)

// 与手势一致的活动范围：pitch -0.45~0.95，zoom 0.22~4.5，
// tx/ty/tz 取各预设焦点覆盖到的极值
const TXS = [-24, -19.5, -15.5, 0, 15.5, 19.5, 24]
const TYS = [2.6, 3.4, 4.6, 6.0, 7.5]
const PITCHES = []; for (let i = 0; i < 15; i++) PITCHES.push(-0.45 + i * (1.40 / 14))
const ZOOMS = []; for (let i = 0; i < 18; i++) ZOOMS.push(0.22 + i * (4.28 / 17))
const YAWS = []; for (let i = 0; i < 24; i++) YAWS.push(-Math.PI + i * (2 * Math.PI / 24))

const bad = []
let n = 0, maxLift = 0
for (const tx of TXS) for (const ty of TYS) for (const p of PITCHES) for (const z of ZOOMS) for (const y0 of YAWS) {
  page.cam = { yaw: y0, pitch: p, zoom: z, tx, ty, tz: 0 }
  page.clampOrbit()
  const cam = page.camera()
  const eye = cam.eye, tg = cam.target
  const grounded = tg[1] < ground(tg[0]) + 2
  let minGap = Infinity, minU = 0
  for (let s = 0; s <= 200; s++) {
    const u = s / 200
    if (grounded && u < 0.25) continue
    const x = tg[0] + (eye[0] - tg[0]) * u
    const yy = tg[1] + (eye[1] - tg[1]) * u
    const gap = yy - ground(x)
    if (gap < minGap) { minGap = gap; minU = u }
  }
  const d = page.cam.d != null ? page.cam.d : page.camDist(z)
  const lift = eye[1] - Math.max(tg[1] + d * Math.sin(p), 1.2)
  if (lift > maxLift) maxLift = lift
  n++
  if (minGap < 0.05) bad.push({ tx, ty, p: p.toFixed(2), z: z.toFixed(2), yaw: page.cam.yaw.toFixed(2), minGap: minGap.toFixed(2), u: minU.toFixed(2), grounded })
}
console.log('checked', n, 'cameras; max lift =', maxLift.toFixed(2))
if (!bad.length) { console.log('PASS: no sightline dips below ground anywhere in gesture space'); process.exit(0) }
console.log('FAIL', bad.length, 'cameras:'); bad.slice(0, 40).forEach((b) => console.log(JSON.stringify(b)))
