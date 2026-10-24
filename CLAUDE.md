# CLAUDE.md — 赵州桥 3D 展示小程序

本文件是 Claude Code 在本仓库工作时必须遵守的项目规范。所有代码生成、修改、重构都要以下面的约束为准。

---

## 1. 项目定位

- 这是一个**微信小程序**，不是 Web 网页，不是 React/Vue 项目。
- 用途：课堂说课演示，展示赵州桥的结构与泄洪原理。最终会被录屏成视频放进 PPT，但小程序本身要能在微信开发者工具的模拟器里跑起来。
- 不需要用户登录、不需要后端、不需要云开发、不需要网络请求。所有内容写死在前端。

## 2. 技术栈（硬约束）

- **语言**：原生 JavaScript（不是 TypeScript）。
- **样式**：WXSS（不是 CSS、不是 Sass、不是 Less）。
- **结构**：WXML（不是 HTML、不是 JSX）。
- **配置**：JSON（`app.json`、每个页面的 `.json`）。
- **不使用**：云开发、npm 第三方包、Skyline 渲染、框架（Taro/uni-app/WePY 都不要）。
- **渲染 3D / 动画**：使用微信小程序原生 `<canvas type="2d">`，通过 `wx.createSelectorQuery()` 获取 Canvas 节点和 `Canvas.getContext('2d')`。**不要**引 Three.js（小程序原生环境跑不了，也不需要）。

## 3. 目录结构

```
ZhaozhouBridge/
├── app.js              # 全局入口，不要随便改
├── app.json            # 全局配置（页面注册、窗口标题）
├── app.wxss            # 全局样式
├── pages/
│   ├── index/          # 主展示页（你主要写这里）
│   │   ├── index.wxml
│   │   ├── index.wxss
│   │   ├── index.js
│   │   └── index.json
│   └── logs/           # 模板自带的日志页，不要动
├── utils/
│   └── util.js         # 模板自带工具函数，不要动
├── sitemap.json
└── project.config.json
```

- 所有新代码写在 `pages/index/` 下。如果需要拆工具模块，新建 `utils/bridge.js`，不要污染模板文件。
- `app.json` 里已注册的页面是 `pages/index/index` 和 `pages/logs/logs`，**不要随便加页面、不要删 logs**。
- 页面标题在 `app.json` 的 `window.navigationBarTitleText` 里改，不要在 wxml 里写假标题。

## 4. 小程序语法规则（Claude 最容易写错的地方）

生成 WXML / WXSS / JS 时必须遵守：

### WXML
- 标签是 `<view>`、`<text>`、`<button>`、`<canvas>`、`<slider>`，**不要用 `<div>`、`<span>`、`<p>`、`<input type="range">`**。
- 数据绑定用 `{{ }}`，事件绑定用 `bindtap`、`bindchange`、`bindinput`。
- 列表渲染用 `<view wx:for="{{list}}" wx:key="id">`，不是 `.map()`。
- 条件渲染用 `wx:if="{{condition}}"`，不是三元表达式塞进 JSX。

### WXSS
- 盒模型、flex 布局可用。
- **不要用** CSS 变量、`@media`、`gap`（兼容性看基础库，能用 flex 间距代替就代替）、CSS 动画复杂关键帧（用 canvas 自己画动画帧更稳）。
- 尺寸单位用 `px`，不用 `rpx`。这一层浮层（`pages/index/index.wxml` 里 `.chrome` 包着的那一块）按 **390 pt 宽的设计空间**排版，运行时整体 `transform: scale(k)` 放大到设备宽度，`k = clamp(windowWidth / 390, 1, 1.3)`，在 `index.js` 的 `applySize()` 里算。
  为什么不用 `rpx`：`1rpx = 视口宽 / 750`，iPad 竖屏 820 pt 上就是 1.09 px，手机上只有 0.52 px——浮层会整体涨到两倍多，而 canvas 里的标注、三维机位都是死像素，两边尺度对不上，比例就散了（标题压副题、卡片压按钮、控制台吃掉半屏）。
  代价是 `vh` 也不能用了：`vh` 按设备真高算，放大之后 70vh 会变成九成屏高。凡是随视口变的量（卡片高度上限之类），都在 JS 里按设计空间算好再走行内 style。
- 宽屏版式不走 `@media`：`index.js` 的 `applySize()` 按缩放比给元素加类名（设备宽过 468pt 就给底部控制台加 `.compact`），宽屏专用的写法集中放在 `index.wxss` 末尾「平板：控制台压扁」一节。手机上 k=1，这一节一条也不生效。

### JS（Page 构造器）
- 页面逻辑写在 `Page({ data: {}, onLoad() {}, ... })` 里。
- 修改数据必须用 `this.setData({ key: value })`，**不要直接给 `this.data.xxx` 赋值**。
- 事件处理函数里拿到 event：`onWaterChange(e) { this.setData({ waterLevel: e.detail.value }) }`。
- canvas 节点获取必须在 `onReady` 生命周期里做，不能在 `onLoad`：
  ```js
  wx.createSelectorQuery()
    .select('#bridgeCanvas')
    .fields({ node: true, size: true })
    .exec((res) => { /* 拿 canvas node 和 ctx */ })
  ```

## 5. 功能需求（要实现什么）

这是说课演示要讲的内容，canvas 里画出来：

1. **赵州桥结构**：
   - 1 个主拱（大弧形拱桥）
   - 主拱肩上有 **4 个小拱**（敞肩拱，左右各 2 个）
   - 桥身由 **28 道拱券**并列拼成（视觉上用 28 条纵向分割线表现）
2. **搭建过程动画**：
   - 播放按钮触发，从无到有：先画主拱轮廓 → 4 个小拱逐个出现 → 28 道拱券逐道填充 → 桥面铺上。
   - 节奏要慢，配合讲解，每一步之间停顿清晰。
3. **洪水压力演示**：
   - 页面上放一个 `<slider>` 滑块，控制水量大小（0 ~ 100）。
   - 水流画在桥下：水量小的时候，水流从主拱下流过；水量大的时候，水位上升，**部分水流从 4 个小拱泄出**——这就是敞肩拱的原理。
   - 压力可视化：用颜色深浅或箭头粗细表示水流对桥体的压力，水越大压力越大，但小拱泄洪后主拱压力被分担。
4. **讲解标注**：
   - 用 `<text>` 或 canvas 文字标注："主拱"、"小拱（4个）"、"28道拱券"，对应结构位置。

## 6. 视觉风格

- 古风水墨/素雅路线：背景米白 `#f5f1e8`，桥体青灰 `#8a8a8a`，水流淡蓝 `#7fb3d5`，强调色朱红 `#c0392b`（用于标注和滑块）。
- 不要花哨渐变、不要 emoji、不要卡通化。说课场景要稳重。

## 7. 禁止事项

- ❌ 不要 `npm install` 任何包，不要在 JS 里 `import` / `require` 第三方库。
- ❌ 不要写 HTML 标签、不要写 React/Vue 语法。
- ❌ 不要动 `pages/logs/`、`utils/util.js`、`app.js`、`app.wxss`。
- ❌ 不要在没有明确要求时改 `app.json` 的页面列表。
- ❌ 不要把动画写在 CSS `@keyframes` 里——所有动画帧由 canvas `requestAnimationFrame` 驱动，方便录屏。
- ❌ 不要在代码里留 `console.log` 之外的调试断点；报错信息要原样引用，不要自己编。

## 8. 报错与调试

- 运行报错去微信开发者工具的 Console 面板看，错误信息会带 `WAService.js` / `WKWebView` 前缀。
- 如果报 `xxx is not a function`，先怀疑是 API 名写错了——以微信官方文档为准，不要凭训练记忆补全。
- 模拟器选 iPhone 12/13，设计空间（390 pt）以这个宽度为基准；改样式后拿 iPad 竖屏（820×1180）也过一遍，两边的比例要一样。
- canvas 里的坐标也是设计空间的：`this.cw / this.ch` 是设计尺寸，绘制时用 `ctx.scale(k * dpr)` 放到设备像素。这样标注字号和浮层用同一把尺子。

## 9. 提交前自检

每次改完代码，自己过一遍：
1. WXML 里有没有混入 `<div>` / `<span>`？
2. JS 里有没有直接赋值 `this.data.xxx =` 而不是 `setData`？
3. canvas 节点是不是在 `onReady` 里取的？
4. 新增文件是不是放在了正确的目录？
5. 有没有不小心动了 logs 页或 app.js？
