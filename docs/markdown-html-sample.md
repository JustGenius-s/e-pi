# Markdown + HTML 混合预览样例

This file exercises inline HTML inside markdown. Delete after verifying.

## 内嵌 HTML 标签

<p align="center"><b>居中加粗段落</b>（<i>斜体</i> + <u>下划线</u>）</p>

<div style="padding:8px 12px;border:1px solid #ccc;border-radius:8px">
  <b>div 容器</b>：边框 + 圆角 + 内边距，来自 style 属性。
</div>

### 表格（HTML 写法）

<table>
  <tr><th>Name</th><th>Role</th><th>Status</th></tr>
  <tr><td>Alice</td><td>PM</td><td>✅</td></tr>
  <tr><td>Bob</td><td>Dev</td><td>🔄</td></tr>
</table>

### 图片

<img src="./images/banner.webp" width="320" alt="local image placeholder" />

（本地图片会渲染为可点击的占位按钮 → 打开图片预览）

### 列表与代码混排

<ul>
  <li>HTML 无序列表项一</li>
  <li>HTML 无序列表项二</li>
</ul>

```ts
// 普通 fenced code block 不受影响
const html = "still works";
```

### 危险标签应被过滤

<script>alert('xss')</script> 不应执行；<iframe src="https://example.com"></iframe> 不应渲染；<img src="x" onerror="alert(1)"> 的 onerror 应被剥离。
