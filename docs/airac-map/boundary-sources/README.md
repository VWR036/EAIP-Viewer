# 外部边界数据来源

这些文件用于 AIRAC 地图的参考边界补全，与 Dataset 原始 XML 分开保存。当前下载日期为 2026-11-19。原始文件的 SHA-256 记录在生成的 `public/data/airac-boundaries.json` 中。

## 国界参考线

- 数据：[Natural Earth Admin 0 – Boundary Lines, 1:10m](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-admin-0-boundary-lines/)。这里的 1:10m 是一千万分之一比例尺，不是十米精度。
- 下载：[维护者仓库中的 GeoJSON](https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_boundary_lines_land.geojson)。本地原始文件为 `ne_10m_admin_0_boundary_lines_land.geojson`。
- 许可：[Public domain](https://www.naturalearthdata.com/about/terms-of-use/)。
- 坐标为 GeoJSON 经度、纬度，WGS84。
- 只保留与 CHN 相邻的国界线，排除香港、澳门内部行政界线；采用源数据 `FCLASS_CN` 分类，排除该分类中标为 `Unrecognized` 的替代线。该筛选不构成对边界的独立确认。
- 没有把断开的国界线之间补成直线，也没有把海岸线当作国界。跨断开分量的请求仍留作未补全。

## 香港边界参考

- 官方数据：[District boundary – Home Affairs Department, DATA.GOV.HK](https://data.gov.hk/en-data/dataset/hk-had-json1-hong-kong-administrative-boundaries)。
- 下载：[18 区行政区 GeoJSON](https://www.had.gov.hk/psi/hong-kong-administrative-boundaries/hksar_18_district_boundary.json)。本地原始文件为 `hksar_18_district_boundary.json`。
- 归属：© 香港特别行政区政府民政事务总署。来源 DATA.GOV.HK。
- 使用条件：[DATA.GOV.HK Terms and Conditions](https://data.gov.hk/en/terms-and-conditions)。需清楚标注来源及数据归属，地图页面已提供署名和链接。
- 从 18 区多边形中剔除出现两次的共用边，保留外边界。没有把区与区之间的内部界线用于补全。
- 这是行政区数据提取出的参考边界，不是独立的航空空域边界产品。

## 生成与匹配规则

运行 `python scripts/build_airac_boundaries.py`，输入为当前 AIRAC 索引和本目录的两个原始数据文件；输出为 `public/data/airac-boundaries.json`。此命令只处理数据，不运行应用构建，也不修改 Dataset。

1. 只处理 Curve 中 `propertyName=boundary` 且英文备注为 `National Boundaries` 或 `Hong Kong Boundaries` 的连接。
2. 连接起点是当前 Curve 的末点，终点是下一个 Curve 的首点；保留 XML 顺序和端点。
3. 把两端投影到相应的参考边界线段上，沿连通图取最短的参考边界路径。首尾与 XML 端点直接连接。
4. 任一端距参考边界超过 10 km，或参考边界不连通，就记录明确的未补全原因。10 km 是本项目可视化匹配上限，不表示精度承诺。
5. 输出保留原始 Curve ID、起终点、来源、端点偏移和参考路径长度。运行时再次核对 XML 对象和端点，避免把其他版本的连接套用到当前数据。

补全结果属于外部地图参考，尚未经过 EAIP 航图逐段交叉验证。具体匹配结果及未补全名单见上一级目录的 `boundary-completion.md`。
