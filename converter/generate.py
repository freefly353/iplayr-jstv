#!/usr/bin/env python3
"""把 rules/ 下的 iPlayr 规则批量转换成 JSTV CatVod 蜘蛛文件 jstv/jstv-<原名>.js。

- 每条 VOD 规则生成一个自包含蜘蛛：解释器代码 + 内嵌规则对象。
- 电台类规则（data 直链列表）生成 jstv-<原名>.m3u（直播源格式）。
- 无法解析的规则跳过并报告（avbebe.json 有尾随逗号，生成时做容错修复，原文件不动）。
"""
import json
import os
import re
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RULES_DIR = os.path.join(BASE, "rules")
OUT_DIR = os.path.join(BASE, "jstv")
INTERPRETER = os.path.join(BASE, "converter", "interpreter.js")


def load_rule(path):
    text = open(path, encoding="utf-8").read()
    try:
        return json.loads(text), None
    except json.JSONDecodeError:
        # 容错：去掉对象/数组里的尾随逗号再试
        fixed = re.sub(r",\s*([}\]])", r"\1", text)
        try:
            return json.loads(fixed), "trailing-comma-fixed"
        except json.JSONDecodeError as e:
            return None, f"invalid json: {e}"


def sanitize_key(name):
    k = re.sub(r"[^a-zA-Z0-9]+", "_", name).strip("_").lower()
    return "ip_" + k


def interpreter_body():
    src = open(INTERPRETER, encoding="utf-8").read()
    # 去掉文件尾的 module.exports 段（生成文件里不需要）
    idx = src.find('if (typeof module !== "undefined"')
    if idx >= 0:
        src = src[:idx].rstrip() + "\n"
    return src


def gen_spider(rule, key, interp):
    rule_json = json.dumps(rule, ensure_ascii=False, indent=1)
    return f'''{interp}
const RULE = {rule_json};
function createSpider() {{
    return createIPlayrSpider(RULE, {{ key: "{key}" }});
}}
const spider = createSpider();
module.exports = spider;
module.exports.createSpider = createSpider;
'''


def gen_m3u(rule):
    lines = ["#EXTM3U"]
    for item in rule.get("data", []):
        name = item.get("name", "")
        logo = item.get("logo", "")
        url = item.get("url", "")
        if not url:
            continue
        lines.append(f'#EXTINF:-1 tvg-logo="{logo}",{name}')
        lines.append(url)
    return "\n".join(lines) + "\n"


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    interp = interpreter_body()
    # 解释器包进 IIFE，避免与宿主 bundle 的顶层标识符冲突
    interp_wrapped = (
        "const createIPlayrSpider = (() => {\n"
        + interp.replace('"use strict";', "", 1)
        + "\nreturn createIPlayrSpider;\n})();\n"
    )
    ok, m3u, skipped = [], [], []
    for fn in sorted(os.listdir(RULES_DIR)):
        if not fn.endswith(".json"):
            continue
        base = fn[:-5]
        rule, note = load_rule(os.path.join(RULES_DIR, fn))
        if rule is None:
            skipped.append((fn, note))
            continue
        if isinstance(rule.get("data"), list) and not rule.get("category"):
            out = os.path.join(OUT_DIR, f"jstv-{base}.m3u")
            open(out, "w", encoding="utf-8").write(gen_m3u(rule))
            m3u.append(fn)
            continue
        if not rule.get("category"):
            skipped.append((fn, "no category"))
            continue
        key = sanitize_key(base)
        out = os.path.join(OUT_DIR, f"jstv-{base}.js")
        open(out, "w", encoding="utf-8").write(gen_spider(rule, key, interp_wrapped))
        ok.append((fn, note))
    print(f"spiders generated: {len(ok)}")
    for fn, note in ok:
        if note:
            print(f"  note {fn}: {note}")
    print(f"m3u generated: {len(m3u)} {m3u}")
    print(f"skipped: {len(skipped)}")
    for fn, why in skipped:
        print(f"  skip {fn}: {why}")


if __name__ == "__main__":
    main()
