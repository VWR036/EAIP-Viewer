# EAIP-Viewer

中国航空资料汇编 PDF 阅读器（Vue 3 + Vite）。沿用原 NAIP-Viewer 界面与 PDF.js 阅读器，第一阶段提供 EAIP 机场航图和总资料 PDF 预览，并保留独立 AIRAC 数据模块。

## 准备数据

Python 3.9+，无第三方 Python 依赖。克隆仓库后，将单独获取的资料放入项目内部，无需创建目录联接。

- EAIP：将原始 `EAIP2026-11.V1.5_Web/Data/` 下的全部内容放到项目的 `public/data/eaip/` 中，必须包含 `Customers.js`、`JsonPath/` 和版本目录，不能只放 PDF，也不要额外嵌套一层 `Data/`。
- AIRAC：将完整的 `Dataset/` 放到项目根目录，包含 `checksum.xml`、`Baseline/`、`Difference/` 和 `schema/`。

目录结构如下，项目文件夹叫 `EAIP-Viewer` 或 `NAIP-Viewer` 都不影响使用：

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
本阶段不提供地图、编辑、差异合并、全对象搜索或后端。

数据与异常测试：`python -m unittest discover -s scripts -p "test_airac_index.py"`。
开发验证禁止运行生产构建；可使用 Vite 开发预览及 Vue SFC 编译检查。

### 本地验证记录（2026-11-13）

- 30 个清单文件 SHA-256 通过，Baseline 18 类共 10,242 个对象、13,080 条引用全部可解析。全部对象在目标生效时刻有效，均为单时间片；空域八类计数与实施文档一致。
- 独立从 XML 核对 ZBAA：3 跑道、19 导航设施、0 指定点、7 关联航段、5 关联航路；ZSPD：4、13、24、72、28。方向、中线点、设备和去重关系均已逐项核对。85 个指定点机场引用全部检查通过。
- 11 项 Python 测试通过，异常测试确认失败不会替换已有 manifest。相同输入生成相同快照。
- Vue SFC 编译检查通过；Vite 开发浏览验证了缺旧 CSV 索引仍可进入 AIRAC、IATA/ICAO 不区分大小写搜索、无匹配状态、空分类、面包屑、关联列表及跳转、来源 XML、深浅色主题。
- 原 NAIP 原始数据和 CSV 索引缺失，旧模块的完整 PDF/表格内容无法核验。未运行生产构建、未提交或发布。
- 当前对象 JSON 约 79 MB，首次进入需加载完整索引，后续复用内存；尚未做分片加载。重叠时间片和 delta 状态重建明确不支持。

实际数据与实施文档差异：`onRunway` 的目标是 RunwayDirection，不是 Runway；本地 `schema/aixm511/xsd/AIXM_Features.xsd` 的 RunwayCentrelinePoint 定义也声明为 RunwayDirectionPropertyType。因此中线点按 `onRunway → RunwayDirection → usedRunway → Runway` 聚合；487 条原始引用路径全部保留，未猜测或改写原数据。

修正后再次验证通过：ZBAA 为 6 个跑道方向、16 个中线点；ZSPD 为 8 个跑道方向、22 个中线点。前端加载逻辑另以隔离 fetch 验证 404、无效 JSON、非法索引路径、真实快照结构和已加载索引复用，均通过。
