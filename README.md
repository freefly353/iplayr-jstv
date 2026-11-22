# iPlayr 规则 → JSTV 转换

把小点播放器 / TVpods / iPlayr 的声明式抓取规则（JSON）转换成 JSTV 可用的 CatVod 蜘蛛。

## 目录

- `rules/` — 小点播放器原规则文件（iPlayr 格式 JSON，镜像自 m3u8playlist/dp 的 iplayr/ 目录，未改动）
- `converter/` — 转换规则（解释器与生成/打包脚本）
  - `interpreter.js` — iPlayr 规则解释器：JSONPath / XPath 子集 / base64 正则三类提取，输出 CatVod 蜘蛛接口
  - `generate.py` — 批量把 `rules/*.json` 生成 `jstv/jstv-<原名>.js`（电台类规则生成 `.m3u`）
  - `build-bundle.py` — 把全部规则打包成 JSTV bundle（`cat/`）
- `jstv/` — 转换后文件：每条规则一个自包含蜘蛛 `jstv-<原名>.js`（原文件名加 `jstv-` 前缀）
- `cat/` — JSTV 可直接订阅的 bundle
  - `index.js` + `index.js.md5` — CatVodSpider bundle（内含全部规则蜘蛛）
  - `index.config.js` + `index.config.js.md5` — 站点配置（每条规则一个站点）

## JSTV 使用

JSTV 添加源地址（与央视频源同法）：

```
https://raw.githubusercontent.com/<owner>/<repo>/main/cat/index.js.md5
```

## 重新生成

```bash
python3 converter/generate.py      # rules/ -> jstv/
python3 converter/build-bundle.py  # rules/ -> cat/
```

## 说明

- 规则分三种：JSON API 型（JSONPath）、HTML 型（XPath）、电台直链型（data 列表 → m3u）。
- 无 `play_regex` 的 HTML 规则，播放页交给 JSTV 播放器嗅探（parse:1）。
- 带 `cf_flag` 的站点有 Cloudflare 防护，手机端能否通过取决于站点策略。
- `test.json` 是空文件，跳过；`avbebe.json` 原文件有尾随逗号，生成时容错修复，原文件保持不动。
