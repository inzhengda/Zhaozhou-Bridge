const fs = require('fs')
const { PNG } = require('/tmp/pngtool/node_modules/pngjs')
const png = PNG.sync.read(fs.readFileSync(__dirname + '/out/build-full.png'))
// 水面区域竖向扫描：找出横向的亮度跳变行（缝），打印缝上/缝旁像素
for (const x of [215, 260]) {
  let prev = null
  for (let y = 500; y < 880; y++) {
    const i = (png.width * y + x) << 2
    const c = [png.data[i], png.data[i + 1], png.data[i + 2]]
    if (prev) {
      const d = Math.abs(c[0] - prev[0]) + Math.abs(c[1] - prev[1]) + Math.abs(c[2] - prev[2])
      if (d >= 6) console.log('x=' + x, 'y=' + y, prev.join(','), '→', c.join(','), 'd=' + d)
    }
    prev = c
  }
}
