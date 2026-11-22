#!/usr/bin/env python3
"""把全部 iPlayr 规则打包成 JSTV bundle（cat/index.js + index.config.js + .md5）。

做法与 YSP bundle 相同：以现有 CatVodSpider bundle 为模板，
把 ysp0 蜘蛛区整体替换为「解释器 + 每条规则一个工厂」，
xh0 注册全部工厂，config 的 sites.list 生成全部站点。
"""
import hashlib
import json
import os
import re
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RULES_DIR = os.path.join(BASE, "rules")
CAT_DIR = os.path.join(BASE, "cat")
INTERPRETER = os.path.join(BASE, "converter", "interpreter.js")
TEMPLATE_BUNDLE = "/home/hatch/workspace/goals/ysp-live-script-conversion-for-jstv/files/ysp-live-spider/cat/index.js"
TEMPLATE_CONFIG = "/home/hatch/workspace/goals/ysp-live-script-conversion-for-jstv/files/ysp-live-spider/cat/index.config.js"

ADAPTER = """
const spider={
meta:core.meta,
setProxyBase(url){return core.setProxyBase(url);},
init(req){let b=(req&&req.body)||{};return core.init(b.extend||b.ext||b);},
home(req){let b=(req&&req.body)||{};return core.home(b.filter);},
homeVod(req){return core.homeVod();},
homeVideo(req){return core.homeVod();},
category(req){let b=(req&&req.body)||{};return core.category(b.id||b.tid||"0",b.page||b.pg||1,b.filters,b.extend);},
detail(req){let b=(req&&req.body)||{};let id=Array.isArray(b.id)?b.id[0]:b.id;return core.detail(id);},
search(req){let b=(req&&req.body)||{};return core.search(b.wd||b.key||"",false,b.page||b.pg||1);},
play(req){let b=(req&&req.body)||{};let t=(req&&req.headers&&req.headers["x-forwarded-proto"])||"http",n=(req&&req.headers&&req.headers.host)||"127.0.0.1:9988";core.setProxyBase(t+"://"+n);return core.play(b.flag||b.playFrom||"",b.id||"");},
proxy(req,reply){let params=Object.assign({},(req&&req.query)||{},(req&&req.params)||{});params.do=params.do||params["*"]||params.provider||"";return Promise.resolve(core.proxy(params)).then((result)=>{if(!Array.isArray(result)||result.length<3){reply.send(result);return;}let status=result[0],contentType=result[1],body=result[2],headers=result[3]||{};reply.code(status||200);if(contentType)reply.header("Content-Type",contentType);for(let k of Object.keys(headers)){if(k&&k.toLowerCase()!=="content-type")reply.header(k,headers[k]);}reply.send(body);});},
destroy(){return core.destroy();}
};
return spider;
"""


def load_rule(path):
    text = open(path, encoding="utf-8").read()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        fixed = re.sub(r",\s*([}\]])", r"\1", text)
        try:
            return json.loads(fixed)
        except json.JSONDecodeError:
            return None


def sanitize_key(name):
    k = re.sub(r"[^a-zA-Z0-9]+", "_", name).strip("_").lower()
    return "ip_" + k


def interpreter_wrapped():
    src = open(INTERPRETER, encoding="utf-8").read()
    idx = src.find('if (typeof module !== "undefined"')
    if idx >= 0:
        src = src[:idx].rstrip() + "\n"
    src = src.replace('"use strict";', "", 1)
    return "const createIPlayrSpider = (() => {\n" + src + "\nreturn createIPlayrSpider;\n})();\n"


def main():
    os.makedirs(CAT_DIR, exist_ok=True)
    bundle = open(TEMPLATE_BUNDLE, encoding="utf-8").read()
    config = open(TEMPLATE_CONFIG, encoding="utf-8").read()

    rules = []
    for fn in sorted(os.listdir(RULES_DIR)):
        if not fn.endswith(".json"):
            continue
        rule = load_rule(os.path.join(RULES_DIR, fn))
        if rule is None or not rule.get("category"):
            continue
        rules.append((fn[:-5], rule))
    # bundle 清单：存在则只打包清单内的规则（converter/bundle-rules.txt，一行一个规则名）
    bundle_list_path = os.path.join(BASE, "converter", "bundle-rules.txt")
    if os.path.exists(bundle_list_path):
        keep = set()
        for line in open(bundle_list_path, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#"):
                keep.add(line)
        rules = [(b, r) for (b, r) in rules if b in keep]
        print(f"bundle-rules filter: keeping {len(rules)} of {len(keep)} listed")
    print(f"rules to pack: {len(rules)}")

    # 启用清单（与原仓库 import.json 的 type=8 规则一致）；不在清单内的 enable:false
    enabled = set()
    enabled_path = os.path.join(BASE, "converter", "enabled.txt")
    if os.path.exists(enabled_path):
        for line in open(enabled_path, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#"):
                enabled.add(line)
    print(f"enabled sites: {len(enabled)}")

    # 组装蜘蛛区：解释器 + 规则常量 + 工厂
    parts = [interpreter_wrapped()]
    factories = []
    sites = []
    for i, (base, rule) in enumerate(rules):
        key = sanitize_key(base)
        parts.append(f"const RULE_{i} = {json.dumps(rule, ensure_ascii=False)};")
        parts.append(
            f"function ip{i}(e){{\nconst core=createIPlayrSpider(RULE_{i},{{key:\"{key}\"}});"
            + ADAPTER
            + "}\n"
        )
        factories.append(f"ip{i}(e)")
        sites.append({"key": f"nodejs_{key}", "name": rule.get("title") or base, "enable": (base in enabled) if enabled else True})
    spider_region = "\n".join(parts)

    ysp0_start = bundle.find("function ysp0(e){")
    assert ysp0_start >= 0, "ysp0 not found in template bundle"
    xh0_start = bundle.find("function xh0(", ysp0_start)
    assert xh0_start > ysp0_start, "xh0 not found after ysp0"
    new_bundle = bundle[:ysp0_start] + spider_region + "\n" + bundle[xh0_start:]

    old_xh0 = "function xh0(e){return[ysp0(e)]}"
    assert old_xh0 in new_bundle, "xh0 body not found"
    new_bundle = new_bundle.replace(old_xh0, "function xh0(e){return[" + ",".join(factories) + "]}", 1)

    # config：替换 sites.list
    sites_js = "list: [" + ", ".join(
        "{key: %s, name: %s, enable: %s}" % (json.dumps(s["key"]), json.dumps(s["name"], ensure_ascii=False), "true" if s["enable"] else "false")
        for s in sites
    ) + "]"
    new_config, n = re.subn(r'list: \[\{key: "nodejs_ysp"[^\]]*\]', sites_js, config, count=1)
    assert n == 1, "sites.list not found in config template"

    # 模板 config 里带别人的网盘 token/cookie，新仓库发布前清空（我们的蜘蛛用不到）
    new_config, nstrip = re.subn(r'((?:token|cookie|refreshtoken|password|secret): )"[^"]*"', r'\1""', new_config)
    print(f"credential values blanked in config: {nstrip}")

    bundle_path = os.path.join(CAT_DIR, "index.js")
    config_path = os.path.join(CAT_DIR, "index.config.js")
    open(bundle_path, "w", encoding="utf-8").write(new_bundle)
    open(config_path, "w", encoding="utf-8").write(new_config)
    for p in (bundle_path, config_path):
        data = open(p, "rb").read()
        md5 = hashlib.md5(data).hexdigest()
        open(p + ".md5", "w", encoding="utf-8").write(md5)
        print(f"{os.path.basename(p)}: {len(data)} bytes md5={md5}")


if __name__ == "__main__":
    main()
