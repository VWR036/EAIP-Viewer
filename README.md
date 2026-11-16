# EAIP-Viewer

中国航空资料汇编 PDF 阅读器（Vue 3 + Vite）。沿用原 NAIP-Viewer 界面与 PDF.js 阅读器，第一阶段提供 EAIP 机场航图和总资料 PDF 预览，并保留独立 AIRAC 数据模块。

## 准备数据

Python 3.9+，无第三方 Python 依赖。克隆仓库后，将单独获取的资料放入项目内部，无需创建目录联接。

- EAIP：将原始 `EAIP2026-11.V1.5_Web/Data/` 下的全部内容放到项目的 `public/data/eaip/` 中，必须包含 `Customers.js`、`JsonPath/` 和版本目录，不能只放 PDF，也不要额外嵌套一层 `Data/`。
- AIRAC：将完整的 `Dataset/` 放到项目根目录，包含 `checksum.xml`、`Baseline/`、`Difference/` 和 `schema/`。

目录结构如下：

```text
EAIP-Viewer/
├── package.json
├── scripts/
├── src/
├── Dataset/                    # AIRAC 原始数据
│   ├── checksum.xml
│   ├── Baseline/
│   ├── Difference/
│   └── schema/
└── public/
    └── data/
        ├── eaip/               # EAIP 原始 Data 目录中的内容
        │   ├── Customers.js
        │   ├── JsonPath/
        │   └── EAIP2026-11.V1.5/
        │       ├── Terminal/
        │       ├── GeneralDoc/
        │       └── HtmlTemplate/
        ├── index/              # npm run index 生成
        └── airac-index/        # npm run index:airac 生成
```

资料包和生成索引均不入 Git，需要单独提供给使用者。只阅读 EAIP 航图时，可以不放 `Dataset`，也不用运行 `npm run index:airac`。EAIP 原始资料需要保留，预览时仍会加载其中的 PDF；AIRAC 前端读取生成的索引。

## 启动

放好资料后，在项目根目录执行：

```powershell
npm install
npm run index          # 读取 public/data/eaip，生成 EAIP 索引
npm run index:airac    # 读取 Dataset，生成 AIRAC 索引（按需执行）
npm run dev
```

打开 http://localhost:5173/。

两套索引独立生成，`npm run index` 不会生成 AIRAC 索引。首次使用、重新克隆项目或更换对应资料包后，需要运行相应的索引命令；索引已存在且资料未变时，直接运行 `npm run dev` 即可，无需每次重新生成。更换资料期时，更新 `public/data/eaip/` 中的内容或项目内的 `Dataset/`，重新生成对应索引并刷新页面。

## 第一阶段功能与数据规则

- 机场支持 ICAO、IATA、中英文名称搜索，航图按类别分组；支持缩放、适宽、适页、PDF 翻页、上一张/下一张、PgUp/PgDn、原始 PDF 和当前页打印。
- 使用 `pdfPath` / `Document` 映射原始 PDF，不根据页码推导文件名。SID、STAR、ILS、LOC、VOR、NDB、RNP/RNAV、机场图、障碍物图、航路点表和数据库编码表分别归类，混合 RNAV/RNP ILS 归入 ILS。
- 机场列表按 PDF 路径去重，同一份细则只列一次。总资料保留章节目录，可任意层级展开并搜索中英文标题；共用 PDF 的章节仍打开整份文件，尚不支持章节定位。
- 资料目录使用 GEN、ENR、AD、AMDT、SUP、AIC、NOTAM；不重复导入合并版 AIP.js。修订状态来自原始标记；航图名称中的 SUPAR 不表示 SUP，补充资料在 SUP 目录独立展示。
- 机场摘要取自机场 AD_AIP 数据，保留原始标高、磁差及跑道方向尺寸。ZWTN 未发布结构化摘要，仍可预览全部机场 PDF。
- 页面版本采用实际数据目录名；资料声明版本另存 `DeclaredVersion` 并可在首页版本处悬停查看。生效时间采用 `EffectiveDate`（UTC），原始 `EffectiveShow`、截止时间和发布日期也保存在 meta.json，不混用。
- 旧 CSV“航路数据”入口已移除；旧解析脚本和组件保留，AIRAC 模块仍独立读取 Dataset。本阶段不提供 HTML 阅读、中英文正文切换或 AIRAC 与航图联动。

## 部署

`vite.config.js` 保持 `copyPublicDir: false`，不把原始资料复制进构建产物。静态部署需要另外提供完整 `dist/data`，包含 `index`、`eaip` 和 `airac-index`；可将项目的 `public/data` 整体复制到 `dist/data`。

## 验证

```powershell
python -m unittest discover -s scripts -p "test_eaip_index.py"
```

测试覆盖混合进近分类、SUPAR、数据赋值解析、缺失 PDF、越界路径、重复 ID、缺失父节点、目录循环，以及本机资料包所有 PDF 的索引覆盖和机场去重。索引脚本在输入校验完成后才写出 JSON；缺失文件或错误关系明确失败。
开发验证不运行生产构建。

## AIRAC 数据（第一阶段）

新增模块使用 Vue 3 + Ant Design Vue；旧模块保留原有界面。Python 3.9+，无需第三方 Python 包。

在项目根目录执行：

```powershell
npm install
npm run index:airac
# 其他完整 Dataset 目录：
npm run index:airac -- --source "C:/path/to/Dataset"
npm run dev
```

`npm run index:airac` 调用 `scripts/build_airac_index.py`，默认读取项目内的 `Dataset/`，生成 `public/data/airac-index/`。更换 Dataset 后需重新运行此命令并刷新页面；索引不入 Git，新环境需要重新生成。脚本输出由脚本所在项目定位，不依赖调用目录。
界面进入后展开左侧导航，选择 **AIRAC 数据**。旧 CSV 索引缺失不阻止 AIRAC。
机场搜索支持名称、ICAO、IATA；空域和公共数据不受搜索影响。

脚本校验 checksum.xml 的所有文件（含 Difference）及 SHA-256，仅解析 Baseline 的顶层 18 类对象。
所有引用目标必须存在；有效状态的引用目标也必须有效。多条不重叠 BASELINE 可按有效期选择；重叠 BASELINE、非 BASELINE 和其他未支持时间语义明确失败，不重建 delta。
有效期开始含、结束不含，unknown 结束保留原义；没有有效状态的原始对象保留在索引并列入诊断。
属性保留命名空间、嵌套、重复节点、nil、备注和原单位。XML 是重新序列化对象片段。

索引位于 `public/data/airac-index/`，不入 Git。不可变快照子目录包含 objects.json 和 relations.json，manifest.json 原子切换快照入口；失败不更新旧索引。快照目录名由内容哈希产生，相同输入可复现。
现有 `vite.config.js` 的 `copyPublicDir: false` 保持不变；部署时需另行提供整个 `public/data` 目录（包含 AIRAC 快照），否则索引请求失败。
AIRAC 顶栏可切换 **数据浏览 / 地图**。地图使用 Leaflet 原生 Canvas 绘制机场 ARP、指定点、Navaid 整体及航段，四层默认开启。地图搜索独立于机场树，支持机场 ICAO/IATA/名称、指定点和导航设施代码/名称、航路编号；结果保留 ID，同名对象可分别选择，最多显示 50 项并提示剩余数量。
点击点或航段可查看关键属性及详情，点击航段所属航路可高亮其全部可绘制航段；重叠位置可在候选列表访问其他航段及航路。无位置对象仍可搜索和查看详情，地图诊断区分合法缺失、无效几何及不可绘制航段。内部切换数据详情和地图保留视野及图层选择。直线仅表达端点关系，不表示实际飞行轨迹或可飞方向。

地图复用已加载的索引，不额外读取 Dataset；坐标只支持已确认的 EPSG:4326（原始纬度、经度），位置缺失不补点。新增依赖仅 `leaflet`，其 CSS 随应用加载。首版深浅主题作用于控件及覆盖层，底图保持同一 OSM 样式。
底图通过网络加载 `https://tile.openstreetmap.org/{z}/{x}/{y}.png`，保留可见的 [© OpenStreetMap contributors](https://www.openstreetmap.org/copyright) 署名；瓦片失败会提示并允许重试，已加载的覆盖层仍可交互。OSM 公共瓦片仅适合开发和轻量访问，上线前核对 [瓦片使用政策](https://operations.osmfoundation.org/policies/tiles/)，高流量部署需另选供应商或自托管；不批量预取、不提供离线下载。

若当前网络无法访问 OSM，可在项目根目录 `.env.local` 中同时设置 `VITE_AIRAC_TILE_URL`（服务商提供的 `{z}/{x}/{y}` 瓦片 URL 模板）和 `VITE_AIRAC_TILE_ATTRIBUTION`（该服务要求的署名，可包含链接），然后重启开发服务器。部署时需在编译环境中设置这两个变量。仅支持适用于 Leaflet 默认 EPSG:3857、与 WGS84 数据对齐的标准 XYZ 栅格服务，不使用有 GCJ-02/BD-09 偏移的底图。未配置时使用 OSM；请求失败不会自动切换服务。不要在前端变量中放置私密凭据。警告显示失败服务域名，失败瓦片成功加载或移出加载范围后会清除对应状态。
本阶段不提供编辑、差异合并、空域/跑道几何、三维、实时航迹、全对象搜索或后端。

数据与异常测试：`python -m unittest discover -s scripts -p "test_airac_index.py"`。
地图转换测试：`node --test scripts/test_airac_map.mjs`（Node 内置测试，无新增测试框架；本地索引存在时同时验证真实快照）。
开发验证禁止运行生产构建；可使用 Vite 开发预览及 Vue SFC 编译检查。
