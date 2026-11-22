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

// MacCMS 播放页 player_aaaa 解码（encrypt: 0 明文 / 1 unescape / 2 base64+unescape）
// 解出的是媒体地址才返回，否则 null（encrypt=3 等自定义加密走嗅探兜底）
function decodePlayerAaaa(html) {
    if (!isStr(html)) return null;
    const m =
        /player_aaaa\s*=\s*(\{.*?\})\s*;?\s*<\/script>/s.exec(html) ||
        /player_aaaa\s*=\s*(\{[^\n]*\})/.exec(html);
    if (!m) return null;
    let d;
    try {
        d = JSON.parse(m[1]);
    } catch (_) {
        return null;
    }
    let url = toStr(d.url);
    if (!url) return null;
    const enc = String(d.encrypt ?? "0");
    try {
        if (enc === "1") url = decodeURIComponent(url);
        else if (enc === "2") url = decodeURIComponent(Buffer.from(url, "base64").toString("utf8"));
        else if (enc !== "0") return null;
    } catch (_) {
        return null;
    }
    if (/\.(m3u8|mp4|flv|mkv|mpd|ts)(\?|#|$)/i.test(url) || /m3u8/i.test(url)) return url;
    return null;
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

async function fetchBinary(url, headers, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
    try {
        const resp = await fetch(url, { headers: headers || {}, signal: ctrl.signal, redirect: "follow" });
        const buf = Buffer.from(await resp.arrayBuffer());
        return {
            status: resp.status,
            body: buf,
            contentType: resp.headers.get("content-type") || "application/octet-stream",
            finalUrl: resp.url || url,
        };
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

    // ---------- HLS 本地代理 ----------
    // 播放器直连上游常被 UA 拦截（如 lumenbox 对 ffmpeg UA 返回 403），
    // 故 HLS 列表与分片全部经 spider 代理：spider 带浏览器 UA 拉上游，
    // 播放器只跟 127.0.0.1 打交道。
    const PROXY_BUILD = "iplayr-proxy-v1";
    let proxyBase = "http://127.0.0.1:9988";
    const diagLog = [];
    function diagPush(action, info) {
        try {
            diagLog.push(Object.assign({ t: new Date().toISOString().slice(11, 19), action }, info));
            while (diagLog.length > 50) diagLog.shift();
        } catch (_) {}
    }
    function proxyUrlFor(action, upstream) {
        return (
            proxyBase +
            "/spider/" +
            encodeURIComponent(opts.key || "iplayr") +
            "/3/proxy/" +
            action +
            "?u=" +
            encodeURIComponent(upstream)
        );
    }
    function isHlsUrl(u) {
        return /\.m3u8(\?|#|$)/i.test(toStr(u)) || /m3u8/i.test(toStr(u));
    }
    function rewritePlaylist(text, upstreamUrl) {
        const lines = String(text || "").split(/\r?\n/);
        const out = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line) { out.push(line); continue; }
            if (line.startsWith("#EXT-X-STREAM-INF")) {
                out.push(line);
                if (i + 1 < lines.length && lines[i + 1] && !lines[i + 1].startsWith("#")) {
                    out.push(proxyUrlFor("pl.m3u8", resolveUrl(lines[i + 1].trim(), upstreamUrl)));
                    i++;
                }
                continue;
            }
            if (line.startsWith("#EXT-X-KEY") || line.startsWith("#EXT-X-MAP") || line.startsWith("#EXT-X-MEDIA")) {
                out.push(
                    line.replace(/URI="([^"]+)"/g, (m, uri) => {
                        const abs = resolveUrl(uri, upstreamUrl);
                        return 'URI="' + proxyUrlFor(line.startsWith("#EXT-X-MEDIA") ? "pl.m3u8" : "seg", abs) + '"';
                    })
                );
                continue;
            }
            if (line.startsWith("#")) { out.push(line); continue; }
            out.push(proxyUrlFor("seg", resolveUrl(line.trim(), upstreamUrl)));
        }
        return out.join("\n");
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

        setProxyBase(url) {
            if (typeof url === "string" && url) proxyBase = url.replace(/\/+$/, "");
        },

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
            // HLS 地址走本地代理（spider 带浏览器 UA 拉上游，避开 UA 拦截）
            const wrap = (u) => (isHlsUrl(u) ? proxyUrlFor("pl.m3u8", u) : u);
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
                        if (url) return { parse: 0, url: wrap(url), header };
                    }
                }
                return { parse: 0, url: wrap(pid), header };
            }
            // id 本身已是媒体地址：不用抓页（HLS 仍走代理）
            if (/\.(m3u8|mp4|flv|mkv|mpd|ts)(\?|#|$)/i.test(pid)) {
                return { parse: 0, url: wrap(pid), header };
            }
            // 抓播放页：依次试 规则正则 → MacCMS player_aaaa 解码 → 页面直链
            let pageText = "";
            let pageUrl = pid;
            try {
                const resp = await fetchText(pid, reqHeaders());
                pageText = resp.text;
                pageUrl = resp.finalUrl;
            } catch (_) { /* 抓页失败走嗅探兜底 */ }
            if (pageText) {
                // 抓到的本身就是 m3u8 清单（如 dexter 接口）：走代理交给播放器
                if (pageText.trimStart().startsWith("#EXTM3U")) {
                    return { parse: 0, url: proxyUrlFor("pl.m3u8", pid), header };
                }
                if (isStr(R.play_regex)) {
                    const cap = applyRegex(pageText, decodeRuleRegex(R.play_regex));
                    if (cap) {
                        const url = resolveUrl(fillTemplate(R.play_url || "{id}", { id: cap }), pageUrl);
                        return { parse: 0, url: wrap(url), header };
                    }
                }
                const pa = decodePlayerAaaa(pageText);
                if (pa) return { parse: 0, url: wrap(resolveUrl(pa, pageUrl)), header };
                const direct = /(https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?)/i.exec(pageText);
                if (direct) return { parse: 0, url: wrap(direct[1]), header };
            }
            // 抠不到真实地址：交给播放器嗅探
            return { parse: 1, url: pid, header };
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

        async proxy(params) {
            let query = params;
            if (typeof query === "string") {
                query = {};
                for (const pair of String(params).split("&")) {
                    const [k, v] = pair.split("=");
                    if (k) query[decodeURIComponent(k)] = v ? decodeURIComponent(v) : "";
                }
            }
            query = query || {};
            let action = String(query.do || query.action || "").replace(/\.(m3u8|ts|m4s)$/i, "");
            if (action === "diag") {
                const body = JSON.stringify({ version: PROXY_BUILD, diag: diagLog.slice().reverse() }, null, 1);
                return [200, "application/json", body, { "Content-Type": "application/json" }];
            }
            const u = toStr(query.u);
            if (!u) {
                return [400, "application/json", JSON.stringify({ error: "missing u" }), { "Content-Type": "application/json" }];
            }
            if (action === "pl") {
                try {
                    const resp = await fetchText(u, reqHeaders());
                    diagPush("pl", { status: resp.status, ok: resp.status === 200 && !!resp.text, u: u.slice(0, 80) });
                    if (resp.status !== 200 || !resp.text) {
                        return [502, "text/plain", "upstream playlist error", { "Content-Type": "text/plain" }];
                    }
                    const rewritten = rewritePlaylist(resp.text, resp.finalUrl);
                    return [200, "application/vnd.apple.mpegurl", rewritten, { "Content-Type": "application/vnd.apple.mpegurl" }];
                } catch (e) {
                    diagPush("pl", { status: 0, ok: false, err: String((e && e.message) || e).slice(0, 60) });
                    return [502, "application/json", JSON.stringify({ error: String((e && e.message) || e).slice(0, 200) }), { "Content-Type": "application/json" }];
                }
            }
            if (action === "seg") {
                try {
                    const resp = await fetchBinary(u, reqHeaders());
                    diagPush("seg", { status: resp.status, ok: resp.status === 200 && resp.body.length > 0, u: u.slice(0, 80) });
                    if (resp.status !== 200 || !resp.body.length) {
                        return [502, "text/plain", "upstream segment error", { "Content-Type": "text/plain" }];
                    }
                    return [200, resp.contentType, resp.body, { "Content-Type": resp.contentType }];
                } catch (e) {
                    diagPush("seg", { status: 0, ok: false, err: String((e && e.message) || e).slice(0, 60) });
                    return [502, "application/json", JSON.stringify({ error: String((e && e.message) || e).slice(0, 200) }), { "Content-Type": "application/json" }];
                }
            }
            return [404, "text/plain", "unknown proxy action", { "Content-Type": "text/plain" }];
        },

        destroy() {},
    };

    return spider;
}

return createIPlayrSpider;
})();

const RULE = {
 "uuid": "6ed73adf-8c3e-46dd-a8cd-64a7dfe491d2",
 "title": "4K影视",
 "episode_flag": true,
 "landscape_flag": false,
 "referer": "",
 "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
 "open_with_safari_flag": true,
 "category": [
  {
   "title": "最近更新",
   "url0": "https://www.4kvm.cc/filter",
   "url1": "https://www.4kvm.cc/filter?page={pg}"
  }
 ],
 "vod_node": "//div[contains(@class, 'movie-card')]",
 "vod_info": "//span[@class='text-white drop-shadow-md']",
 "vod_score": "",
 "vod_title": "//h3",
 "vod_image_id": "//img/@data-src",
 "vod_image_regex": "",
 "vod_image_url": "{id}",
 "vod_link_id": "//a/@href",
 "vod_link_url": "https://www.4kvm.cc{id}",
 "play_regex": "",
 "play_url": "{id}",
 "playlist_flag": true,
 "playlist_group_node": "//div[@class='grid grid-cols-6 gap-2']",
 "playlist_title": "//a/@data-episode",
 "playlist_link_id": "//a/@href",
 "playlist_link_url": "https://www.4kvm.cc{id}",
 "playlist_info": "//p[@class='text-xs text-gray-300 leading-relaxed']",
 "search_flag": true,
 "search_url_first_page": "https://www.4kvm.cc/search?q={wd}",
 "search_url_other_page": "",
 "search_vod_node": "//div[@class='group relative']",
 "search_vod_title": "//h3",
 "search_vod_image_id": "//img/@data-src",
 "search_vod_image_regex": "",
 "search_vod_image_url": "{id}",
 "search_vod_link_id": "//a/@href",
 "search_vod_link_url": "https://www.4kvm.cc{id}"
};
function createSpider() {
    return createIPlayrSpider(RULE, { key: "ip_4kvm_movie" });
}
const spider = createSpider();
module.exports = spider;
module.exports.createSpider = createSpider;
