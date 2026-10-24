/**
 * 赵州桥几何模型（隋·大业年间 595—605，匠人李春）
 *
 * 尺寸全部取公开的实测 / 勘察数据，出处见 pages/index/index.js 里的 SOURCES：
 *   主拱净跨 37.02 m，净矢高 7.23 m —— 矢跨比 1 : 5.12，是"坦拱"，不是半圆拱
 *   圆弧拱，1954—56 年大修实测半径西 27.7 m、东 27.3 m，拱中心夹角 85°20′33″
 *   拱券厚 1.02 ~ 1.03 m —— 跨 37 m 只用 1 m 厚，是隋代石拱的奇迹
 *   拱顶宽 9.0 m、拱脚宽 9.6 m —— 两侧收分，每道券都是上窄下宽的楔形
 *   28 道拱券并列砌筑，券间用腰铁（伏石）连结
 *   护拱石（眉石）拱脚 0.30 m、拱顶 0.16 m，铺在拱背上保护拱券
 *   四个小拱：靠桥堍净跨 3.81 m ×2、靠桥中央净跨 2.85 m ×2，矢跨比约 0.48
 *   桥台长 5.0 m、宽 9.6 m，拱脚下为五层平铺条石，共厚 1.549 m，埋深 2 ~ 2.5 m
 *   桥身全长 64.4 m（含两端引桥；梁思成 1933 年实量桥身为 50.82 m）
 *
 * 坐标约定（单位：米）：
 *   x —— 沿桥长（主拱跨度方向），y —— 向上，z —— 沿桥宽（水流方向）
 *   y = 0 取在起拱线上，主拱净矢高就是从这条线量到拱顶内弧。
 */

const mesh = require('./mesh.js')

// ================= 主拱 =================
const SPAN = 37.02                              // 净跨
const HALF_SPAN = SPAN / 2                      // 18.51
const RISE = 7.23                               // 净矢高
// 由"净跨 + 净矢高"反解圆弧半径，与实测 27.3 ~ 27.7 m 相符
const R_IN = (RISE * RISE + HALF_SPAN * HALF_SPAN) / (2 * RISE)   // 27.3094
const R_OUT = R_IN + 1.03                       // 拱券厚 1.02 ~ 1.03
const CY = RISE - R_IN                          // 圆心标高 -20.0794
const HALF_TH = Math.asin(HALF_SPAN / R_IN)     // 0.74513 rad，全弧 85.38° ≈ 85°20′33″
const SPRING_Y = 0                              // 起拱线

// ================= 桥宽与收分 =================
const HW_CROWN = 4.5                            // 拱顶半宽  ← 拱顶宽 9.0 m
const HW_SPRING = 4.8                           // 拱脚半宽  ← 拱脚宽 9.6 m
const BRIDGE_W = HW_CROWN * 2
const RING_N = 28                               // 28 道并列拱券

// ================= 护拱石 =================
const HAUNCH_CROWN = 0.16
const HAUNCH_SPRING = 0.30

// ================= 四个小拱 =================
// a = 净跨的一半；f = 矢高（矢跨比 0.48）；x0 = 靠拱顶一侧的拱脚
//
// 起拱线不另设标高，就取**主拱拱背在 x0 处的高度**（haunchTop(s.x0)）：
// 小拱的券脚落在主拱背上，靠拱顶那一侧的券脚正好与拱背相切、不留竖直边，
// 靠桥台那一侧的券脚则因为拱背往下降而拉出一段竖直的洞壁。
// 这和梁思成 1934 年测绘图上的小拱一模一样：洞口的上面是一道圆券、
// 两侧是竖直的边、下面就是主拱外弧那条斜带；拱背以上没有一道水平的起拱线。
//
// 原先写死 6.30 / 4.10 两个常数，比拱背高出 0.25 / 0.19 m，
// 侧墙还得从拱背一路补砌到起拱线，于是圆弧底下凭空多出一块填充。
const SMALL = [
  { key: 'inner', x0: 11.60, a: 1.425, f: 1.3680, rt: 0.45 }, // 净跨 2.85
  { key: 'outer', x0: 15.60, a: 1.905, f: 1.8288, rt: 0.50 }  // 净跨 3.81
]
SMALL.forEach(function (s) {
  s.x1 = s.x0 + 2 * s.a
  s.xc = s.x0 + s.a
  s.spring = haunchTop(s.x0)
  // 洞底最低点。洞口下面那条边是主拱外弧，它一路往桥台方向斜下去，
  // 所以「券脚」和「水几时开始从这儿过」是两回事：
  //   · spring = 拱背在 x0（靠拱顶那一端）的高度，是**圆券的起拱线**。
  //     靠拱顶那头券脚与拱背相切，洞口在那里正好收成零高。
  //   · sill   = 拱背在 x1（靠桥台那一端）的高度，是**洞口的最低点**。
  //     水涨到这里就开始从洞口最外侧那一条缝里过——比漫过券脚早得多
  //     （外侧那对：sill 0.98 m 对 spring 3.91 m，差了近 3 m）。
  //
  // 水力计算（hydro.js 的过水断面、SPANDREL 的凿空方量、3D 侧墙的洞口）
  // 一律拿拱背当下边界，也就是认 sill；只有"漫过券脚"这句话该用 spring。
  // 两者混用会让卡片上「尚无一孔过水」和「多让出 2 m²」并排出现。
  s.sill = haunchTop(s.x1)
  s.R = (s.a * s.a + s.f * s.f) / (2 * s.f)
  s.k = (s.f * s.f - s.a * s.a) / (2 * s.f)
  s.cy = s.spring + s.k
  s.th = Math.asin(s.a / s.R)
})

/**
 * 敞肩拱的「减重省料」账 —— 由本题几何积出来，不用史书上抄来的数
 *   4 个小拱凿穿的洞体体积：沿桥长积洞口净高，再乘该处的桥宽
 *   减去这笔石料，桥身自重就轻了这么多
 * 数值会在页面「敞肩之利」卡片里实时显示，因此必须与几何同步，
 * 不能写成常量，改了 SMALL 就得跟着变。
 *
 * 洞高的下界是**主拱拱背**（haunchTop），不是起拱线：
 * 洞口一直挖到拱背为止，起拱线以下那截同样是凿掉的石头。
 */
const SPANDREL = (function () {
  const N = 400
  let voidV = 0, voidA = 0
  for (let i = 0; i < SMALL.length; i++) {
    const s = SMALL[i]
    const w = (s.x1 - s.x0) / N
    for (let k = 0; k < N; k++) {
      const xa = s.x0 + w * k, xb = xa + w
      const ha = Math.max(0, smallIntrados(s, xa) - haunchTop(xa))
      const hb = Math.max(0, smallIntrados(s, xb) - haunchTop(xb))
      // 梯形积出这一小段的洞口面积与体积（两侧各一，最后 ×2）
      const da = (ha + hb) * 0.5 * w
      voidA += da
      voidV += da * (halfWidth(xa) + halfWidth(xb))
    }
  }
  voidA *= 2
  voidV *= 2
  // 主拱内弧围出的拱肩整块面积，用来给「省了百分之几」一个参照
  const segA = R_IN * R_IN * (HALF_TH - Math.sin(HALF_TH) * Math.cos(HALF_TH))
  const DENSITY = 2.6                      // 花岗岩 2.6 t/m³（青灰色石灰岩约 2.7）
  return {
    voidArea: voidA,                       // 四个小拱的净过水断面 m²
    voidVol: voidV,                        // 省下的砌石体积 m³
    stone: voidV * DENSITY,                // 折合石重 t
    segArea: segA,                         // 主拱拱肩整块面积 m²（参照）
    share: voidA / segA                    // 洞口面积占拱肩的比例
  }
})()

// ================= 桥台与基础 =================
const ABUT_X0 = HALF_SPAN                       // 桥台里缘：主拱拱脚
const ABUT_LEN = 5.0                            // 桥台长约 5 m
const ABUT_X1 = ABUT_X0 + ABUT_LEN              // 23.51
const ABUT_HW = HW_SPRING                       // 桥台宽 9.6 m
const ABUT_TOP = SPRING_Y                       // 桥台顶面就是起拱线
const ABUT_BOT = -1.60                          // 桥台体底面
const FOUND_N = 5                               // 拱脚下五层平铺条石
const FOUND_T = 1.549 / FOUND_N                 // 每层厚 0.3098 m（共厚 1.549 m）
const FOUND_BOT = ABUT_BOT - 1.549              // -3.149，埋深约 2.2 m
const ABUT_EDGE = R_OUT * Math.sin(HALF_TH)     // 19.207 拱券外缘的起拱点

// ================= 桥面 =================
const DECK_HALF = 32.2                          // 桥身全长 64.4 m 的一半（含引桥）
const DECK_CROWN = 9.4
const DECK_END = 7.1
const DECK_TH = 0.5
const _sag = DECK_CROWN - DECK_END
const DECK_R = (_sag * _sag + DECK_HALF * DECK_HALF) / (2 * _sag)   // 226.55
const DECK_CY = DECK_CROWN - DECK_R

const RAIL_PANEL = 21                            // 每侧 21 块，两侧共 42 块栏板望柱

// ================= 配色 =================
const C = {
  arch:   [199, 188, 168],
  haunch: [186, 176, 156],
  // 小拱券。只比侧墙（span 175,164,145）亮一档，是故意压住的：
  // 拱券的面是平涂的，包着圆弧一圈，每个面的法线差十几度、明暗就差一截，
  // 底面颜色再一抬高，整圈就碎成一排亮块，看着像有一圈石头支棱出来。
  // 亮一档足够看出"这是券石"，再多就是噪点
  small:  [189, 178, 158],
  // 龙门石。暖、略深于相邻的券石，合龙那一下才看得出是"另放上去的一块"。
  // 但不能给足金黄：28 道券摊开时，28 块龙门石在拱顶连成一条横带，
  // 颜色一浓就整片读成"桥面还在"，把拆解的意思盖掉了
  key:    [206, 181, 133],
  span:   [175, 164, 145],
  base:   [163, 153, 137],
  found:  [150, 142, 128],
  deck:   [184, 176, 161],
  rail:   [208, 200, 184],
  ground: [122, 116,  99],
  bed:    [100,  96,  84],
  water:  [ 40, 106, 130],
  hi:     [216, 104,  60],
  // 小拱洞的底影。比侧墙深两档：洞里没有阳光直射，只有拱背那道斜面
  // 反着一点天光——不压暗这一层，洞口就和墙面一个色，读不出"隧道"
  tunnel: [128, 120, 106]
}

// ================= 营造时序（秒）=================
// 桥台 → 28 道拱券 + 护拱石 → 侧墙 → 小拱 → 桥面 → 栏板
const T = {
  base:  [0.0,  2.2],
  arch:  [2.2,  8.8],
  span:  [8.8, 10.8],
  small: [10.8, 13.2],
  deck:  [13.2, 14.9],
  rail:  [14.9, 16.3]
}
// 节奏整体提速约 1/3（总时长 23.4 → 16.3s）：营造机位抬高到 45° 俯视之后，
// 28 道拱 10.4s 的砌筑段等待感明显，单道券 2.4s 也拖。压缩到 1.6s 一道、
// 错距由 (拱券段 − RING_DUR)/27 自动重算，其余各段等比收紧，
// "台→券→墙→小拱→面→栏"的层次关系保持不变
const TOTAL = T.rail[1]

const RING_DUR = 1.6
const RING_STAGGER = (T.arch[1] - T.arch[0] - RING_DUR) / (RING_N - 1)
const KEY_FRAC = 0.14                            // 龙门石占半弧的比例

// 圆弧分段。远景够用即可；相机推近时 index.js 调 setDetail(1) 自动加密，
// 让每道券的分块接近实测的 43 块楔石。
// 小拱的分段给得比主拱足。主拱半径 27 m，远景 9 段已经看不出棱；
// 小拱半径只有 1.4~1.9 m，拱圈又薄（0.45 m），同样 14 段时整圈就是十几个
// 平涂的面，明暗一级一级地跳，圆拱看着像多边形的石垛。
// 小拱一共才 4 件，加密的代价可以忽略
const SEG_FAR  = { ring: 9,  small: 24 }
const SEG_NEAR = { ring: 26, small: 36 }
let DETAIL = 0
function setDetail(d) { d = d ? 1 : 0; if (d === DETAIL) return false; DETAIL = d; return true }
function ringSegs()  { return DETAIL ? SEG_NEAR.ring  : SEG_FAR.ring }
function smallSegs() { return DETAIL ? SEG_NEAR.small : SEG_FAR.small }

// ================= 形状函数 =================

/**
 * 河床与河岸。
 *
 * 河床 -1.0 m，桥台外侧平一段到 |x| = 24，然后**陡起**到 6.7 m —— 位置正好
 * 卡在 |x| = DECK_HALF = 32.2，也就是桥身全长 64.4 m 的末端。这处"岸膝"
 * 不是随手定的：引桥是压在土堤上的，岸坡要升到桥面底下，桥身才有着落。
 * 岸坡到不了这个高度，桥两端就会凭空悬在河滩上方三四米，一眼假。
 * 过了岸膝就是河北平原，缓缓爬到滩地高度。
 *
 * 滩地高度 7.4 m 是两头夹出来的：
 *   上限——滩地若高过桥面端头（标高 7.1 m），桥就像陷在路堑里，
 *         视线一高，桥身整个埋进土坡，只剩一道横线；
 *   下限——滩地若低过最高洪水位（Q = 1300 时 6.93 m），水就会漫出河岸
 *         铺满整个平原，模型里没有对应的过水断面。
 */
const BED_Y = -1.0
const BANK_H = 7.4
const BANK_X = 46.0
const BANK_KNEE = DECK_HALF                  // 32.2，岸膝就压在桥身末端
const BANK_KNEE_Y = 6.7                      // 略高于桥面底 6.60，让桥端埋进土里

function groundY(ax) {
  if (ax <= 17.0) return BED_Y
  if (ax <= 20.0) return BED_Y + 1.0 * (ax - 17.0) / 3.0
  if (ax <= 24.0) return 0
  if (ax <= BANK_KNEE) return BANK_KNEE_Y * (ax - 24.0) / (BANK_KNEE - 24.0)
  if (ax <= BANK_X) {
    return BANK_KNEE_Y + (BANK_H - BANK_KNEE_Y) * (ax - BANK_KNEE) / (BANK_X - BANK_KNEE)
  }
  return BANK_H
}

function archIntrados(x) {
  const t = R_IN * R_IN - x * x
  return t <= 0 ? SPRING_Y : CY + Math.sqrt(t)
}
function archExtrados(x) {
  const t = R_OUT * R_OUT - x * x
  return t <= 0 ? SPRING_Y : CY + Math.sqrt(t)
}

/** 该 |x| 处的半桥宽（收分）：拱顶 4.5 → 拱脚 4.8 */
function halfWidth(x) {
  const ax = Math.abs(x)
  const t = ax >= HALF_SPAN ? 1 : ax / HALF_SPAN
  return HW_CROWN + (HW_SPRING - HW_CROWN) * t
}

/** 护拱石外缘标高：拱背（含护拱石）—— 侧墙就砌在这上面 */
function haunchTop(x) {
  const ax = Math.abs(x)
  let t = ax >= HALF_SPAN ? 1 : ax / HALF_SPAN
  const R = R_OUT + HAUNCH_CROWN + (HAUNCH_SPRING - HAUNCH_CROWN) * t
  const q = R * R - ax * ax
  return q <= 0 ? SPRING_Y : CY + Math.sqrt(q)
}

/** 侧墙底：拱背以内跟着拱背走；桥台段落在起拱线上；再往外落到地面 */
function wallBottom(x) {
  const ax = Math.abs(x)
  if (ax <= ABUT_EDGE) return haunchTop(ax)
  if (ax <= ABUT_X1) return ABUT_TOP
  return groundY(ax)
}

function deckTop(x) {
  const t = DECK_R * DECK_R - x * x
  return t <= 0 ? DECK_END : DECK_CY + Math.sqrt(t)
}
function deckBottom(x) { return deckTop(x) - DECK_TH }

/**
 * 小拱内弧标高。
 *
 * 入参 x 是**带符号**的桥长坐标，函数必须对 x 取偶：四个小拱在 ±x 两侧各有一对，
 * s.xc 只是正侧那一孔的圆心。早先这里写的是 d = x - s.xc，右侧（x > 0）算得对，
 * 左侧 d 变成 -20 上下、d² > R²，一律返回起拱线，于是左半边的侧墙没有拱洞、
 * 只剩一个平顶的方缺口，左半边的小拱也不过分水（见 wetBands 的调用）。
 * 一个符号错，画面上是左边四个洞全没了。
 */
function smallIntrados(s, x) {
  const d = Math.abs(x) - s.xc
  const t = s.R * s.R - d * d
  if (t <= 0) return s.spring
  const y = s.cy + Math.sqrt(t)
  return y < s.spring ? s.spring : y
}
function smallExtrados(s, x) {
  const R = s.R + s.rt
  const d = Math.abs(x) - s.xc
  const t = R * R - d * d
  if (t <= 0) return s.spring
  const y = s.cy + Math.sqrt(t)
  return y < s.spring ? s.spring : y
}
/** |x| 落进了哪个小拱洞（返回 s 或 null） */
function smallAt(x) {
  const ax = Math.abs(x)
  for (let i = 0; i < SMALL.length; i++) {
    const s = SMALL[i]
    if (ax >= s.x0 - 1e-6 && ax <= s.x1 + 1e-6) return s
  }
  return null
}

// ================= 构件网格 =================

/** 一道拱券。q 为砌筑进度（从两端拱脚对称砌向拱顶），mask 位 0/1 控制 z 端面 */
function ringMesh(i, q, mask, segs) {
  const N = RING_N
  const zf0 = -1 + 2 * i / N
  const zf1 = -1 + 2 * (i + 1) / N
  const sg = segs || ringSegs()
  const m = mesh.newMesh()
  mesh.setSeed(i * 977 + 13)
  // 只有最外侧两道券需要画 z 端面，内部的面相邻两道重合，画了就是 z-fighting
  const mm = mask === undefined ? ((i === 0 ? 1 : 0) | (i === N - 1 ? 2 : 0)) : mask
  if (q >= 1) {
    mesh.archRingT(m, 0, CY, R_IN, R_OUT, -HALF_TH, HALF_TH, zf0, zf1,
      HW_CROWN, HW_SPRING, HALF_TH, sg, C.arch, mm)
    return m
  }
  const qq = Math.min(1, q / 0.87)
  const built = HALF_TH * (1 - KEY_FRAC) * qq
  const s2 = Math.max(1, Math.round(sg * (built / HALF_TH)))
  mesh.archRingT(m, 0, CY, R_IN, R_OUT, -HALF_TH, -HALF_TH + built, zf0, zf1,
    HW_CROWN, HW_SPRING, HALF_TH, s2, C.arch, mm | 3)
  mesh.archRingT(m, 0, CY, R_IN, R_OUT, HALF_TH - built, HALF_TH, zf0, zf1,
    HW_CROWN, HW_SPRING, HALF_TH, s2, C.arch, mm | 3)
  return m
}

/** 龙门石：拱顶合龙的那一块，合龙前它一直是单独一件挂在上面 */
function keystoneMesh(i, segs) {
  const N = RING_N
  const zf0 = -1 + 2 * i / N
  const zf1 = -1 + 2 * (i + 1) / N
  const m = mesh.newMesh()
  mesh.setSeed(i * 977 + 13)
  const g = HALF_TH * KEY_FRAC
  mesh.archRingT(m, 0, CY, R_IN, R_OUT, -g, g, zf0, zf1,
    HW_CROWN, HW_SPRING, HALF_TH, 1, C.key, 3)
  return m
}

/** 护拱石：贴在拱背上的石带，拱脚 0.30 m 收到拱顶 0.16 m。左右各一件 */
function haunchMesh(sign, segs) {
  const m = mesh.newMesh()
  const sg = segs || ringSegs()
  const a = sign > 0 ? 0 : HALF_TH
  const b = sign > 0 ? HALF_TH : 0
  mesh.archSkin(m, 0, CY, R_OUT, R_OUT, a, b, -1, 1,
    HW_CROWN, HW_SPRING, HALF_TH, HAUNCH_CROWN, HAUNCH_SPRING, sg, C.haunch, 3)
  return m
}

/**
 * 小拱券。idx 0 = 近拱顶（2.85 m），1 = 靠桥堍（3.81 m）；side ±1 决定左右
 *
 * 拱圈宽度必须**照抄该处侧墙的宽度**，也就是 halfWidth(s.xc)——两侧的侧墙就是
 * 按 halfWidth 砌的，拱圈若自说自话，就会比墙窄一截，整个拱圈陷进墙里成一道沟，
 * 墙沿则像个帽檐似的支出来。
 *
 * 这里是传 hwCrown = hwSpring 一个常数，而不是交给 archRingT 去按角度插值：
 * archRingT 的 hwRef 是**角度**，原来这里传的是 HALF_SPAN（18.51，一个长度）。
 * 小拱自身的半张角 s.th 才 1.53 rad，除下来 t ≈ 0.08，插值几乎不动，
 * 于是拱圈宽度恒为 4.52 m，而同一处的墙是 4.75~4.80 m —— 每侧差了 0.25 m。
 * 小拱只占 3.8 m 桥长，这段范围内 halfWidth 本身才变化 0.05 m，
 * 取拱心处的一个常数足够，不必再按自己的角度分一遍收分。
 */
function smallRingMesh(idx, side, segs) {
  const s = SMALL[idx]
  const m = mesh.newMesh()
  mesh.setSeed(idx * 613 + (side > 0 ? 7 : 29))
  const sg = segs || smallSegs()
  const hwq = halfWidth(s.xc)
  // 券背在券脚处**竖直切齐**：外弧只扫到 asin(a/(R+rt))，两端正好落在
  // x = xc ± a 的洞口竖边上，券背不会越过竖边往墙里探头
  const thO = Math.asin(s.a / (s.R + s.rt))
  mesh.archRingT(m, side * s.xc, s.cy, s.R, s.R + s.rt, -s.th, s.th, -1, 1,
    hwq, hwq, s.th, sg, C.small, 3, -thO, thO)
  return m
}

/** 单块石头（基础条石、腰铁之类的小件） */
function slabMesh(x0, x1, y0, y1, z0, z1, color) {
  const m = mesh.newMesh()
  mesh.prismZ(m, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], z0, z1, color)
  return m
}

/**
 * 小拱洞的底影。洞里的"地面"就是主拱拱背（含护拱石）那道斜面，
 * 它的网格来自 28 道券的外皮——颜色和侧墙几乎一样，平光下一片米色，
 * 洞口看上去就像被实体填平了。这一层沿拱背贴一条暗带（比拱背高 3 mm，
 * 只为了在画家算法里稳定压住券皮），洞立刻就有了进深：券圈是亮的，
 * 洞底是暗的，中间透出对岸的光。
 *
 * 分 7 小步沿拱背走，每步左右各一条；x 取负的那侧绕序反过来，
 * 否则法线朝下，整条带被背面剔除吃掉。
 */
function tunnelShadowMesh() {
  const m = mesh.newMesh()
  mesh.setSeed(4241)
  for (let i = 0; i < SMALL.length; i++) {
    const s = SMALL[i]
    const n = 7
    for (let k = 0; k < n; k++) {
      const xa = s.x0 + (s.x1 - s.x0) * k / n
      const xb = s.x0 + (s.x1 - s.x0) * (k + 1) / n
      const ya = haunchTop(xa) + 0.03, yb = haunchTop(xb) + 0.03
      const wa = halfWidth(xa) - 0.06, wb = halfWidth(xb) - 0.06
      const tone = k % 2 ? 1.05 : 0.95
      const col = [Math.round(C.tunnel[0] * tone),
                   Math.round(C.tunnel[1] * tone),
                   Math.round(C.tunnel[2] * tone)]
      for (let sg = -1; sg <= 1; sg += 2) {
        if (sg > 0) {
          mesh.quad(m, [xa, ya, -wa], [xa, ya, wa], [xb, yb, wb], [xb, yb, -wb], col, 1)
        } else {
          mesh.quad(m, [-xa, ya, wa], [-xa, ya, -wa], [-xb, yb, -wb], [-xb, yb, wb], col, 1)
        }
      }
    }
  }
  return m
}

// ================= 侧墙 / 桥台分条 =================

// |x| 方向的分条。小拱洞所在区间单独细分，侧墙才能贴着弧线切出洞形。
// 沿 x 分条的密度。两个小拱洞里必须切得密：侧墙是**竖直的条**，
// 洞口的圆弧是拿这些条的上下沿一步步"台阶"逼出来的，6 条时每级台阶
// 0.64 m（正视机位下约 5 px），拱边一圈锯齿，看着像砌歪了的乱石。
// 18 条把台阶压到 0.21 m，正视时不到 2 px，弧就顺了。
// 其余各段是直边，用不着这么密。
const X_RUNS = [
  [0.00,  11.60, 10],       // 拱顶实肩：顶面离洞顶仅 0.6 m 上下，俯视时要
                            // 和桥面、洞底比深度，条必须切到 1.2 m 上下
  [11.60, 14.45, 18],       // 内小拱洞
  [14.45, 15.60, 1],        // 两洞之间的墩
  [15.60, 19.41, 18],       // 外小拱洞
  [19.41, ABUT_X1, 8]       // 端墙（落在桥台上）。条宽 ≤1.6 m，理由同上
]

/**
 * 竖直棱柱沿 z 的切片数。
 *
 * 侧墙、桥台、桥面原先是一整条 9.6 m 贯通桥宽的棱柱。渲染器逐面算平均
 * 深度，大面的深度落在面心——一块 9.6 m 宽的侧面，斜着看时近端比面心
 * 近 4 m、远端比面心远 4 m，排序就不可靠：相邻墙条的端面互相咬，桥面
 * 被栏板/侧墙啃掉一角。切成 4 薄片后每片面心离真实深度只差零点几米，
 * 斜视角下也咬不动了。（地形当初为同一件事切过 z，见 TERRAIN_ZS 的注释。）
 *
 * 4 片治的是**平视斜看**（偏航方向）的毛病。俯视是另一条战线：桥面顶、
 * 墙顶、洞顶是一摞只差 0.5～0.7 m 的水平面（见 deckSegments 的注释），
 * 2.4 m 宽的薄片从高处看时面心深度照样兜不住，洞口会透出桥面、墙顶会
 * 翻到桥面上来。8 片把薄片宽度压到 1.2 m，再配上桥面的 x 向细分和桥面
 * −0.35 的排序偏置，俯仰全程（pitch −0.45～0.95）都不再咬穿。
 */
const Z_SLICES = 8

/** 把 [-hw, hw] 均分成 Z_SLICES 段 */
function zSlabs(hw) {
  const out = []
  for (let i = 0; i < Z_SLICES; i++) {
    out.push([-hw + 2 * hw * i / Z_SLICES, -hw + 2 * hw * (i + 1) / Z_SLICES])
  }
  return out
}

/**
 * 侧墙（isBase = false）或桥台（isBase = true）沿 x 分条，
 * 每个分条返回一个独立构件，方便营造动画里逐条"长"出来。
 */
function wallStrips(open, isBase) {
  const col = isBase ? C.base : C.span
  const out = []

  const emit = function (xa, xb, zSign) {
    const A = xa * zSign, B = xb * zSign
    const hwA = halfWidth(A), hwB = halfWidth(B)
    const hw = Math.max(hwA, hwB)
    const m = mesh.newMesh()

    if (isBase) {
      // 桥台：五层条石基础之上，砌到起拱线
      if (ABUT_TOP - ABUT_BOT < 0.03) return
      for (const [za, zb] of zSlabs(hw)) {
        mesh.prismZ(m, [[A, ABUT_BOT], [B, ABUT_BOT], [B, ABUT_TOP], [A, ABUT_TOP]],
          za, zb, col)
      }
    } else {
      const dA = deckBottom(A), dB = deckBottom(B)
      const s = open ? smallAt((xa + xb) / 2) : null
      if (s) {
        // 洞里只砌**拱背以上**那一段：下边界是券背（小拱券的外弧），上边界是桥面底。
        // 券背以下到主拱拱背之间整块凿空——这就是小拱的洞口，一直通到主拱的拱背上。
        //
        // 早先这里还在洞口底下补了一段"拱背 → 起拱线"的实心墙，把圆弧下面填上了；
        // 那截填充正是要挖掉的东西。起拱线本就取在拱背高度（见 SMALL 的定义），
        // 该处根本不需要补料，补了反而在券脚之间糊出一块石头。
        const eA = smallExtrados(s, A), eB = smallExtrados(s, B)
        if (dA > eA + 0.02 && dB > eB + 0.02) {
          for (const [za, zb] of zSlabs(hw)) {
            mesh.prismZ(m, [[A, eA], [B, eB], [B, dB], [A, dA]], za, zb, col)
          }
        }
      } else {
        const wA = wallBottom(A), wB = wallBottom(B)
        if (dA > wA + 0.02 && dB > wB + 0.02) {
          for (const [za, zb] of zSlabs(hw)) {
            mesh.prismZ(m, [[A, wA], [B, wB], [B, dB], [A, dA]], za, zb, col)
          }
        }
      }
    }
    if (!m.faces.length) return
    out.push({ mesh: m, center: mesh.centerOf(m), ax: (xa + xb) / 2, zSign: zSign })
  }

  for (let r = 0; r < X_RUNS.length; r++) {
    const run = X_RUNS[r]
    if (isBase && run[1] <= ABUT_X0) continue
    const a = isBase ? Math.max(run[0], ABUT_X0) : run[0]
    // 桥台是一块光板，没有洞口要切，分条只为了让营造动画一段段长出来，
    // 用不着跟着侧墙的密度走。照搬 run[2] 的话，被 ABUT_X0 截断的那一段
    // 会切成 18 条 5 cm 宽的薄片，白添一堆碎构件
    const n = isBase ? Math.min(run[2], 3) : run[2]
    for (let k = 0; k < n; k++) {
      const xa = a + (run[1] - a) * (k / n)
      const xb = a + (run[1] - a) * ((k + 1) / n)
      emit(xa, xb, 1)
      emit(xa, xb, -1)
    }
  }
  return out
}

/** 拱脚下五层平铺条石，每层略有出台，越往下越宽 */
function foundationStrips() {
  const out = []
  for (let i = 0; i < FOUND_N; i++) {
    const y1 = ABUT_BOT - i * FOUND_T
    const y0 = y1 - FOUND_T
    // 每层向外出台 0.06 m
    const x0 = ABUT_X0 - 0.10 - i * 0.06
    const x1 = ABUT_X1 + 0.18 + i * 0.06
    const hw = ABUT_HW + 0.05 + i * 0.05
    for (let sg = -1; sg <= 1; sg += 2) {
      const m = slabMesh(x0 * sg, x1 * sg, y0, y1, -hw, hw, C.found)
      out.push({ mesh: m, center: mesh.centerOf(m), ax: (x0 + x1) / 2, floor: i })
    }
  }
  return out
}

/** 桥面：沿桥长按弧线分段的石板，每段一个构件 */
function deckSegments() {
  // 营造动画单元保持 14 段，但每段的网格在 x 向再细分：渲染器按面心平均
  // 深度排序（见 Z_SLICES 的注释），桥面顶与墙顶只差一层 DECK_TH = 0.5 m，
  // 一块 4.6 m 长的桥面大面从高处看时，面心深度和底下的墙顶差出个 1 m
  // 都可能，排序就会翻——洞顶从桥面上透出来。切到 1.2 m 并让分缝落在
  // 墙条边界上，上下两层格线咬齐，深度差才稳稳落在桥面这边。
  const WALL_CUTS = []
  for (const run of X_RUNS) for (const b of [run[0], run[1]]) {
    if (!WALL_CUTS.includes(b)) WALL_CUTS.push(b)
  }
  const n = 14
  const out = []
  for (let k = 0; k < n; k++) {
    const xa = -DECK_HALF + 2 * DECK_HALF * (k / n)
    const xb = -DECK_HALF + 2 * DECK_HALF * ((k + 1) / n)
    const hw = halfWidth(xa) + 0.25                 // 桥面比拱券略宽，挑出一点檐
    const m = mesh.newMesh()
    // 单元内的 x 分缝：1.2 m 均分，再并入压在单元里的墙条边界（含负半桥）。
    // xb 必须在 cuts 里：下面的棱柱循环只铺 cuts[i] → cuts[i+1]，
    // 少了 xb，每个单元从最后一条内部缝到右边界（约 1.15 m）就整块缺失
    // ——桥面上 14 道贯通的口子，墙顶/拱背直接透上来。平视时缝是侧棱，
    // 一条线看不出来；营造机位抬到 45° 俯视后就是满屏"透视眼"补丁
    const cuts = [xa, xb]
    for (const b of WALL_CUTS) for (const s of [b, -b]) {
      if (s > xa + 0.01 && s < xb - 0.01 && !cuts.includes(s)) cuts.push(s)
    }
    const steps = Math.max(1, Math.ceil((xb - xa) / 1.2))
    for (let i = 1; i < steps; i++) {
      const u = xa + (xb - xa) * i / steps
      if (!cuts.includes(u)) cuts.push(u)
    }
    cuts.sort((a, b) => a - b)
    for (let i = 0; i < cuts.length - 1; i++) {
      const ua = cuts[i], ub = cuts[i + 1]
      for (const [za, zb] of zSlabs(hw)) {
        mesh.prismZ(m, [
          [ua, deckBottom(ua)], [ub, deckBottom(ub)],
          [ub, deckTop(ub)], [ua, deckTop(ua)]
        ], za, zb, C.deck)
      }
    }
    out.push({ mesh: m, center: mesh.centerOf(m), ax: (xa + xb) / 2 })
  }
  return out
}

/** 栏板 + 望柱。桥面两侧各 21 块，全桥共 42 块 */
function railPiece(sign) {
  const m = mesh.newMesh()
  const n = RAIL_PANEL
  const hw = halfWidth(0) + 0.25 - 0.16
  const zc = sign * hw
  const za = zc - 0.12, zb = zc + 0.12
  for (let k = 0; k < n; k++) {
    const xa = -DECK_HALF + 2 * DECK_HALF * (k / n)
    const xb = -DECK_HALF + 2 * DECK_HALF * ((k + 1) / n)
    const b0 = deckTop(xa) - 0.06, b1 = deckTop(xb) - 0.06
    mesh.prismZ(m, [[xa, b0], [xb, b1], [xb, b1 + 0.58], [xa, b0 + 0.58]], za, zb, C.rail)
  }
  for (let k = 0; k <= n; k++) {
    const x = -DECK_HALF + 2 * DECK_HALF * (k / n)
    const y = deckTop(x) - 0.06
    mesh.box(m, x - 0.12, x + 0.12, y, y + 0.78, za - 0.06, zb + 0.06, C.rail)
  }
  return m
}

/** 地形：河床 + 河岸。整块静态，不参与营造动画 */
const TERRAIN_Z = 520

/**
 * 岸顶的起伏。
 *
 * 只加在 |x| > BANK_X（岸膝以外的平台）上：河床和岸坡是水面、桥台、
 * 基础条石的公共参照面，动了它们，wetHalf 反解出来的淹没线就对不上岸。
 * 而且只往上抬（0 ~ 0.9 m），绝不会在地面上抠出个坑来存水。
 */
function bankRelief(x, z) {
  const ax = Math.abs(x)
  if (ax <= BANK_X) return 0
  const t = Math.min(1, (ax - BANK_X) / 4)      // 从岸膝外缘慢慢长起来，接得上
  const a = 0.5 + 0.5 * Math.sin(x * 0.061 + 1.1)
  const b = 0.5 + 0.5 * Math.sin(z * 0.033 - 0.4)
  return 0.9 * t * (0.35 + 0.65 * a * b)
}

/**
 * 地形沿 z 的分段。**水面必须用同一张表**（见 index.js 的 drawWater）。
 *
 * 原来一列土坡是从 z = -520 一直拉到 +520 的**一整条**，一个面横跨一千米。
 * 画家算法的深度取的是这个面所有顶点的平均值，于是整片河岸的深度都算成
 * 340 m 上下——雾的 far 才 2.1 倍观察距离（拉远看约 450 m，拉近只剩 120 m），
 * 一整片岸坡就这么被雾刷成天青色的一块灰板：既不像土，也分不出远近。
 * 相机一转，这个"平均深度"还在 340↔320 之间跳，雾跟着跳，满岸一起变色。
 *
 * 光把地形切细还不够。水面原来另有一张自己的 z 表（桥附近密到 0.7 m，
 * 远处疏到 70 m），两张表错开，同一片水域上地形格和水面格的深度就不是一回事：
 * 地形格可能整个排在更近处，于是压到半透明的水面之上，河面上裂出一道道
 * 没入水的干河床，一蓝一褐交替。两张表合成一张，同一格水域的两个面
 * 深度几乎相等，pushFace 里"水后压、地形先画"的先后就自然对上了。
 *
 * 加密的地方是桥下（拱券进出水面那一小段）、相机可能落脚的一圈
 * （观察距离 26 ~ 340 m，也就是 z 约 ±340 以内），以及**雾化带**：
 * 雾按面平涂，相邻行的雾化差 = 对比度×行距/雾程，行距 16-20 m 的
 * 远区在雾化带中段一行跳 15-23 级，水面就显出横向条带——所以
 * |z| ≤ 374（雾 far 2.1×340 的最远可达范围）压到 6-8 m 一行，
 * 行间差退到 3-7 级，隐入波浪起伏；|z| > 374 雾已钳制在 0.94，
 * 行距再大也不变色，保持粗格省面数。两端对称：相机可以转一圈。
 */
const TERRAIN_ZS = [-TERRAIN_Z, -460, -424, -396, -372, -360, -348, -336, -324, -312, -300,
                    -288, -276, -264, -252, -240, -228, -216, -204, -192, -180,
                    -172, -166, -160, -154, -148, -142, -136, -130, -124, -118, -112, -106,
                    -100, -94, -88, -82, -76, -70, -64, -58, -52, -46, -40, -34, -29, -24, -20, -16, -13, -10, -8,
                    -4.6, -2.4, -1.2, -0.5, 0.5, 1.2, 2.4, 4.6,
                    8, 15, 21, 27, 33, 39, 45, 51, 57, 63, 70,
                    76, 82, 88, 94, 100, 106, 112, 118, 124, 130, 136, 142,
                    150, 158, 166, 174, 180, 192, 204, 216, 228, 240, 252, 264, 276, 288, 300,
                    312, 324, 336, 348, 360, 372, 396, 424, 460, TERRAIN_Z]

/**
 * 地形沿 x（桥长方向）的分段。水面也用这张表，理由同上。
 *
 * groundY 是折线，采样点取在各折点（17 / 20 / 24 / 32.2 / 46）上，
 * 折线就一根直线也不差地还原出来，原先夹在中间的那些点纯属多余；
 * 岸顶 46 以外靠 60、90 两个点撑起伏，留着。
 */
const TERRAIN_XS = [-90, -60, -46, -32.2, -24, -20, -17, -16, -8, 0,
                    8, 16, 17, 20, 24, 32.2, 46, 60, 90]

/**
 * 土面的斑驳。按**世界坐标**取值，不是按面片序号。
 *
 * 逐面随机的明暗是钉在面片上的：相机一转，色块跟着面片在岸上跑，
 * 一片土坡看上去就有几块色斑在游动——用户说的"河岸的颜色会变来变去"。
 * 改成按坐标取值，色斑就钉在地上，转动时只跟着地形一起视差移动，
 * 那才是"岸"自己的质地。三档频率错开，免得看出一张格子网。
 */
function soilTone(base, x, z) {
  const n = Math.sin(x * 0.213 + 0.7) * Math.sin(z * 0.101 - 1.3) +
            0.6 * Math.sin(x * 0.077 - z * 0.163 + 2.1)
  const k = 1 + n * 0.032
  return [Math.round(base[0] * k), Math.round(base[1] * k), Math.round(base[2] * k)]
}

function terrainMesh() {
  const m = mesh.newMesh()
  const xs = TERRAIN_XS
  const zs = TERRAIN_ZS

  // 每格地形面的基色与光照系数，按面的推送顺序（z 行 × x 列）记录。
  // 水面的 seam 描边要做"水色叠床色"的预合成，床色必须是地形 rec
  // 的真实链路（soilTone × k），差一个系数描边就比填充亮一个量化桶
  m.cells = []

  // 格点顶点按 (j, k) 复用，不是一格一个 quad 各建各的四个点。
  //
  // 原先每格独立建顶点，相邻两格之间就没有**共用的边**——渲染器描边时
  // 只能把每格的四条边都判成"网格边界"，于是水面下浮出一张方格网，
  // 河床上横平竖直全是线。格点坐标本来就是 (x, z) 的纯函数，缓存一份就行。
  // 复用之后只有真正的折坡（17 / 20 / 24 / 32.2 / 46 那几个折点）才是折痕。
  //
  // 面的推送顺序（z 行 × x 列）没变，m.cells 的下标仍与之一一对应
  const vid = new Array(zs.length * xs.length)
  const vAt = (ji, ki) => {
    const at = ji * xs.length + ki
    let v = vid[at]
    if (v === undefined) {
      const x = xs[ki], z = zs[ji]
      v = mesh.vert(m, x, groundY(Math.abs(x)) + bankRelief(x, z), z)
      vid[at] = v
    }
    return v
  }

  for (let j = 0; j < zs.length - 1; j++) {
    const z0 = zs[j], z1 = zs[j + 1]
    for (let k = 0; k < xs.length - 1; k++) {
      const xa = xs[k], xb = xs[k + 1]
      const col = soilTone((Math.abs(xa) <= 17 && Math.abs(xb) <= 17) ? C.bed : C.ground,
        (xa + xb) / 2, (z0 + z1) / 2)
      // 只铺地表一层。底面、z 两端和 x 两端的立面都省掉：地形铺到
      // ±90 × ±520，四周早已在雾的 far 之外，没人看得见那几条边
      mesh.face(m, [vAt(j, k), vAt(j + 1, k), vAt(j + 1, k + 1), vAt(j, k + 1)], col, 1)
      m.cells.push({ c: col, k: m.faces[m.faces.length - 1].k })
    }
  }
  return m
}

// ================= 岸上景物 =================

/**
 * 两岸的有人烟迹象：官道、纤道、树、村舍。
 *
 * 原先两岸就是两片土色，桥再好看也像沙盘。这里补的几样都刻意压着
 * 调子：路面比地面亮一档，树是两种灰绿，屋顶青灰——不抢桥的戏。
 *
 * 摆放全部是确定性公式（sin 抖动 + 固定表），没有 Math.random：
 * 场景每帧重建，随机的树每帧换地方，整片岸就"活"了——那是 bug 不是生气。
 * 树冠用八面体凑合，小面片多了逐面排序的开销先爆炸。
 */
function sceneryMeshes() {
  const road = mesh.newMesh(), greens = mesh.newMesh(), houses = mesh.newMesh()
  mesh.setSeed(7301)
  const gY = function (x, z) { return groundY(Math.abs(x)) + bankRelief(x, z) }
  const frac = function (v) { return v - Math.floor(v) }

  // 把三个 [x,y,z] 压进网格并返回顶点索引（八面体、山墙这类三角面用）
  const vertsOf = function (m, pts) {
    const idx = []
    for (let i = 0; i < pts.length; i++) {
      idx.push(mesh.vert(m, pts[i][0], pts[i][1], pts[i][2]))
    }
    return idx
  }

  // 顶面四边形，按 x0→x1 的方向自动选绕序，保证法线朝上
  const topQuad = function (m, x0, x1, z0, z1, lift, col) {
    const y00 = gY(x0, z0) + lift, y01 = gY(x0, z1) + lift
    const y10 = gY(x1, z0) + lift, y11 = gY(x1, z1) + lift
    if (x1 >= x0) {
      mesh.quad(m, [x0, y00, z0], [x0, y01, z1], [x1, y11, z1], [x1, y10, z0], col, 1)
    } else {
      mesh.quad(m, [x1, y10, z0], [x1, y11, z1], [x0, y01, z1], [x0, y00, z0], col, 1)
    }
  }

  // ---- 官道：从桥堍接出去，随岸顶起伏 ----
  const XS = [32, 36, 40, 44, 48, 54, 62, 72, 88]
  for (let sg = -1; sg <= 1; sg += 2) {
    for (let k = 0; k < XS.length - 1; k++) {
      const tone = 1 + 0.035 * Math.sin(XS[k] * 0.8 + sg)
      topQuad(road, sg * XS[k], sg * XS[k + 1], -2.2, 2.2, 0.05,
        [Math.round(186 * tone), Math.round(170 * tone), Math.round(138 * tone)])
    }
  }

  // ---- 纤道：贴着水边一条窄便道 ----
  for (let sg = -1; sg <= 1; sg += 2) {
    for (let z = -66; z < 6; z += 12) {
      topQuad(road, sg * 29.0, sg * 30.6, z, Math.min(z + 12, 6), 0.05,
        [176, 162, 132])
    }
  }

  // ---- 树：树干一个细盒，树冠一个八面体 ----
  const trunkC = [122, 94, 66]
  const leafA = [106, 130, 72], leafB = [120, 144, 84]
  const tree = function (x, z, big) {
    const f1 = frac(Math.sin(x * 12.9 + z * 3.7) * 437.58)
    const f2 = frac(f1 * 91.7)
    const base = gY(x, z) - 0.15
    // 河岸杨树本来就是十米上下的个子，比桥还高——桥边一排小灌木似的
    // 树冠撑不起"河岸"这个词，全景里也根本看不见
    const h = (2.6 + 1.4 * f1) * (big ? 1.6 : 1)
    // 冠径压回真实杨树的比例（2-3 m，大树 2.7-3.8）。上一版冠径 3-4.5 m，
    // 配 0.26 m 的细杆，斜视角下邻树的冠和杆在画面上一错位就成了浮空气球
    const r = (1.5 + 0.8 * f2) * (big ? 1.35 : 1)
    const tw = big ? 0.13 : 0.09
    mesh.box(greens, x - tw, x + tw, base, base + h, z - tw, z + tw, trunkC)
    const leaf = f1 > 0.5 ? leafA : leafB
    blob(x, base + h + r * 0.5, z, r, r, leaf)
  }
  // 八面体团块：树冠与灌木共用。ry 压扁了就是灌木，不用第二套几何
  const blob = function (cx, cy, cz, rx, ry, leaf) {
    // T/Bm 必须带 z：vertsOf 会把 undefined 直接压进顶点，投影成 NaN 后
    // canvas fill 整条 path 静默失效——树冠只剩杆子就是从这里来的
    const T = [cx, cy + ry, cz], Bm = [cx, cy - ry, cz]
    const px = [cx + rx, cy, cz], nx = [cx - rx, cy, cz]
    const pz = [cx, cy, cz + rx], nz = [cx, cy, cz - rx]
    mesh.face(greens, vertsOf(greens, [px, T, pz]), leaf)
    mesh.face(greens, vertsOf(greens, [pz, T, nx]), leaf)
    mesh.face(greens, vertsOf(greens, [nx, T, nz]), leaf)
    mesh.face(greens, vertsOf(greens, [nz, T, px]), leaf)
    mesh.face(greens, vertsOf(greens, [px, pz, Bm]), leaf)
    mesh.face(greens, vertsOf(greens, [pz, nx, Bm]), leaf)
    mesh.face(greens, vertsOf(greens, [nx, nz, Bm]), leaf)
    mesh.face(greens, vertsOf(greens, [nz, px, Bm]), leaf)
  }
  // 近岸坡（z 5~45）补两棵树一丛灌木：转视角时这段坡是中前景，秃了最扎眼。
  // 数量整体压着给——树一多就把桥挡了，教学视图里桥是绝对主角
  for (let sg = -1; sg <= 1; sg += 2) {
    for (let i = 0; i < 4; i++) {
      if (i % 2) continue
      const z = 6 + i * 6 + 2 * frac(Math.sin(i * 9.7 + sg * 4) * 5.3)
      tree(sg * (31.5 + 3.5 * frac(Math.sin(z * 0.53 - sg))), z, i === 0)
    }
    for (let i = 0; i < 3; i++) {
      if (i === 1) continue
      const f = frac(Math.sin(i * 13.7 + sg * 7) * 43.7)
      const z = 10 + i * 11 + 3 * f
      const bx = sg * (30 + 4 * frac(Math.sin(z * 0.61 + sg)))
      const r = 0.7 + 0.6 * f
      blob(bx, gY(bx, z) + r * 0.4, z, r, r * 0.55,
        f > 0.5 ? [128, 142, 84] : [112, 134, 76])
    }
  }
  // 河边一排（贴着常水位以上的岸坡），里侧一排错开，下游远处一条稀林带
  for (let sg = -1; sg <= 1; sg += 2) {
    for (let i = 0; i < 6; i++) {
      const z = 8 - i * 11 - 3 * frac(Math.sin(i * 7.3 + sg) * 9.91)
      tree(sg * (30.2 + 2.6 * frac(Math.sin(z * 0.37 + sg * 2))), z, false)
    }
    for (let i = 0; i < 4; i++) {
      const z = 3 - i * 12 - 4 * frac(Math.sin(i * 4.9 - sg) * 6.77)
      tree(sg * (38 + 4 * frac(Math.sin(z * 0.29 - sg))), z, false)
    }
    for (let i = 0; i < 6; i++) {
      if (i % 2) continue
      const z = -40 - i * 12 - 5 * frac(Math.sin(i * 3.1 + sg) * 7.7)
      tree(sg * (34 + 6 * frac(Math.sin(z * 0.31 - sg))), z, false)
    }
  }
  // 桥堍大树当框景，摆在引桥端外侧：冠底约 5.7 m，从引桥上方掠过不压桥面
  tree(-34, 10, true)
  tree(34, -10, true)
  tree(-36, 26, true)
  tree(36, 21, true)

  // ---- 芦苇：贴着水线一丛丛枯黄。一根两片交叉的窄三角，哪面看都不消失 ----
  const reedC = [168, 158, 96], reedD = [148, 144, 88]
  const reed = function (x, z) {
    const y0 = gY(x, z) + 0.02
    for (let i = 0; i < 5; i++) {
      const f = frac(Math.sin(x * 17.3 + z * 9.1 + i * 2.61) * 127.1)
      const h = 1.1 + 1.5 * f
      const sway = (f - 0.5) * 0.8
      const bx = x + (f - 0.5) * 1.6, bz = z + (frac(f * 7.9) - 0.5) * 1.6
      const tip = [bx + sway, y0 + h, bz]
      const c = f > 0.5 ? reedC : reedD
      mesh.face(greens, vertsOf(greens, [[bx - 0.05, y0, bz], [bx + 0.05, y0, bz], tip]), c)
      mesh.face(greens, vertsOf(greens, [[bx, y0, bz - 0.05], [bx, y0, bz + 0.05], tip]), c)
    }
  }
  for (let sg = -1; sg <= 1; sg += 2) {
    for (let i = 0; i < 8; i++) {
      const z = 36 - i * 12 - 4 * frac(Math.sin(i * 5.7 + sg * 3) * 8.3)
      reed(sg * (27.6 + 1.2 * frac(Math.sin(z * 0.41 - sg))), z)
    }
  }

  // ---- 田块：远景的耕地色斑，一块一个面，铺在里侧树的后面 ----
  const fieldA = [172, 162, 108], fieldB = [138, 148, 96]
  for (let sg = -1; sg <= 1; sg += 2) {
    for (let i = 0; i < 6; i++) {
      const z0 = -80 + i * 14 + 3 * frac(Math.sin(i * 4.3 + sg) * 6.1)
      const fx = 36 + 5 * frac(Math.sin(i * 8.9 - sg))
      const w = 7 + 4 * frac(Math.sin(i * 2.7 + sg * 5))
      const d = 8 + 3 * frac(Math.sin(i * 1.9 + sg))
      topQuad(greens, sg * fx, sg * (fx + w), z0, z0 + d, 0.04,
        i % 2 ? fieldB : fieldA)
    }
  }

  // ---- 村舍：灰瓦土墙，门朝着河 ----
  const wallC = [206, 196, 176], roofC = [96, 92, 88], doorC = [84, 72, 62]
  const house = function (x, z, w, d) {
    // 埋深 0.9 m：gY 只取房心一点的地高，四角地形起伏能把浅埋的房子
    // 顶得悬空离地；埋深盖过起伏幅度，四角怎么歪都坐实在坡里
    const y0 = gY(x, z) - 0.9
    const y1 = y0 + 2.2 + 0.3 * frac(Math.sin(x * 5.1 + z))
    const ridge = y1 + 0.85
    const ov = 0.28
    const x0 = x - w / 2, x1 = x + w / 2, z0 = z - d / 2, z1 = z + d / 2
    mesh.box(houses, x0, x1, y0, y1, z0, z1, wallC)
    // 两坡屋顶，屋脊沿 z（顺河）；两个坡面 + 两片山墙
    mesh.quad(houses,
      [x0 - ov, y1 + 0.1, z0 - ov], [x0 - ov, y1 + 0.1, z1 + ov],
      [x, ridge, z1 + ov], [x, ridge, z0 - ov], roofC)
    mesh.quad(houses,
      [x, ridge, z0 - ov], [x, ridge, z1 + ov],
      [x1 + ov, y1 + 0.1, z1 + ov], [x1 + ov, y1 + 0.1, z0 - ov], roofC)
    mesh.face(houses, vertsOf(houses, [
      [x0 - ov, y1 + 0.1, z0 - ov], [x, ridge, z0 - ov], [x1 + ov, y1 + 0.1, z0 - ov]]), wallC)
    mesh.face(houses, vertsOf(houses, [
      [x1 + ov, y1 + 0.1, z1 + ov], [x, ridge, z1 + ov], [x0 - ov, y1 + 0.1, z1 + ov]]), wallC)
    // 门开在朝河的那一侧（z<0 的房子门朝 +z，反之朝 -z）
    const zd = z < 0 ? z1 + 0.02 : z0 - 0.02
    const doorPts = [
      [x - 0.4, y0 + 0.15, zd], [x - 0.4, y0 + 1.5, zd],
      [x + 0.4, y0 + 1.5, zd], [x + 0.4, y0 + 0.15, zd]
    ]
    if (z < 0) doorPts.reverse() // 反转绕序，让法线朝 +z 的河面
    mesh.quad(houses, doorPts[0], doorPts[1], doorPts[2], doorPts[3], doorC)
  }
  for (let sg = -1; sg <= 1; sg += 2) {
    house(sg * 38, -14, 4.2, 3.4)
    house(sg * 46, -22, 3.8, 3.2)
    house(sg * 55, -13, 4.4, 3.6)
    house(sg * 64, -25, 4.0, 3.3)
    house(sg * 49, 12, 3.9, 3.4)
    house(sg * 60, 17, 4.3, 3.5)
    house(sg * 72, -18, 4.1, 3.4)
    house(sg * 80, 11, 3.8, 3.2)
    house(sg * 34, -30, 3.6, 3.0)
    house(sg * 44, 24, 4.0, 3.2)
    house(sg * 68, 14, 4.2, 3.4)
  }

  return { road: road, greens: greens, houses: houses }
}

// ================= 场景装配 =================

function buildScene() {
  const pieces = []
  const rings = []

  // ---- 1. 桥台五层条石基础 + 桥台体 ----
  const found = foundationStrips()
  const [fb0, fb1] = [T.base[0], T.base[0] + (T.base[1] - T.base[0]) * 0.55]
  for (let i = 0; i < found.length; i++) {
    const p = found[i]
    const t0 = fb0 + (p.floor / FOUND_N) * (fb1 - fb0)
    pieces.push({
      id: 'found-' + i, group: 'found', kind: 'mesh',
      mesh: p.mesh, pivot: p.center,
      t0: t0, t1: t0 + (fb1 - fb0) * 0.5,
      inOffset: [0, -4, 0], mode: 'rise', color: C.found
    })
  }
  const baseParts = wallStrips(false, true)
  const [b0, b1] = T.base
  for (let i = 0; i < baseParts.length; i++) {
    const p = baseParts[i]
    const d = (Math.abs(p.ax) - ABUT_X0) / ABUT_LEN
    const t0 = b0 + (b1 - b0) * 0.35 * d
    pieces.push({
      id: 'base-' + i, group: 'base', kind: 'mesh',
      mesh: p.mesh, pivot: p.center,
      t0: t0, t1: t0 + (b1 - b0) * 0.6,
      inOffset: [0, -5, 0], mode: 'rise', color: C.base
    })
  }

  // ---- 2. 28 道拱券 ----
  for (let i = 0; i < RING_N; i++) {
    rings.push({
      index: i,
      t0: T.arch[0] + i * RING_STAGGER,
      t1: T.arch[0] + i * RING_STAGGER + RING_DUR
    })
  }

  // ---- 3. 护拱石（拱券砌完之后压在拱背上）----
  for (let i = 0; i < 2; i++) {
    const sign = i === 0 ? 1 : -1
    const t0 = T.arch[1] - 0.9
    pieces.push({
      id: 'haunch-' + i, group: 'haunch', kind: 'mesh',
      mesh: haunchMesh(sign), pivot: [sign * HALF_SPAN * 0.55, 3.2, 0],
      t0: t0, t1: t0 + 1.1,
      inOffset: [0, 0, 0], mode: 'fade', color: C.haunch,
      // 护拱石贴着拱背走、上缘顶着桥面底，两个邻面的真实深度都只差
      // 0.2~0.3 m。给 −0.2（与桥面的 −0.35 差 0.15 档）：桥面皮肤啃不动
      // 它的上缘，它也反咬不了脚下贴合的拱背和身旁的侧墙
      dBias: -0.2
    })
  }

  // ---- 3.5 小拱洞的底影。洞的进深全靠这一条暗带 ----
  pieces.push({
    id: 'tunnel', group: 'tunnel', kind: 'mesh',
    mesh: tunnelShadowMesh(), pivot: [SMALL[1].xc, 4.5, 0],
    t0: T.small[0], t1: T.small[0] + 1.2,
    inOffset: [0, 0, 0], mode: 'fade', color: C.tunnel,
    hideInSolid: true
  })

  // ---- 4. 拱上侧墙（敞肩 / 实肩两套，顺序一一对应）----
  const openParts = wallStrips(true, false)
  const solidParts = wallStrips(false, false)
  const [s0, s1] = T.span
  for (let i = 0; i < openParts.length; i++) {
    const p = openParts[i]
    const d = Math.abs(p.ax) / ABUT_X1
    const t0 = s0 + d * (s1 - s0) * 0.5
    pieces.push({
      id: 'span-' + i, group: 'span', kind: 'mesh',
      mesh: p.mesh,
      alt: solidParts[i] ? solidParts[i].mesh : null,
      pivot: p.center,
      t0: t0, t1: t0 + (s1 - s0) * 0.62,
      inOffset: [0, -4, 0], mode: 'rise', color: C.span
    })
  }

  // ---- 5. 四个小拱 ----
  const [m0, m1] = T.small
  for (let i = 0; i < 4; i++) {
    const idx = i % 2
    const side = i < 2 ? 1 : -1
    const s = SMALL[idx]
    const t0 = m0 + (m1 - m0) * (i / 4) * 0.6
    pieces.push({
      id: 'small-' + i, group: 'small', kind: 'mesh',
      mesh: smallRingMesh(idx, side),
      pivot: [side * s.xc, s.spring + s.f * 0.5, 0],
      t0: t0, t1: t0 + (m1 - m0) * 0.7,
      inOffset: [0, 0, 7], mode: 'fly', color: C.small,
      hideInSolid: true,
      // 比桥面少压 0.15：券背顶到桥面底只差一步。全同偏置（−0.35）时
      // 券面会在洞口边缘反过来啃墙端面——墙与券背的真实深度只差
      // 0.3 m 上下。差 0.15 档正好落在两侧交界缝（0.2~0.3 m）之间：
      // 桥面不啃券顶，券面也啃不动洞口边缘
      dBias: -0.2
    })
  }

  // ---- 6. 桥面 ----
  const deckParts = deckSegments()
  const [d0, d1] = T.deck
  for (let i = 0; i < deckParts.length; i++) {
    const p = deckParts[i]
    const d = Math.abs(p.ax) / DECK_HALF
    const t0 = d0 + d * (d1 - d0) * 0.5
    pieces.push({
      id: 'deck-' + i, group: 'deck', kind: 'mesh',
      mesh: p.mesh, pivot: p.center,
      t0: t0, t1: t0 + (d1 - d0) * 0.62,
      inOffset: [0, 3.5, 0], mode: 'drop', color: C.deck,
      // 桥面要永远盖住底下 0.5～0.7 m 的墙顶/洞顶，是全桥排序余量最小的
      // 一层，往相机方向压 0.35 m 兜底。栏板顶比桥面顶高 0.78 m，54° 俯视
      // 时近 0.63 m，压 0.35 m 不会反过来吃掉栏板；推车挂同一偏置，轮底
      // 贴着桥面也不会被桥面啃掉。
      dBias: -0.35
    })
  }

  // ---- 7. 栏板望柱 ----
  const [r0, r1] = T.rail
  for (let i = 0; i < 2; i++) {
    const sign = i === 0 ? 1 : -1
    const t0 = r0 + (r1 - r0) * i * 0.3
    pieces.push({
      id: 'rail-' + i, group: 'rail', kind: 'mesh',
      mesh: railPiece(sign),
      pivot: [0, deckTop(0), sign * (halfWidth(0) + 0.09)],
      t0: t0, t1: t0 + (r1 - r0) * 0.7,
      inOffset: [0, 4, 0], mode: 'drop', color: C.rail
      // 比桥面再压 0.15：栏板立在桥面边上，望柱基脚埋进桥面 6 cm，
      // 交界一排像素上桥面的平均深度（整格 1.2 m 的均值）总比栏板基脚
      // 的真实深度远，基脚就被桥面啃出锯齿。−0.5 只在基脚 0.15 m 内
      // 赢回排序；从桥对岸看过来，栏板内侧面与近侧桥面差着整条桥宽的
      // 真实深度，偏置翻不动，不会反过来吃桥面
      , dBias: -0.5
    })
  }

  return {
    pieces: pieces, rings: rings,
    terrain: terrainMesh(), scenery: sceneryMeshes(), total: TOTAL
  }
}

module.exports = {
  slabMesh, mesh,
  C, T, TOTAL, SMALL, RING_N, BRIDGE_W, HW_CROWN, HW_SPRING, BANK_H, BANK_X, BED_Y,
  BANK_KNEE, BANK_KNEE_Y,
  SPAN, HALF_SPAN, RISE, R_IN, R_OUT, CY, HALF_TH, SPRING_Y,
  DECK_HALF, DECK_CROWN, DECK_END, DECK_TH, DECK_R, DECK_CY,
  ABUT_X0, ABUT_X1, ABUT_LEN, ABUT_HW, ABUT_TOP, ABUT_BOT, FOUND_N, FOUND_T,
  FOUND_BOT, ABUT_EDGE, RAIL_PANEL,
  groundY, archIntrados, archExtrados, halfWidth, haunchTop, wallBottom, soilTone,
  deckTop, deckBottom, smallIntrados, smallExtrados, smallAt,
  TERRAIN_ZS, TERRAIN_XS, terrainMesh,
  ringMesh, keystoneMesh, smallRingMesh, haunchMesh, railPiece, deckSegments,
  setDetail, ringSegs, smallSegs, DETAIL, SPANDREL, RING_DUR,
  buildScene
}
