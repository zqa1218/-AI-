'use strict';
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { app, nativeImage, dialog, shell, BrowserWindow } = require('electron');

/* 数据目录：默认「文档/TiaoranAI」，可用环境变量 TIAORAN_HOME 或配置文件 aiDir 覆盖 */
function defaultAiRoot() {
  if (process.env.TIAORAN_HOME) return process.env.TIAORAN_HOME;
  try { return path.join(app.getPath('documents'), 'TiaoranAI'); }
  catch (e) { return path.join(process.cwd(), 'TiaoranAI'); }
}
const RES = path.join(__dirname, 'resources');
function cfgPath() {
  return path.join(process.env.APPDATA || '.', 'TiaoranWorkbench', 'config.json');
}
function cfg() {
  try { return JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); } catch { return {}; }
}
function saveCfg(patch) {
  const c = Object.assign({}, cfg(), patch);
  try {
    fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
    fs.writeFileSync(cfgPath(), JSON.stringify(c, null, 2), 'utf8');
  } catch {}
  return c;
}
function paths() {
  const c = cfg();
  const ai = c.aiDir || defaultAiRoot();
  return {
    ai,
    lib: path.join(ai, '提示词组'),
    presets: path.join(ai, '提示词组', '_预设'),
    proj: path.join(ai, '项目组'),
    out: path.join(ai, '出图'),
    gallery: c.galleryDir || path.join(ai, '出图'),
    cfgFile: path.join(ai, '配置', 'minimax.local.json'),
  };
}
/* 首次运行：把内置预设 / 词库 / 工作流模板铺到数据目录 */
function copyMissing(src, dst, filter) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f);
    if (!fs.statSync(s).isFile()) continue;
    if (filter && !filter(f)) continue;
    const d = path.join(dst, f);
    if (!fs.existsSync(d)) { fs.copyFileSync(s, d); n++; }
  }
  return n;
}

function ensureData() {
  const P = paths();
  for (const d of [P.ai, P.lib, P.presets, P.proj, P.out]) fs.mkdirSync(d, { recursive: true });
  const wf = path.join(P.proj, '_模板', '02_工作流');
  fs.mkdirSync(wf, { recursive: true });
  return {
    presets: copyMissing(path.join(RES, 'presets'), P.presets, f => f.endsWith('.json')),
    prompts: copyMissing(path.join(RES, 'prompts'), P.lib, f => f.endsWith('.txt')),
    workflows: copyMissing(path.join(RES, 'workflows'), wf, f => f.endsWith('.json'))
  };
}

/* 工作流远程地址：换仓库/换分支只改这里，或设环境变量 TIAORAN_WF_BASE */
const WF_BASE = process.env.TIAORAN_WF_BASE ||
  'https://raw.githubusercontent.com/zqa1218/-AI-/main/app/resources/workflows/';
const WF_FILES = ['H3Max_参考图生视频_API.json', 'H3Max_参考图生视频_UI.json'];

async function updateWorkflows(base) {
  const P = paths();
  const src = base || WF_BASE;
  const dirs = [path.join(P.proj, '_模板', '02_工作流'), path.join(P.ai, '工作流')];
  const saved = [];
  for (const f of WF_FILES) {
    const url = src.replace(/\/?$/, '/') + encodeURIComponent(f);
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
    const txt = await r.text();
    JSON.parse(txt); /* 校验是合法 JSON，避免把错误页写进文件 */
    for (const d of dirs) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, f), txt, 'utf8');
    }
    saved.push(f);
  }
  return { ok: true, files: saved, source: src, dirs };
}

const COMFY = 'http://127.0.0.1:8188';
const MM = 'https://api.minimaxi.com';

function mmKey() {
  const c = cfg();
  if (c.apiKey) return c.apiKey;
  try { return JSON.parse(fs.readFileSync(paths().cfgFile, 'utf8')).api_key || ''; } catch { return ''; }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.ico': 'image/x-icon' };

function sendJson(res, obj, code = 200) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}

async function llm(messages, { model = 'MiniMax-M3', max_tokens = 2000, temperature = 0.6 } = {}) {
  const key = mmKey();
  if (!key) throw new Error('未配置 MiniMax API Key');
  const r = await fetch(MM + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens, temperature })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message || 'API 错误');
  let t = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
  t = t.replace(/<think[\s\S]*?<\/think\s*>/gi, '').trim();
  return t;
}

function jsonFrom(text) {
  const i = text.indexOf('{'), j = text.lastIndexOf('}');
  if (i >= 0 && j > i) return JSON.parse(text.slice(i, j + 1));
  throw new Error('模型没有返回 JSON');
}

function imgDataUrl(p, maxSide = 900) {
  const img = nativeImage.createFromPath(p);
  if (img.isEmpty()) throw new Error('图片读取失败');
  const { width, height } = img.getSize();
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const resized = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale) }) : img;
  return 'data:image/jpeg;base64,' + resized.toJPEG(85).toString('base64');
}

async function visionJson(p, sysP, userP, max_tokens = 1800) {
  const txt = await llm([
    { role: 'system', content: sysP },
    { role: 'user', content: [
      { type: 'text', text: userP },
      { type: 'image_url', image_url: { url: imgDataUrl(p) } }
    ] }
  ], { max_tokens, temperature: 0.3 });
  return jsonFrom(txt);
}

/* ---------- 提示词 ---------- */
function buildMj(f) {
  const parts = [];
  if (f.subject) parts.push(f.subject + (f.action ? '，' + f.action : ''));
  else if (f.action) parts.push(f.action);
  ['scene', 'camera', 'light', 'style'].forEach(k => { if (f[k]) parts.push(f[k]); });
  const body = parts.join('，');
  let params = '--ar ' + (f.ratio || '16:9') + ' --v ' + (f.version || '7');
  if (f.negative) params += ' --no ' + String(f.negative).replace(/\n/g, ' ').trim();
  if (body) params += ' --style raw';
  return { prompt: body, params, full: (body + ' ' + params).trim() };
}

const STAGE_MAP = { '主体': 'subject', '人物': 'subject', '动作': 'action', '环境': 'scene', '场景': 'scene', '时间': 'scene',
  '细节': 'style', '光线': 'light', '运镜': 'camera', '质感': 'style', '起': 'subject', '承': 'action', '转': 'action',
  '合': 'style', '起点': 'scene', '终点': 'style', '过程': 'action' };

function ruleVideoPrompt(f, preset) {
  if (!preset) return [f.subject, f.action, f.scene, f.light, f.camera, f.style].filter(Boolean).join('，');
  const out = [], seen = new Set();
  (preset.stages || []).forEach(s => {
    const k = STAGE_MAP[s.key]; const v = k ? (f[k] || '').trim() : '';
    if (v && !seen.has(v)) { out.push(v); seen.add(v); }
  });
  return out.join('，');
}

async function llmVideoPrompt(f, preset) {
  const mode = (preset && preset.mode) || 'camera';
  const sysP = mode === 'live2d'
    ? '你是 Live2D 动态立绘提示词工程师。为 MiniMax H3 写一段微动提示词：中文一段话，50~110 字；' +
      '必须包含：立绘式主体细节、呼吸起伏、眨眼次数、发丝/衣摆的自然微摆、重心轻微移动；' +
      '机位必须固定（最多极轻微推近），禁止走位、转身、大幅动作、镜头平移与切镜；' +
      '强调背景静止与循环感（首尾姿态接近）。不写 --参数、不写解释、不分点。'
    : '你是短视频提示词工程师，专为 MiniMax H3 这类视频模型写提示词。要求：中文；一段话，80~150 字；' +
      '按「主体与动作 → 环境 → 光线 → 运镜 → 质感」顺序；动作要拆成 3-4 个前后衔接的节拍（先…接着…然后…最后…）；' +
      '只指定一条完整运镜路径，不要同时推拉摇移；不写 --参数、不写解释、不分点。';
  const stages = preset ? (preset.stages || []).map(s => '- ' + s.key + '：' + s.guide).join('\n') : '';
  const user = '参考图字段：\n' + ['subject', 'action', 'scene', 'camera', 'light', 'style']
    .map(k => k + '：' + (f[k] || '（空）')).join('\n') +
    (preset ? '\n\n预设：' + preset.name + '（' + (preset.desc || '') + '）\n分镜骨架：\n' + stages : '');
  for (const mt of [2000, 3000]) {
    const out = (await llm([{ role: 'system', content: sysP }, { role: 'user', content: user }], { max_tokens: mt, temperature: 0.8 })).trim();
    if (out) return out;
  }
  return '';
}

const IMG_WORKFLOWS = {
  retouch: '原图精修：保持人物与场景，只改光线、质感、细节',
  product: '产品精修：静物/商品，强调材质、高光、洁净度',
  character: '角色设定：三视图或者人物设定卡，保持设定一致性',
  cosplay: 'Cosplay 后期：还原角色气质，修服装材质与妆造'
};

async function imgAnalyze(p) {
  return visionJson(p, '你是资深商业修图师兼摄影指导。分析这张底图，输出严格 JSON（不要代码块），字段：' +
    'subject（主体与外观）、light（光线方向/软硬/色温）、material（材质与质感）、composition（构图与景别）、' +
    'palette（色调与色彩关系）、issues（可改进的 1-3 个问题，字符串数组）。其余为中文短句，每项不超过 28 字。',
    '分析这张底图，输出 JSON。');
}

async function imgDecompose(p) {
  return visionJson(p, '你是修图参考拆解师。看这张参考图，输出严格 JSON：' +
    '{"transferable":[{"item":"可迁移项（光线/材质/构图/色调/质感）","how":"怎么迁移到我的图上，<=30字"}],' +
    '"avoid":["不建议照搬的点"]}。transferable 3-5 条，avoid 0-2 条。', '拆解这张参考图，输出 JSON。');
}

async function imgDirections(b) {
  const a = b.analysis || {}, wf = IMG_WORKFLOWS[b.workflow || 'retouch'] || '';
  const sysP = '你是修图方案策划。基于底图分析，给出 3 个差异化修图方向。输出严格 JSON 数组：' +
    '[{"title":"方向名（<=12字）","why":"为什么适合这张图（<=40字）","how":"具体怎么改（<=60字）"}]。只输出数组。';
  const user = '底图分析：\n' + Object.entries(a).map(([k, v]) => k + '：' + (typeof v === 'string' ? v : JSON.stringify(v))).join('\n') +
    (wf ? '\n\n线路：' + wf : '') + (b.requirement ? '\n需求：' + b.requirement : '');
  const txt = await llm([{ role: 'system', content: sysP }, { role: 'user', content: user }], { max_tokens: 2000, temperature: 0.8 });
  const i = txt.indexOf('['), j = txt.lastIndexOf(']');
  if (i < 0 || j <= i) throw new Error('没有返回方向数组');
  return JSON.parse(txt.slice(i, j + 1));
}

async function imgPrompt(b) {
  const sysP = '你是 Midjourney 提示词专家 + 商业修图指导。基于分析、方向与表单，输出严格 JSON：' +
    '{"zh":"完整中文提示词（一段，80-160字）","en":"英文 Midjourney 提示词正文（不含 -- 参数，60-120 词）",' +
    '"params":"--ar 16:9 --v 7 --style raw","checklist":["提交前要核对的 3-5 条"]}。只输出 JSON。';
  const user = '底图分析：\n' + JSON.stringify(b.analysis || {}) +
    '\n\n选定方向：\n' + JSON.stringify(b.direction || {}) +
    (b.refNotes && b.refNotes.length ? '\n\n参考图可迁移项：\n' + JSON.stringify(b.refNotes) : '') +
    '\n\n表单：\n' + JSON.stringify(b.form || {});
  const txt = await llm([{ role: 'system', content: sysP }, { role: 'user', content: user }], { max_tokens: 2500, temperature: 0.7 });
  return jsonFrom(txt);
}

async function imgOptimize(b) {
  const cur = b.current || {};
  const sysP = '你是 Midjourney 提示词优化师。在保持主体与身份一致的前提下，按「优化要求」重写提示词。' +
    '输出严格 JSON：{"zh":"优化后中文提示词（一段，80-160字）","en":"优化后英文 MJ 提示词正文（不含 -- 参数）",' +
    '"params":"参数行，如 --ar 16:9 --v 7 --style raw","checklist":["提交前检查 3-5 条"],"note":"一句话说明改了什么"}。只输出 JSON。';
  const user = '底图分析：\n' + JSON.stringify(b.analysis || {}) +
    '\n\n选定方向：\n' + JSON.stringify(b.direction || {}) +
    '\n\n表单：\n' + JSON.stringify(b.form || {}) +
    '\n\n当前提示词：\n' + (cur.zh || cur.en ? JSON.stringify({ zh: cur.zh, en: cur.en, params: cur.params }) : '（还没有，请直接按分析与要求生成）') +
    '\n\n优化要求：\n' + (b.instruction || '整体提升质感与可执行性');
  const out = await llm([{ role: 'system', content: sysP }, { role: 'user', content: user }], { max_tokens: 2500, temperature: 0.7 });
  return jsonFrom(out);
}

/* ---------- ComfyUI ---------- */
async function comfyAlive() {
  try { const r = await fetch(COMFY + '/system_stats', { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}
async function comfyJson(p, body) {
  const r = await fetch(COMFY + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  if (!r.ok) {
    const txt = await r.text();
    let detail = '';
    try {
      const d = JSON.parse(txt);
      const parts = [];
      for (const [nid, v] of Object.entries(d.node_errors || {})) {
        for (const e of (v.errors || [])) parts.push((e.details || e.message));
      }
      if (d.error && d.error.message) parts.unshift(d.error.message);
      detail = parts.filter(Boolean).slice(0, 3).join('；');
    } catch (e) { detail = txt.slice(0, 200); }
    throw new Error('ComfyUI ' + r.status + (detail ? '：' + detail : ''));
  }
  return r.json();
}
async function comfyUpload(file) {
  const buf = await fsp.readFile(file);
  const fd = new FormData();
  fd.append('image', new Blob([buf], { type: 'image/png' }), path.basename(file));
  fd.append('overwrite', 'true');
  const r = await fetch(COMFY + '/upload/image', { method: 'POST', body: fd });
  const d = await r.json();
  return d.name;
}
function normDuration(d) {
  /* MiniMax H3 Max 只接受 5..15 的整数字符串；更短/更长一律夹紧 */
  const n = parseInt(d, 10);
  if (!Number.isFinite(n)) return 5;
  return Math.max(5, Math.min(15, n));
}

function buildGraph(prompt, names, duration, loop) {
  const g = {
    '1': { class_type: 'MiniMax H3 Content Builder', inputs: { prompt } },
    '2': { class_type: 'MiniMax H3 Max Generate Video', inputs: {
      content: ['1', 0], resolution: '768P', duration: String(normDuration(duration)), ratio: '16:9',
      prompt_expansion_mode: 'quality', seed: 0 } },
    '3': { class_type: 'MiniMax H3 Preview Video', inputs: { video_url: ['2', 0] } }
  };
  if (loop && names.length) {
    /* 循环：只用第一张，首帧与尾帧同图，首尾姿态闭合，便于无缝循环。
       循环模式不再混入其他参考图，避免「帧引导 + 参考图」语义冲突。 */
    g['10'] = { class_type: 'LoadImage', inputs: { image: names[0] } };
    g['1'].inputs.first_frame = ['10', 0];
    g['1'].inputs.last_frame = ['10', 0];
    return g;
  }
  names.forEach((n, i) => {
    const nid = String(10 + i);
    g[nid] = { class_type: 'LoadImage', inputs: { image: n } };
    g['1'].inputs['image_' + (i + 1)] = [nid, 0];
  });
  return g;
}

const JOBS = new Map();

/* ---------- 文件 ---------- */
function safeName(s) { return String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 60) || '未命名'; }

async function apiState(recursive) {
  const P = paths();
  const projects = [];
  try {
    for (const d of (await fsp.readdir(P.proj)).sort().reverse()) {
      const full = path.join(P.proj, d);
      if (d.startsWith('_') || !(await fsp.stat(full)).isDirectory()) continue;
      let shots = 0;
      try { shots = (await fsp.readdir(path.join(full, '03_成片'))).filter(x => x.toLowerCase().endsWith('.mp4')).length; } catch {}
      projects.push({ name: d, shots });
    }
  } catch {}
  const images = [];
  async function walk(dir) {
    let ents = [];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.(png|jpe?g|webp)$/i.test(e.name)) {
        images.push({ name: e.name, path: full, rel: path.relative(P.gallery, full).split(path.sep).join('/'), mtime: (await fsp.stat(full)).mtimeMs });
      }
    }
  }
  if (recursive) {
    await walk(P.gallery);
  } else {
    let ents = [];
    try { ents = await fsp.readdir(P.gallery, { withFileTypes: true }); } catch {}
    for (const e of ents) {
      if (e.isDirectory() || !/\.(png|jpe?g|webp)$/i.test(e.name)) continue;
      const full = path.join(P.gallery, e.name);
      images.push({ name: e.name, path: full, rel: e.name, mtime: (await fsp.stat(full)).mtimeMs });
    }
  }
  images.sort((a, b) => b.mtime - a.mtime);
  const lib = {};
  try { for (const f of await fsp.readdir(P.lib)) if (f.endsWith('.txt')) lib[f.slice(0, -4)] = await fsp.readFile(path.join(P.lib, f), 'utf8'); } catch {}
  return { projects, images: images.slice(0, 300), lib, comfy: await comfyAlive(), llm: !!mmKey(),
    aiDir: P.ai, galleryDir: P.gallery };
}

async function loadPresets() {
  const P = paths(); const out = [];
  try {
    for (const f of await fsp.readdir(P.presets)) if (f.endsWith('.json')) {
      try { out.push(JSON.parse(await fsp.readFile(path.join(P.presets, f), 'utf8'))); } catch {}
    }
  } catch {}
  const ORDER = ['camera-move', 'live2d-idle', 'portrait-cinema', 'action-clay', 'scene-plate', 'product', 'storyboard', 'transition'];
  out.sort((a, b) => (ORDER.indexOf(a.id) + 1 || 99) - (ORDER.indexOf(b.id) + 1 || 99));
  return out;
}

async function createProject(b) {
  const P = paths();
  const name = safeName(b.name);
  const dir = path.join(P.proj, new Date().toISOString().slice(0, 10).replace(/-/g, '') + '_' + name);
  if (fs.existsSync(dir)) return { ok: true, path: dir, existed: true };
  for (const d of ['00_提示词', '01_参考图', '02_工作流', '03_成片', '04_素材']) await fsp.mkdir(path.join(dir, d), { recursive: true });
  try {
    const tpl = path.join(P.proj, '_模板', '02_工作流');
    for (const f of await fsp.readdir(tpl)) if (f.endsWith('.json')) await fsp.copyFile(path.join(tpl, f), path.join(dir, '02_工作流', f));
  } catch {}
  await fsp.writeFile(path.join(dir, '00_提示词', '项目说明.md'), '# ' + name + '\n', 'utf8');
  return { ok: true, path: dir, existed: false };
}

/* 把提示词与参考图写进项目目录 */
async function archiveInputs(b) {
  const P = paths();
  const proj = String(b.project || '').trim();
  if (!proj) return { ok: false, reason: '未选项目' };
  const dir = path.join(P.proj, proj);
  if (!fs.existsSync(dir)) return { ok: false, reason: '项目目录不存在' };
  const dPrompt = path.join(dir, '00_提示词');
  const dRef = path.join(dir, '01_参考图');
  fs.mkdirSync(dPrompt, { recursive: true });
  fs.mkdirSync(dRef, { recursive: true });

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const lines = [
    '# 提示词', '',
    '- 时间: ' + stamp,
    '- 时长: ' + (b.duration || '') + ' 秒',
    '- 预设: ' + (b.presetName || '（未选）'),
    '- 模型: MiniMax H3 Max / 768P', '',
    '## 视频提示词', '', String(b.prompt || '').trim(), ''
  ];
  const body = lines.join('\n');
  fs.writeFileSync(path.join(dPrompt, '提示词.md'), body, 'utf8');
  fs.writeFileSync(path.join(dPrompt, '提示词_' + stamp.replace(/[: ]/g, '-') + '.md'), body, 'utf8');

  const copied = [];
  (b.images || []).forEach((src, i) => {
    try {
      if (!src || !fs.existsSync(src)) return;
      const dst = path.join(dRef, (i + 1) + '_' + path.basename(src).replace(/[\\\\/:*?\"<>|]/g, '_'));
      if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
      copied.push(path.basename(dst));
    } catch (e) {}
  });
  return { ok: true, promptFile: path.join(dPrompt, '提示词.md'), refs: copied, dir };
}

async function appendRecord(proj, line) {
  try {
    const P = paths();
    const f = path.join(P.proj, proj, '00_提示词', '生成记录.md');
    if (!fs.existsSync(f)) fs.writeFileSync(f, '# 生成记录\n\n| 时间 | 费用 | 文件 | 归档 |\n| --- | --- | --- | --- |\n', 'utf8');
    fs.appendFileSync(f, line + '\n', 'utf8');
  } catch (e) {}
}

async function refineVideoPrompt(f, preset, current, instruction) {
  const sysP = '你是短视频提示词优化师。在保持主体身份、动作与镜头结构不变的前提下，按「优化要求」改写这段视频提示词。' +
    '要求：中文一段话，60-160 字；不写解释；不分点；不写 -- 参数；只输出改写后的正文。';
  const stages = preset ? (preset.stages || []).map(s => '- ' + s.key + '：' + s.guide).join('\n') : '';
  const user = '当前提示词：\n' + (current || '（还没有，请按字段与要求直接写）') +
    '\n\n字段参考：\n' + ['subject','action','scene','camera','light','style'].map(k => k + '：' + (f[k] || '（空）')).join('\n') +
    (preset ? '\n\n预设骨架：\n' + stages : '') +
    '\n\n优化要求：\n' + (instruction || '整体提升可看性与动作连贯度');
  for (const mt of [1500, 2500]) {
    const out = (await llm([{ role: 'system', content: sysP }, { role: 'user', content: user }], { max_tokens: mt, temperature: 0.75 })).trim();
    if (out) return out;
  }
  return '';
}

async function videoSubmit(b) {
  const prompt = (b.prompt || '').trim();
  if (!prompt) return { error: '提示词为空' };
  const imgs = (b.images || []).filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (!imgs.length) return { error: '至少选一张参考图' };
  if (!(await comfyAlive())) return { error: 'ComfyUI 没启动（127.0.0.1:8188）' };
  let archived = null;
  try { archived = await archiveInputs(b); } catch (e) {}
  const names = [];
  for (const p of imgs) names.push(await comfyUpload(p));
  const dur = normDuration(b.duration);
  const r = await comfyJson('/prompt', { prompt: buildGraph(prompt, names, dur, !!b.loop), client_id: require('crypto').randomUUID() });
  JOBS.set(r.prompt_id, { project: b.project || '', started: Date.now(), duration: b.duration, presetName: b.presetName || '' });
  return { ok: true, id: r.prompt_id, archived };
}

async function videoStatus(id) {
  const P = paths();
  let h;
  try { h = await comfyJson('/history/' + id); } catch (e) { return { state: 'error', error: e.message }; }
  if (!h[id]) return { state: 'running', elapsed: Math.round((Date.now() - (JOBS.get(id) || {}).started || Date.now()) / 1000) };
  const info = h[id], st = info.status || {};
  if (st.status_str !== 'success') {
    let msg = '';
    (st.messages || []).forEach(m => { if (m[0] === 'execution_error') msg = m[1].exception_message || ''; });
    return { state: 'error', error: msg || '生成失败' };
  }
  let cost = null, files = [];
  for (const [nid, o] of Object.entries(info.outputs || {})) {
    if (o.minimax_h3_cost) cost = o.minimax_h3_cost[0];
    if (o.images) files = files.concat(o.images);
  }
  if (!files.length) return { state: 'error', error: '没有输出文件' };
  const f0 = files[0];
  const src = path.join(P.out, f0.subfolder || '', f0.filename);
  const job = JOBS.get(id) || {};
  let saved = '';
  if (job.project) {
    const dd = path.join(P.proj, job.project, '03_成片');
    try {
      if (fs.existsSync(dd) && fs.existsSync(src)) {
        const dst = path.join(dd, f0.filename);
        if (!fs.existsSync(dst)) await fsp.copyFile(src, dst);
        saved = dst;
      }
    } catch {}
  }
  if (job.project && !job.recorded) {
    job.recorded = true;
    await appendRecord(job.project, '| ' + new Date().toISOString().replace('T', ' ').slice(0, 19) +
      ' | ' + (cost || '') + ' | ' + path.basename(src) + ' | ' + (saved ? '03_成片' : '未归档') + ' |');
  }
  return { state: 'done', url: '/media/' + encodeURIComponent(path.relative(P.out, src).split(path.sep).join('/')),
    cost, file: src, saved, elapsed: Math.round((Date.now() - (job.started || Date.now())) / 1000) };
}

/* ---------- HTTP 路由 ---------- */
async function handler(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const P = paths();
  try {
    if (u.pathname === '/' || u.pathname === '/index.html') {
      const f = path.join(__dirname, 'web', 'index.html');
      const b = await fsp.readFile(f);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(b);
    }
    if (u.pathname.startsWith('/media/')) {
      const rel = decodeURIComponent(u.pathname.slice(7));
      /* 媒体可能来自图库，也可能是出图/成片目录（切换图库后仍要能播放） */
      const roots = [P.gallery, P.out, path.join(P.proj)];
      let full = null;
      for (const r of roots) {
        const cand = path.resolve(r, rel);
        const root = path.resolve(r);
        if (cand.startsWith(root) && fs.existsSync(cand) && fs.statSync(cand).isFile()) { full = cand; break; }
      }
      if (!full) { res.writeHead(404); return res.end(); }
      const b = await fsp.readFile(full);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Content-Length': b.length });
      return res.end(b);
    }
    if (!u.pathname.startsWith('/api/')) {
      const f = path.join(__dirname, 'web', u.pathname.replace(/^\/+/, ''));
      if (fs.existsSync(f) && fs.statSync(f).isFile()) {
        const b = await fsp.readFile(f);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        return res.end(b);
      }
      res.writeHead(404); return res.end();
    }

    let body = {};
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    }

    switch (u.pathname) {
      case '/api/state': return sendJson(res, await apiState(u.searchParams.get('recursive') === '1'));
      case '/api/presets': return sendJson(res, { presets: await loadPresets() });
      case '/api/project/create': return sendJson(res, await createProject(body));
      case '/api/mj': return sendJson(res, buildMj(body));
      case '/api/analyze': return sendJson(res, { fields: await visionJson(body.path,
        '你是影视摄影指导。分析参考图，输出严格 JSON（不要代码块），字段：subject、action、scene、light、camera、style。每项中文不超过 30 字，没把握留空字符串。',
        '分析这张参考图并输出 JSON。') });
      case '/api/img/analyze': return sendJson(res, { analysis: await imgAnalyze(body.path) });
      case '/api/img/decompose': return sendJson(res, { decompose: await imgDecompose(body.path) });
      case '/api/img/directions': return sendJson(res, { directions: await imgDirections(body) });
      case '/api/img/prompt': return sendJson(res, await imgPrompt(body));
      case '/api/img/optimize': return sendJson(res, await imgOptimize(body));
      case '/api/video-prompt': {
        const presets = await loadPresets();
        const pre = presets.find(p => p.id === body.preset) || null;
        if (body.mode === 'llm') return sendJson(res, { prompt: await llmVideoPrompt(body.fields || {}, pre), mode: 'llm' });
        if (body.mode === 'refine') {
          const refined = await refineVideoPrompt(body.fields || {}, pre, body.current || '', body.instruction || '');
          if (!refined) return sendJson(res, { error: 'AI 没有返回内容，请重试' }, 500);
          return sendJson(res, { prompt: refined, mode: 'refine' });
        }
        return sendJson(res, { prompt: ruleVideoPrompt(body.fields || {}, pre), mode: 'rule' });
      }
      case '/api/gallery': {
        const dir = String(body.dir || '').trim();
        if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return sendJson(res, { error: '目录不存在' }, 400);
        saveCfg({ galleryDir: dir });
        return sendJson(res, { ok: true, galleryDir: dir });
      }
      case '/api/pick-dir': {
        const win = BrowserWindow.getAllWindows()[0];
        const r = await dialog.showOpenDialog(win, {
          title: '选择图库文件夹',
          properties: ['openDirectory'],
          defaultPath: paths().gallery
        });
        if (r.canceled || !r.filePaths.length) return sendJson(res, { canceled: true });
        saveCfg({ galleryDir: r.filePaths[0] });
        return sendJson(res, { ok: true, galleryDir: r.filePaths[0] });
      }
      case '/api/image/trash': {
        const p = String(body.path || '');
        const root = path.resolve(paths().gallery);
        const full = path.resolve(p);
        if (!full.startsWith(root)) return sendJson(res, { error: '只能删除图库目录内的文件' }, 400);
        if (!fs.existsSync(full)) return sendJson(res, { error: '文件已不存在' }, 400);
        await shell.trashItem(full);
        return sendJson(res, { ok: true });
      }
      case '/api/workflows/update': {
        try { return sendJson(res, await updateWorkflows(body.base)); }
        catch (e) { return sendJson(res, { error: e.message }, 502); }
      }
      case '/api/video/graph': {
        /* 只构建不提交，便于核对节点结构（不产生费用） */
        return sendJson(res, { graph: buildGraph(body.prompt || 'x', body.images || [], body.duration, !!body.loop),
                              duration: normDuration(body.duration) });
      }
      case '/api/project/archive': return sendJson(res, await archiveInputs(body));
      case '/api/video/submit': return sendJson(res, await videoSubmit(body));
      case '/api/video/status': return sendJson(res, await videoStatus(u.searchParams.get('id')));
      default: return sendJson(res, { error: 'not found' }, 404);
    }
  } catch (e) {
    return sendJson(res, { error: e.message || String(e) }, 500);
  }
}

function start(port = 8765) {
  try { ensureData(); } catch (e) { console.error('[seed]', e.message); }
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handler);
    srv.on('error', (e) => {
      if (e.code === 'EADDRINUSE') return resolve({ server: null, port });
      reject(e);
    });
    srv.listen(port, '127.0.0.1', () => resolve({ server: srv, port }));
  });
}

module.exports = { start, paths, ensureData };
