/**
 * 假 CanvasRenderingContext2D：把小程序里那一套 ctx 调用录成 SVG。
 *
 * 目的不是"再实现一个渲染器"，而是让 tools/render.js 能在 Node 里
 * **原样跑 pages/index/index.js 的 draw()**——同一份代码，同一个画家算法，
 * 同一个排序结果。只有最后的"往像素上涂"这一步换成了拼 SVG 字符串。
 *
 * 覆盖范围就是 index.js 实际用到的那 25 个 API（grep 出来的全集）。
 * 用到其他 API 会直接抛错，不会安静地画错。
 *
 * 两点实现取舍：
 *   - 圆弧全部拍成折线。这样路径里只剩 M/L/Z，省掉 SVG 弧线命令的
 *     large-arc / sweep 两套标志位，也不会在扫描方向上和 canvas 理解不一致。
 *     index.js 里的弧都很小（圆角、铁拉杆断面点），拍折线的误差在 0.1 px 量级。
 *   - 坐标只保留 2 位小数。一张全景图能有两万个多边形，省下的体积很可观。
 */

const TAU = Math.PI * 2

function num(v) {
  const r = Math.round(v * 100) / 100
  return r === 0 ? 0 : r      // 消掉 -0
}

function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// 字体串形如 '10px sans-serif' / 'bold 11px sans-serif'
function parseFont(font) {
  const m = /(\d+(?:\.\d+)?)px/.exec(font || '')
  const size = m ? parseFloat(m[1]) : 10
  const bold = /\bbold\b/.test(font || '')
  return { size, bold }
}

class SvgContext {
  constructor(width, height) {
    this.width = width
    this.height = height

    this.fillStyle = '#000000'
    this.strokeStyle = '#000000'
    this.lineWidth = 1
    this.globalAlpha = 1
    this.font = '10px sans-serif'
    this.textAlign = 'left'
    this.textBaseline = 'alphabetic'
    this.lineCap = 'butt'
    this.lineJoin = 'miter'

    this._defsArr = []        // <defs> 里的东西（渐变、裁剪）
    this._defCount = 0
    this._grads = []          // 延迟到 toSVG 时按需收进 defs
    this._out = []            // 正文元素
    this._stack = []

    this._d = ''              // 当前路径
    this._x = 0               // 当前点
    this._y = 0
    this._sx = 1              // 当前变换（只支持缩放 + 平移）
    this._sy = 1
    this._tx = 0
    this._ty = 0
    this._dash = null
  }

  // ---------- 变换 ----------

  _px(x) { return x * this._sx + this._tx }
  _py(y) { return y * this._sy + this._ty }

  scale(sx, sy) {
    this._sx *= sx
    this._sy = sy === undefined ? this._sy * sx : this._sy * sy
  }

  translate(tx, ty) {
    this._tx += tx * this._sx
    this._ty += ty * this._sy
  }

  setLineDash(arr) { this._dash = arr && arr.length ? arr : null }

  // ---------- 状态 ----------

  save() {
    this._stack.push({
      fillStyle: this.fillStyle, strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth, globalAlpha: this.globalAlpha,
      font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline,
      lineCap: this.lineCap, lineJoin: this.lineJoin,
      sx: this._sx, sy: this._sy, tx: this._tx, ty: this._ty,
      dash: this._dash, openedGroup: false
    })
  }

  restore() {
    const s = this._stack.pop()
    if (!s) return
    if (s.openedGroup) this._out.push('</g>')
    this.fillStyle = s.fillStyle; this.strokeStyle = s.strokeStyle
    this.lineWidth = s.lineWidth; this.globalAlpha = s.globalAlpha
    this.font = s.font; this.textAlign = s.textAlign
    this.textBaseline = s.textBaseline
    this.lineCap = s.lineCap; this.lineJoin = s.lineJoin
    this._sx = s.sx; this._sy = s.sy; this._tx = s.tx; this._ty = s.ty
    this._dash = s.dash
  }

  // ---------- 路径 ----------

  beginPath() { this._d = ''; this._started = false }

  _move(x, y) {
    const px = this._px(x), py = this._py(y)
    this._d += `M${num(px)} ${num(py)}`
    this._x = x; this._y = y
    this._started = true
  }

  _line(x, y) {
    const px = this._px(x), py = this._py(y)
    this._d += `L${num(px)} ${num(py)}`
    this._x = x; this._y = y
  }

  moveTo(x, y) { this._move(x, y) }
  lineTo(x, y) { if (!this._started) this._move(x, y); else this._line(x, y) }

  closePath() { this._d += 'Z' }

  rect(x, y, w, h) {
    this._move(x, y)
    this._line(x + w, y)
    this._line(x + w, y + h)
    this._line(x, y + h)
    this._d += 'Z'
  }

  arc(cx, cy, r, a0, a1, anticlockwise) {
    let start = a0, end = a1
    let da = end - start
    if (anticlockwise) {
      while (da > 0) da -= TAU
      while (da < -TAU) da += TAU
    } else {
      while (da < 0) da += TAU
      while (da > TAU) da -= TAU
    }
    // 折线拍弧。段数按屏幕上约 1.5 px 弦高定，最少 6 段、最多 128 段
    const rp = Math.abs(r * this._sx)
    const steps = Math.max(6, Math.min(128, Math.ceil((Math.abs(da) * rp) / 1.5)))
    const sx = cx + Math.cos(start) * r
    const sy = cy + Math.sin(start) * r
    if (!this._started) this._move(sx, sy)
    else this._line(sx, sy)
    for (let i = 1; i <= steps; i++) {
      const a = start + (da * i) / steps
      this._line(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
    }
  }

  /**
   * 标准 arcTo：从当前点到 (x1,y1) 的直线与 (x1,y1)→(x2,y2) 的直线之间
   * 内切一段半径 r 的圆角。半径过大时按 canvas 的规矩收缩到两段直线能容下的最大值。
   */
  arcTo(x1, y1, x2, y2, radius) {
    if (!this._started) { this._move(x1, y1); return }
    const x0 = this._x, y0 = this._y
    if ((x0 === x1 && y0 === y1) || (x1 === x2 && y1 === y2) || radius <= 0) {
      this._line(x1, y1); return
    }
    const dx1 = x0 - x1, dy1 = y0 - y1
    const dx2 = x2 - x1, dy2 = y2 - y1
    const l1 = Math.hypot(dx1, dy1), l2 = Math.hypot(dx2, dy2)
    if (l1 < 1e-9 || l2 < 1e-9) { this._line(x1, y1); return }
    const u1x = dx1 / l1, u1y = dy1 / l1
    const u2x = dx2 / l2, u2y = dy2 / l2
    const cosA = Math.max(-1, Math.min(1, u1x * u2x + u1y * u2y))
    const angle = Math.acos(cosA)
    if (!(angle > 1e-9) || Math.abs(angle - Math.PI) < 1e-9) { this._line(x1, y1); return }
    const tanD = Math.min(radius / Math.tan(angle / 2), l1, l2)
    const r = tanD * Math.tan(angle / 2)
    const t1x = x1 + u1x * tanD, t1y = y1 + u1y * tanD
    const t2x = x1 + u2x * tanD, t2y = y1 + u2y * tanD
    this._line(t1x, t1y)
    let mx = u1x + u2x, my = u1y + u2y
    const ml = Math.hypot(mx, my) || 1
    const dist = r / Math.sin(angle / 2)
    const cx = x1 + (mx / ml) * dist
    const cy = y1 + (my / ml) * dist
    const a1 = Math.atan2(t1y - cy, t1x - cx)
    const a2 = Math.atan2(t2y - cy, t2x - cx)
    let da = a2 - a1
    while (da <= -Math.PI) da += TAU
    while (da > Math.PI) da -= TAU
    this.arc(cx, cy, r, a1, a1 + da, da < 0)
  }

  // ---------- 上色 ----------

  _paint(style) {
    if (style && style.__gradient) {
      const g = style.__gradient
      // 同一个渐变对象可能被 fill 上千次，id 记在对象上，只登记一次
      if (!g.id) {
        g.id = `grad${this._grads.length}`
        this._grads.push(g)
      }
      return `url(#${g.id})`
    }
    return style
  }

  _alphaAttr() {
    return this.globalAlpha < 1 ? ` opacity="${num(this.globalAlpha)}"` : ''
  }

  _strokeAttrs() {
    let s = ` stroke="${this._paint(this.strokeStyle)}" stroke-width="${num(this.lineWidth * this._sx)}"`
    if (this.lineCap !== 'butt') s += ` stroke-linecap="${this.lineCap}"`
    if (this.lineJoin !== 'miter') s += ` stroke-linejoin="${this.lineJoin}"`
    if (this._dash) s += ` stroke-dasharray="${this._dash.map(num).join(' ')}"`
    return s
  }

  fill() {
    if (!this._d) return
    this._out.push(`<path d="${this._d}" fill="${this._paint(this.fillStyle)}"${this._alphaAttr()}/>`)
  }

  stroke() {
    if (!this._d) return
    this._out.push(`<path d="${this._d}" fill="none"${this._strokeAttrs()}${this._alphaAttr()}/>`)
  }

  clip() {
    if (!this._d) return
    const id = `clip${this._defCount++}`
    this._defsArr.push(`<clipPath id="${id}"><path d="${this._d}"/></clipPath>`)
    this._out.push(`<g clip-path="url(#${id})">`)
    // 这个 <g> 要在配对的 restore() 里关掉。没先 save() 就 clip 的，
    // canvas 的行为是裁剪一直生效到 restore——这里退化成不闭合，
    // 所以顺手抛个错，别让它安静地画出错图
    const top = this._stack[this._stack.length - 1]
    if (!top) throw new Error('ctx.clip() 前没有 save()，配对不上')
    top.openedGroup = true
  }

  fillRect(x, y, w, h) {
    const x0 = this._px(x), y0 = this._py(y)
    const ww = w * this._sx, hh = h * this._sy
    this._out.push(
      `<rect x="${num(x0)}" y="${num(y0)}" width="${num(ww)}" height="${num(hh)}"` +
      ` fill="${this._paint(this.fillStyle)}"${this._alphaAttr()}/>`
    )
  }

  clearRect(x, y, w, h) {
    const x0 = this._px(x), y0 = this._py(y)
    this._out.push(
      `<rect x="${num(x0)}" y="${num(y0)}" width="${num(w * this._sx)}" height="${num(h * this._sy)}"` +
      ` fill="#000" fill-opacity="0"/>`
    )
  }

  strokeRect(x, y, w, h) {
    const d = `M${num(this._px(x))} ${num(this._py(y))}` +
      `L${num(this._px(x + w))} ${num(this._py(y))}` +
      `L${num(this._px(x + w))} ${num(this._py(y + h))}` +
      `L${num(this._px(x))} ${num(this._py(y + h))}Z`
    this._out.push(`<path d="${d}" fill="none"${this._strokeAttrs()}${this._alphaAttr()}/>`)
  }

  // ---------- 文字 ----------

  /** 粗糙的字宽估算：CJK/全角按 1.0 em，其余按 0.55 em。够 index.js 摆标签底用了 */
  measureText(text) {
    const { size } = parseFont(this.font)
    let units = 0
    for (const ch of String(text)) units += ch.charCodeAt(0) > 0x2e7f ? 1.0 : 0.55
    return { width: units * size }
  }

  fillText(text, x, y) {
    if (text === '' || text === null || text === undefined) return
    const { size, bold } = parseFont(this.font)
    const anchor = this.textAlign === 'center' ? 'middle'
      : this.textAlign === 'right' || this.textAlign === 'end' ? 'end' : 'start'
    let baseline = 'auto'
    if (this.textBaseline === 'middle') baseline = 'central'
    else if (this.textBaseline === 'top') baseline = 'hanging'
    else if (this.textBaseline === 'bottom') baseline = 'text-after-edge'

    let s = `<text x="${num(this._px(x))}" y="${num(this._py(y))}"` +
      ` font-size="${num(size * this._sy)}" font-family="sans-serif"`
    if (bold) s += ' font-weight="bold"'
    if (anchor !== 'start') s += ` text-anchor="${anchor}"`
    if (baseline !== 'auto') s += ` dominant-baseline="${baseline}"`
    s += ` fill="${this._paint(this.fillStyle)}"${this._alphaAttr()}>${esc(text)}</text>`
    this._out.push(s)
  }

  // ---------- 渐变 ----------

  createLinearGradient(x0, y0, x1, y1) {
    const stops = []
    return {
      __gradient: {
        kind: 'linear',
        x0: this._px(x0), y0: this._py(y0),
        x1: this._px(x1), y1: this._py(y1),
        stops
      },
      addColorStop(offset, color) { stops.push([offset, color]) }
    }
  }

  // ---------- 输出 ----------

  toSVG() {
    let defs = ''
    if (this._grads.length) {
      defs += this._grads.map((g) => {
        const stops = g.stops.map(([o, c]) =>
          `<stop offset="${num(o)}" stop-color="${c}"/>`).join('')
        return g.kind === 'linear'
          ? `<linearGradient id="${g.id}" gradientUnits="userSpaceOnUse"` +
            ` x1="${num(g.x0)}" y1="${num(g.y0)}" x2="${num(g.x1)}" y2="${num(g.y1)}">${stops}</linearGradient>`
          : ''
      }).join('')
    }
    if (this._defsArr.length) defs += this._defsArr.join('')
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}"` +
      ` viewBox="0 0 ${this.width} ${this.height}">` +
      (defs ? `<defs>${defs}</defs>` : '') +
      this._out.join('') +
      '</svg>'
  }
}

module.exports = { SvgContext }
