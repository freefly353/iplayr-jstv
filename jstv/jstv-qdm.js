const createIPlayrSpider = (() => {

/**
 * iPlayr 规则解释器 — JSTV CatVod 蜘蛛工厂
 *
 * 把 iPlayr 声明式抓取规则（小点播放器 / TVpods / iPlayr 通用 JSON 规则）
 * 解释成 CatVod spider 接口 { meta, init, home, homeVod, category, detail, play, search }。
 *
 * 支持三种提取方式（规则字段自动判别）：
 *   - JSONPath 子集：$、.key、[*]、[n]（JSON API 型规则，如 stream-movie）
 *   - XPath 子集：//、/、tag、*、[@attr='v']、[contains(@attr,'v')]、/@attr
 *     （HTML 型规则，绝大多数；内置容错 HTML 解析器，无外部依赖）
 *   - 正则：play_regex / vod_image_regex 等字段为 base64 编码的正则，取捕获组 1
 *
 * 用法：const spider = createIPlayrSpider(ruleObject, { key: "ip_stream_movie" });
 * 生成的单规则蜘蛛文件（jstv-*.js）内嵌规则对象；bundle 内每条规则一个工厂。
 */

// ---------- 通用小工具 ----------

function isStr(v) {
    return typeof v === "string" && v.length > 0;
}

function toStr(v) {
    if (v === null || v === undefined) return "";
    return String(v);
}

// HTML 实体解码（常用子集）
function decodeEntities(s) {
    if (!s || s.indexOf("&") < 0) return s || "";
    return s
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
            try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return _; }
        })
        .replace(/&#(\d+);/g, (_, d) => {
            try { return String.fromCodePoint(parseInt(d, 10)); } catch (_) { return _; }
        })
        .replace(/&nbsp;/gi, " ")
        .replace(/&quot;/gi, '"')
        .replace(/&apos;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&amp;/gi, "&");
}

// URL 模板填充：{id} {pg} {wd} {showId} {season} 等占位符
function fillTemplate(tpl, vars) {
    if (!isStr(tpl)) return "";
    return tpl.replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
}

// 相对 URL 补全
function resolveUrl(maybeRel, base) {
    if (!isStr(maybeRel)) return "";
    const s = maybeRel.trim();
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith("//")) return "https:" + s;
    try {
        return new URL(s, base).toString();
    } catch (_) {
        return s;
    }
}

// 规则里的正则字段是 base64 编码；解码失败或解出不可打印内容时按原文用
function decodeRuleRegex(s) {
    if (!isStr(s)) return "";
    const t = s.trim();
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(t) && t.length % 4 === 0) {
        try {
            const dec = Buffer.from(t, "base64").toString("utf8");
            if (dec && /^[\x20-\x7e\\]+$/.test(dec) && dec !== t) return dec;
        } catch (_) { /* fallthrough */ }
    }
    return t;
}

function applyRegex(text, pattern) {
    if (!isStr(text) || !isStr(pattern)) return "";
    try {
        const m = new RegExp(pattern).exec(text);
        if (!m) return "";
        return m[1] !== undefined ? m[1] : m[0];
    } catch (_) {
        return "";
    }
}

// ---------- HTTP ----------

const DEFAULT_UA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";

async function fetchText(url, headers, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
    try {
        const resp = await fetch(url, { headers: headers || {}, signal: ctrl.signal, redirect: "follow" });
        const text = await resp.text();
        return { status: resp.status, text, finalUrl: resp.url || url };
    } finally {
        clearTimeout(timer);
    }
}

// ---------- JSONPath 子集 ----------
// 支持 $、.key、[*]、[n]。返回匹配值数组。

function jsonPathAll(root, path) {
    if (!isStr(path)) return [];
    let p = path.trim();
    if (p.startsWith("$")) p = p.slice(1);
    const tokens = [];
    const re = /\.([^.[\]]+)|\[\*\]|\[(\d+)\]|\['([^']+)'\]|\["([^"]+)"\]/g;
    let m;
    while ((m = re.exec(p)) !== null) {
        if (m[0] === "[*]") tokens.push({ all: true });
        else if (m[2] !== undefined) tokens.push({ idx: parseInt(m[2], 10) });
        else tokens.push({ key: m[1] !== undefined ? m[1] : m[3] !== undefined ? m[3] : m[4] });
    }
    let cur = [root];
    for (const t of tokens) {
        const next = [];
        for (const v of cur) {
            if (v === null || v === undefined) continue;
            if (t.all) {
                if (Array.isArray(v)) next.push(...v);
                else if (typeof v === "object") next.push(...Object.values(v));
            } else if (t.idx !== undefined) {
                if (Array.isArray(v) && v[t.idx] !== undefined) next.push(v[t.idx]);
            } else if (typeof v === "object" && v[t.key] !== undefined) {
                next.push(v[t.key]);
            }
        }
        cur = next;
        if (cur.length === 0) break;
    }
    return cur;
}

// JSON 规则字段取值：
//   - 以 $ 开头 → 从根求 JSONPath，取第一个
//   - 含 . 或 [ → 从当前项求 JSONPath，取第一个
//   - 否则 → 当前项的同名字段
function jsonField(item, root, field) {
    if (!isStr(field)) return "";
    const f = field.trim();
    if (f.startsWith("$")) {
        const r = jsonPathAll(root, f);
        return r.length ? toStr(r[0]) : "";
    }
    if (f.includes(".") || f.includes("[")) {
        const r = jsonPathAll(item, "$" + (f.startsWith(".") || f.startsWith("[") ? f : "." + f));
        return r.length ? toStr(r[0]) : "";
    }
    if (item && typeof item === "object" && item[f] !== undefined && item[f] !== null) return toStr(item[f]);
    return "";
}

// ---------- HTML 容错解析器 ----------
// 节点形状：{ tag, attrs:{}, children:[], text:"" }（text 为直接文本拼接）

const VOID_TAGS = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
]);

function parseHtml(html) {
    const root = { tag: "#root", attrs: {}, children: [], text: "" };
    if (!isStr(html)) return root;
    const stack = [root];
    const top = () => stack[stack.length - 1];
    let i = 0;
    const n = html.length;
    while (i < n) {
        const lt = html.indexOf("<", i);
        if (lt < 0) {
            top().text += decodeEntities(html.slice(i));
            break;
        }
        if (lt > i) top().text += decodeEntities(html.slice(i, lt));
        // 注释 / CDATA / doctype
        if (html.startsWith("<!--", lt)) {
            const end = html.indexOf("-->", lt + 4);
            i = end < 0 ? n : end + 3;
            continue;
        }
        if (html.startsWith("<![CDATA[", lt)) {
            const end = html.indexOf("]]>", lt + 9);
            top().text += end < 0 ? html.slice(lt + 9) : html.slice(lt + 9, end);
            i = end < 0 ? n : end + 3;
            continue;
        }
        if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
            const end = html.indexOf(">", lt + 2);
            i = end < 0 ? n : end + 1;
            continue;
        }
        const gt = findTagEnd(html, lt);
        if (gt < 0) {
            top().text += decodeEntities(html.slice(lt));
            break;
        }
        const raw = html.slice(lt + 1, gt);
        i = gt + 1;
        if (raw.startsWith("/")) {
            // 结束标签：弹栈到同名标签
            const name = raw.slice(1).trim().split(/\s+/)[0].toLowerCase();
            for (let s = stack.length - 1; s >= 1; s--) {
                if (stack[s].tag === name) {
                    stack.length = s;
                    break;
                }
            }
            continue;
        }
        const selfClose = /\/\s*$/.test(raw);
        const nameMatch = /^([a-zA-Z][\w:-]*)/.exec(raw);
        if (!nameMatch) continue;
        const tag = nameMatch[1].toLowerCase();
        const attrs = parseAttrs(raw.slice(nameMatch[0].length));
        const node = { tag, attrs, children: [], text: "" };
        top().children.push(node);
        if (tag === "script" || tag === "style") {
            // 原始文本元素：吞掉内容直到结束标签（不建子节点）
            const close = html.toLowerCase().indexOf("</" + tag, i);
            if (close >= 0) {
                node.text = html.slice(i, close);
                const cgt = html.indexOf(">", close);
                i = cgt < 0 ? n : cgt + 1;
            } else {
                node.text = html.slice(i);
                i = n;
            }
            continue;
        }
        if (!selfClose && !VOID_TAGS.has(tag)) stack.push(node);
    }
    return root;
}

function findTagEnd(html, lt) {
    let quote = null;
    for (let j = lt + 1; j < html.length; j++) {
        const c = html[j];
        if (quote) {
            if (c === quote) quote = null;
        } else if (c === '"' || c === "'") {
            quote = c;
        } else if (c === ">") {
            return j;
        }
    }
    return -1;
}

function parseAttrs(s) {
    const attrs = {};
    const re = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let m;
    while ((m = re.exec(s)) !== null) {
        const name = m[1].toLowerCase();
        const val = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : "";
        attrs[name] = decodeEntities(val);
    }
    return attrs;
}

// 节点全部后代文本（折叠空白）
function nodeText(node) {
    if (!node) return "";
    let out = node.text || "";
    for (const c of node.children || []) out += nodeText(c);
    return out.replace(/\s+/g, " ").trim();
}

function descendants(node, out) {
    out = out || [];
    for (const c of node.children || []) {
        out.push(c);
        descendants(c, out);
    }
    return out;
}

// ---------- XPath 子集 ----------
// 支持：//（后代）、/（子级）、tag、*、[@attr='v']、[contains(@attr,'v')]、末尾 /@attr。
// 返回节点数组；若末尾是 /@attr 则返回属性字符串数组（由 xpathAttr 处理）。

function parseXpathSteps(xpath) {
    const steps = [];
    let i = 0;
    const s = xpath.trim();
    let axis = "child";
    if (s.startsWith("//")) { axis = "descendant"; i = 2; }
    else if (s.startsWith("/")) { axis = "child"; i = 1; }
    else if (s.startsWith("./")) { axis = "child"; i = 2; }
    while (i < s.length) {
        // 读一步：到下一个不在引号/括号内的 /
        let j = i;
        let depth = 0;
        let quote = null;
        while (j < s.length) {
            const c = s[j];
            if (quote) { if (c === quote) quote = null; }
            else if (c === "'" || c === '"') quote = c;
            else if (c === "[") depth++;
            else if (c === "]") depth--;
            else if (c === "/" && depth === 0) break;
            j++;
        }
        const stepText = s.slice(i, j).trim();
        if (stepText) steps.push({ axis, text: stepText });
        // 下一个轴
        if (s.startsWith("//", j)) { axis = "descendant"; i = j + 2; }
        else if (s[j] === "/") { axis = "child"; i = j + 1; }
        else break;
    }
    return steps;
}

function matchStep(node, stepText) {
    // stepText 形如 tag、*、tag[@attr='v']、tag[contains(@attr,'v')]
    const m = /^([\w*-]+)/.exec(stepText);
    if (!m) return false;
    const tag = m[1].toLowerCase();
    if (tag !== "*" && node.tag !== tag) return false;
    const predRe = /\[([^\]]+)\]/g;
    let p;
    while ((p = predRe.exec(stepText)) !== null) {
        const pred = p[1].trim();
        let mm = /^@([\w:-]+)\s*=\s*'([^']*)'$/.exec(pred) || /^@([\w:-]+)\s*=\s*"([^"]*)"$/.exec(pred);
        if (mm) {
            if ((node.attrs[mm[1].toLowerCase()] || "") !== mm[2]) return false;
            continue;
        }
        mm = /^contains\(\s*@([\w:-]+)\s*,\s*'([^']*)'\s*\)$/.exec(pred) || /^contains\(\s*@([\w:-]+)\s*,\s*"([^"]*)"\s*\)$/.exec(pred);
        if (mm) {
            if (!(node.attrs[mm[1].toLowerCase()] || "").includes(mm[2])) return false;
            continue;
        }
        mm = /^@([\w:-]+)$/.exec(pred);
        if (mm) {
            if (!(mm[1].toLowerCase() in node.attrs)) return false;
            continue;
        }
        // 不认识的谓词：放行（宁可多取也不漏）
    }
    return true;
}

// 求值 XPath，返回节点数组（末尾 /@attr 时返回带 attr 标记的对象由调用方处理）
function xpathAll(contextNode, xpath) {
    if (!isStr(xpath) || !contextNode) return [];
    const steps = parseXpathSteps(xpath);
    let current = [contextNode];
    for (const step of steps) {
        if (step.text.startsWith("@")) {
            // 属性步：转成字符串结果
            const attr = step.text.slice(1).toLowerCase();
            return current.map((nd) => ({ __attr: (nd.attrs && nd.attrs[attr]) || "" }));
        }
        const next = [];
        for (const nd of current) {
            const pool = step.axis === "descendant" ? descendants(nd) : nd.children || [];
            for (const cand of pool) if (matchStep(cand, step.text)) next.push(cand);
        }
        current = next;
        if (current.length === 0) break;
    }
    return current;
}

// HTML 规则字段取值：字段是 XPath（相对当前项子树）；空字段返回 ""
function htmlField(itemNode, field) {
    if (!isStr(field) || !itemNode) return "";
    const r = xpathAll(itemNode, field.trim());
    if (!r.length) return "";
    const first = r[0];
    if (first && typeof first === "object" && "__attr" in first) return first.__attr || "";
    return nodeText(first);
}

// ---------- 蜘蛛工厂 ----------

function createIPlayrSpider(rule, opts) {
    opts = opts || {};
    const R = rule || {};
    const isJsonRule = isStr(R.vod_node) && R.vod_node.trim().startsWith("$");
    const ua = R.user_agent || R["user-agent"] || R["use-agent"] || DEFAULT_UA;

    function reqHeaders(extra) {
        const h = { "User-Agent": ua };
        if (isStr(R.referer)) h["Referer"] = R.referer;
        if (extra) Object.assign(h, extra);
        return h;
    }

    function playHeaders() {
        const h = { "User-Agent": ua };
        if (isStr(R.referer)) h["Referer"] = R.referer;
        return h;
    }

    // 从列表响应提取条目（JSON / HTML 两路）
    function extractItems(text, pageUrl, f) {
        // f: {node, title, imageId, imageRegex, imageUrl, linkId, info, score}
        const out = [];
        if (isJsonRule) {
            let data;
            try { data = JSON.parse(text); } catch (_) { return { items: out, data: null }; }
            const nodes = jsonPathAll(data, f.node);
            for (const it of nodes) {
                if (!it || typeof it !== "object") continue;
                const rawId = jsonField(it, data, f.linkId);
                if (!rawId) continue;
                let img = jsonField(it, data, f.imageId);
                if (isStr(f.imageRegex)) img = applyRegex(img, decodeRuleRegex(f.imageRegex)) || img;
                const pic = resolveUrl(fillTemplate(f.imageUrl || "{id}", { id: img }), pageUrl);
                out.push({
                    vod_id: rawId,
                    vod_name: jsonField(it, data, f.title) || rawId,
                    vod_pic: pic,
                    vod_remarks: jsonField(it, data, f.info) || jsonField(it, data, f.score),
                });
            }
            return { items: out, data };
        }
        const doc = parseHtml(text);
        const nodes = xpathAll(doc, f.node);
        for (const nd of nodes) {
            if (!nd || typeof nd !== "object" || "__attr" in nd) continue;
            const rawId = htmlField(nd, f.linkId);
            if (!rawId) continue;
            let img = htmlField(nd, f.imageId);
            if (isStr(f.imageRegex)) {
                const rx = f.imageRegex.trim();
                img = rx.startsWith("/") ? htmlField(nd, rx) : applyRegex(img, decodeRuleRegex(rx)) || img;
            }
            const pic = resolveUrl(fillTemplate(f.imageUrl || "{id}", { id: img }), pageUrl);
            out.push({
                vod_id: rawId,
                vod_name: htmlField(nd, f.title) || rawId,
                vod_pic: pic,
                vod_remarks: htmlField(nd, f.info) || htmlField(nd, f.score),
            });
        }
        return { items: out, data: doc };
    }

    function listFields(prefix) {
        // prefix: "vod" 或 "search_vod"
        return {
            node: R[prefix + "_node"],
            title: R[prefix + "_title"],
            imageId: R[prefix + "_image_id"],
            imageRegex: R[prefix + "_image_regex"],
            imageUrl: R[prefix + "_image_url"],
            linkId: R[prefix + "_link_id"],
            info: prefix === "vod" ? R.vod_info : "",
            score: prefix === "vod" ? R.vod_score : "",
        };
    }

    async function fetchList(url, fields) {
        const { text, finalUrl } = await fetchText(url, reqHeaders());
        return extractItems(text, finalUrl, fields);
    }

    function pageCountOf(data, pg, count) {
        if (data && typeof data === "object" && !Array.isArray(data)) {
            for (const k of ["totalPages", "pageCount", "totalPage", "pages", "lastPage"]) {
                const v = Number(data[k]);
                if (Number.isFinite(v) && v > 0) return v;
            }
        }
        return count === 0 ? pg : 999;
    }

    const spider = {
        meta: {
            key: opts.key || "iplayr",
            name: R.title || opts.name || "iPlayr",
            type: 3,
            searchable: R.search_flag ? 1 : 0,
            quickSearch: R.search_flag ? 1 : 0,
            filterable: 0,
        },

        setProxyBase() {},

        init() {},

        async home() {
            const cats = Array.isArray(R.category) ? R.category : [];
            return {
                class: cats.map((c, i) => ({ type_id: String(i), type_name: c.title || "分类" + (i + 1) })),
                filters: {},
            };
        },

        async homeVod() {
            try {
                const r = await spider.category("0", 1);
                return { list: r.list || [] };
            } catch (_) {
                return { list: [] };
            }
        },

        async category(tid, pg) {
            const cats = Array.isArray(R.category) ? R.category : [];
            const cat = cats[Number(tid) || 0] || cats[0];
            if (!cat) return { list: [], page: pg || 1, pagecount: 1, limit: 0, total: 0 };
            const page = Number(pg) || 1;
            const tpl = page <= 1 ? cat.url0 || cat.url1 : cat.url1 || cat.url0;
            const url = fillTemplate(tpl, { pg: page });
            const { items, data } = await fetchList(url, listFields("vod"));
            return {
                list: items,
                page,
                pagecount: pageCountOf(data, page, items.length),
                limit: items.length,
                total: items.length,
            };
        },

        async detail(id) {
            let rawId = toStr(id);
            let linkTpl = R.vod_link_url;
            if (rawId.startsWith("S:")) {
                rawId = rawId.slice(2);
                linkTpl = R.search_vod_link_url || R.vod_link_url;
            }
            const detailUrl = resolveUrl(fillTemplate(linkTpl, { id: rawId }), linkTpl);
            const { text, finalUrl } = await fetchText(detailUrl, reqHeaders());
            const lines = []; // [{name, eps:[{name, id}]}]
            let vodName = "";
            let vodPic = "";
            let vodContent = "";

            if (isJsonRule) {
                let data = null;
                try { data = JSON.parse(text); } catch (_) { /* keep null */ }
                if (data) {
                    vodName = jsonField(data, data, R.vod_title);
                    const img0 = jsonField(data, data, R.vod_image_id);
                    vodPic = resolveUrl(fillTemplate(R.vod_image_url || "{id}", { id: img0 }), finalUrl);
                    vodContent = jsonField(data, data, R.playlist_info);
                    const groups = jsonPathAll(data, R.playlist_group_node);
                    if (isStr(R.playlist_sub_group_node)) {
                        // 季 → 集 两级（stream-tv 型）
                        for (const g of groups) {
                            const gId = jsonField(g, data, R.playlist_link_id);
                            const gName = jsonField(g, data, R.playlist_title) || "线路";
                            const seasonUrl = resolveUrl(
                                fillTemplate(R.playlist_link_url, { showId: rawId, id: gId }),
                                finalUrl
                            );
                            const eps = [];
                            try {
                                const sResp = await fetchText(seasonUrl, reqHeaders());
                                const sData = JSON.parse(sResp.text);
                                for (const ep of jsonPathAll(sData, R.playlist_sub_group_node)) {
                                    const epId = jsonField(ep, sData, R.playlist_sub_link_id);
                                    eps.push({
                                        name: jsonField(ep, sData, R.playlist_sub_title) || "第" + epId + "集",
                                        id: resolveUrl(
                                            fillTemplate(R.playlist_sub_link_url, {
                                                showId: rawId,
                                                season: gId,
                                                id: epId,
                                            }),
                                            sResp.finalUrl
                                        ),
                                    });
                                }
                            } catch (_) { /* 单季失败不拖垮详情 */ }
                            if (eps.length) lines.push({ name: gName, eps });
                        }
                    } else {
                        // 每组一条线路、一个播放项（电影型）
                        for (const g of groups) {
                            const gId = jsonField(g, data, R.playlist_link_id);
                            const gName = jsonField(g, data, R.playlist_title) || "播放";
                            lines.push({
                                name: gName,
                                eps: [
                                    {
                                        name: gName,
                                        id: resolveUrl(fillTemplate(R.playlist_link_url, { id: gId }), finalUrl),
                                    },
                                ],
                            });
                        }
                    }
                }
            } else {
                const doc = parseHtml(text);
                vodContent = htmlField(doc, R.playlist_info);
                const titleNodes = xpathAll(doc, "//title");
                if (titleNodes.length) vodName = nodeText(titleNodes[0]);
                const groups = xpathAll(doc, R.playlist_group_node).filter(
                    (nd) => nd && typeof nd === "object" && !("__attr" in nd)
                );
                groups.forEach((g, gi) => {
                    const titleNodes = xpathAll(g, R.playlist_title);
                    const hrefNodes = xpathAll(g, R.playlist_link_id);
                    const eps = [];
                    const count = Math.max(titleNodes.length, hrefNodes.length);
                    for (let k = 0; k < count; k++) {
                        const t = titleNodes[k];
                        const h = hrefNodes[k];
                        const epName = t ? ("__attr" in t ? t.__attr : nodeText(t)) : "第" + (k + 1) + "集";
                        const href = h ? ("__attr" in h ? h.__attr : nodeText(h)) : "";
                        if (!href) continue;
                        eps.push({
                            name: epName || "第" + (k + 1) + "集",
                            id: resolveUrl(fillTemplate(R.playlist_link_url || "{id}", { id: href }), finalUrl),
                        });
                    }
                    if (eps.length) lines.push({ name: "线路" + (gi + 1), eps });
                });
            }

            const playFrom = lines.map((l) => l.name).join("$$$");
            const playUrl = lines
                .map((l) => l.eps.map((e) => e.name + "$" + e.id).join("#"))
                .join("$$$");
            return {
                list: [
                    {
                        vod_id: rawId,
                        vod_name: vodName || rawId,
                        vod_pic: vodPic,
                        vod_content: vodContent,
                        vod_play_from: playFrom,
                        vod_play_url: playUrl,
                    },
                ],
            };
        },

        async play(flag, id) {
            const pid = toStr(id);
            const header = playHeaders();
            // JSON TV 型：id 是单集接口，再取 sources
            if (isStr(R.play_node)) {
                const { text, finalUrl } = await fetchText(pid, reqHeaders());
                let data = null;
                try { data = JSON.parse(text); } catch (_) { /* keep null */ }
                if (data) {
                    const srcs = jsonPathAll(data, R.play_node);
                    for (const s of srcs) {
                        const sid = jsonField(s, data, R.play_link_id);
                        if (!sid) continue;
                        const url = resolveUrl(fillTemplate(R.play_source_url || "{id}", { id: sid }), finalUrl);
                        if (url) return { parse: 0, url, header };
                    }
                }
                return { parse: 0, url: pid, header };
            }
            // HTML 型：id 是播放页，play_regex 抠真实地址
            if (isStr(R.play_regex)) {
                const { text, finalUrl } = await fetchText(pid, reqHeaders());
                const cap = applyRegex(text, decodeRuleRegex(R.play_regex));
                if (cap) {
                    const url = resolveUrl(fillTemplate(R.play_url || "{id}", { id: cap }), finalUrl);
                    return { parse: 0, url, header };
                }
                return { parse: 1, url: pid, header };
            }
            // 已是媒体地址直接播；否则是播放页，交给播放器嗅探（parse:1）
            const isMedia = /\.(m3u8|mp4|flv|mkv|mpd|ts)(\?|#|$)/i.test(pid) || /m3u8/i.test(pid);
            return { parse: isMedia ? 0 : 1, url: pid, header };
        },

        async search(wd, quick, pg) {
            if (!R.search_flag) return { list: [], page: pg || 1, pagecount: 1, limit: 0, total: 0 };
            const page = Number(pg) || 1;
            const tpl = page <= 1 ? R.search_url_first_page : R.search_url_other_page || R.search_url_first_page;
            const url = fillTemplate(tpl, { wd: encodeURIComponent(toStr(wd)), pg: page });
            const { items, data } = await fetchList(url, listFields("search_vod"));
            for (const it of items) it.vod_id = "S:" + it.vod_id;
            return {
                list: items,
                page,
                pagecount: pageCountOf(data, page, items.length),
                limit: items.length,
                total: items.length,
            };
        },

        proxy() {
            return [404, "text/plain", "not found", {}];
        },

        destroy() {},
    };

    return spider;
}

return createIPlayrSpider;
})();

const RULE = {
 "uuid": "6ed73adf-8c3e-46dd-a8cd-64a7dfe491d2",
 "title": "趣动漫",
 "info": "已失效，网站已挂",
 "episode_flag": true,
 "landscape_flag": false,
 "referer": "",
 "enable_cache_flag": false,
 "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
 "open_with_safari_flag": true,
 "category": [
  {
   "title": "日本动漫",
   "url0": "https://www.qdm8.com/type/riman.html",
   "url1": "https://www.qdm8.com/type/riman-{pg}.html"
  },
  {
   "title": "国产动漫",
   "url0": "https://www.qdm8.com/type/guoman.html",
   "url1": "https://www.qdm8.com/type/guoman-{pg}.html"
  },
  {
   "title": "动漫电影",
   "url0": "https://www.qdm8.com/type/dmdianying.html",
   "url1": "https://www.qdm8.com/type/dmdianying-{pg}.html"
  },
  {
   "title": "欧美动漫",
   "url0": "https://www.qdm8.com/type/oman.html",
   "url1": "https://www.qdm8.com/type/oman-{pg}.html"
  }
 ],
 "vod_node": "//ul[contains(@class, 'myui-vodlist')]//li",
 "vod_info": "//span[@class='pic-text text-right']",
 "vod_score": "",
 "vod_title": "//h4//a",
 "vod_image_id": "//a[contains(@class, 'myui-vodlist__thumb')]/@data-original",
 "vod_image_regex": "",
 "vod_image_url": "{id}",
 "vod_link_id": "//h4//a/@href",
 "vod_link_url": "https://www.qdm8.com{id}",
 "play_regex": "",
 "play_url": "{id}",
 "playlist_flag": true,
 "playlist_group_node": "//ul[contains(@class, 'myui-content__list')]",
 "playlist_title": "//li/a",
 "playlist_link_id": "//li/a/@href",
 "playlist_link_url": "https://www.qdm8.com{id}",
 "playlist_info": "//p[@class='data hidden-xs']",
 "search_flag": true,
 "search_url_first_page": "https://www.qdm8.com/search/-------------.html?wd={wd}&submit=",
 "search_url_other_page": "https://www.qdm8.com/search/{wd}----------{pg}---.html",
 "search_vod_node": "//ul[contains(@class, 'myui-vodlist__media')]//li",
 "search_vod_title": "//h4//a",
 "search_vod_image_id": "//a[contains(@class, 'myui-vodlist__thumb')]/@data-original",
 "search_vod_image_regex": "",
 "search_vod_image_url": "{id}",
 "search_vod_link_id": "//h4//a/@href",
 "search_vod_link_url": "https://www.qdm8.com{id}"
};
function createSpider() {
    return createIPlayrSpider(RULE, { key: "ip_qdm" });
}
const spider = createSpider();
module.exports = spider;
module.exports.createSpider = createSpider;
