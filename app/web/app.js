const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* 高分屏/缩放适配 */
function fitZoom() {
  const need = 1180;
  const z = Math.min(1, Math.max(0.7, window.innerWidth / need));
  document.documentElement.style.zoom = z.toFixed(3);
}
window.addEventListener("resize", fitZoom);
fitZoom();

const state = {
  images: [], lib: {}, presets: [], preset: null, project: "",
  slots: [null, null, null], activeSlot: 0, cat: "场景", lastField: "", mode: "image",
  recursive: false,
  videoHistory: [],
  vmode: "camera",
  img: { base: null, refs: [], analysis: null, decomp: null, directions: [], direction: null, history: [] }
};

async function api(path, body) {
  const opt = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {};
  const r = await fetch(path, opt);
  return r.json();
}
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function toast(msg, err) { const el = $("#vstate"); if (!el) return; el.textContent = msg; el.className = "vstate" + (err ? " err" : ""); }

/* ---------------- 启动 ---------------- */
async function boot() {
  const s = await api("/api/state" + (state.recursive ? "?recursive=1" : ""));
  state.images = s.images; state.lib = s.lib; state.gallery = s.galleryDir || "";
  const cd = $("#comfyDot"); cd.textContent = s.comfy ? "ComfyUI 在线" : "ComfyUI 离线";
  cd.className = "pill " + (s.comfy ? "on" : "off");
  const ld = $("#llmDot"); ld.textContent = s.llm ? "AI 就绪" : "AI 未配置";
  ld.className = "pill " + (s.llm ? "on" : "off");
  const sel = $("#projectSel");
  const cur = sel.value;
  sel.innerHTML = '<option value="">（未选项目）</option>' +
    s.projects.map(p => `<option value="${esc(p.name)}">${esc(p.name)} · ${p.shots} 片</option>`).join("");
  if (cur) sel.value = cur;
  const p = await api("/api/presets");
  state.presets = p.presets || [];
  if (state.presets.length && !state.preset) selectPreset(state.presets[0].id);
  renderImages(); renderPresets(); renderCatTabs(); renderChips(); renderSlots(); renderRefRow(); renderGalleryPath();
  if (state.img.base) renderBase();
}

/* ---------------- 模式 ---------------- */
function setMode(m) {
  state.mode = m;
  $$(".mode").forEach(b => b.classList.toggle("active", b.dataset.mode === m));
  $("#viewImage").style.display = m === "image" ? "" : "none";
  $("#viewVideo").style.display = m === "video" ? "" : "none";
}
$$(".mode").forEach(b => b.onclick = () => setMode(b.dataset.mode));

/* ---------------- 图库 ---------------- */
function imageCards(target, onClick, onShift) {
  const q = ($("#imgFilter") && $("#imgFilter").value || "").toLowerCase();
  target.innerHTML = state.images.filter(i => !q || i.name.toLowerCase().includes(q))
    .map(i => `<div class="thumb" data-path="${esc(i.path)}" data-rel="${esc(i.rel)}" title="${esc(i.name)}">
      <img loading="lazy" src="/media/${encodeURI(i.rel)}"><span>${esc(i.name)}</span>
      <button class="del" data-path="${esc(i.path)}" title="移到回收站">×</button></div>`).join("");
  target.querySelectorAll(".del").forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const p = btn.dataset.path;
      btn.disabled = true;
      const r = await api("/api/image/trash", { path: p });
      if (r.error) { btn.disabled = false; return toast("删除失败：" + r.error, true); }
      state.images = state.images.filter(x => x.path !== p);
      state.img.refs = state.img.refs.filter(x => x.path !== p);
      if (state.img.base && state.img.base.path === p) state.img.base = null;
      state.slots = state.slots.map(s => (s && s.path === p ? null : s));
      renderImages(); renderRefRow(); renderBase(); renderSlots();
      toast("已移到回收站");
    };
  });
  target.querySelectorAll(".thumb").forEach(el => {
    el.onclick = (e) => onClick(el, e);
    el.ondblclick = (e) => { e.preventDefault(); if (onShift) onShift(el); };
  });
}

function renderImages() {
  const a = $("#images");
  if (a) imageCards(a, (el, e) => {
    if (e.shiftKey) addRef(el.dataset.path, el.dataset.rel);
    else { state.img.base = { path: el.dataset.path, rel: el.dataset.rel }; renderBase(); }
  }, (el) => { state.img.base = { path: el.dataset.path, rel: el.dataset.rel }; renderBase(); });

  const b = $("#images2");
  if (b) imageCards(b, (el) => assignImage(el.dataset.path, el.dataset.rel), (el) => {
    assignImage(el.dataset.path, el.dataset.rel); analyze(0, el.dataset.path);
  });
}

function renderBase() {
  const el = $("#baseThumb");
  if (!el) return;
  const b = state.img.base;
  el.innerHTML = b ? `<img src="/media/${encodeURI(b.rel)}"><span>${esc(b.rel.split("/").pop())}</span>` : "<span>选一张底图</span>";
  el.classList.toggle("filled", !!b);
}

function addRef(path, rel) {
  if (state.img.refs.length >= 3) return;
  if (state.img.refs.some(r => r.path === path)) return;
  state.img.refs.push({ path, rel });
  renderRefRow();
}

function renderRefRow() {
  const row = $("#refThumbs");
  if (!row) return;
  row.innerHTML = state.img.refs.length
    ? state.img.refs.map((r, i) => `<div class="ref-chip" data-i="${i}">
        <img src="/media/${encodeURI(r.rel)}"><em>${esc(r.rel.split("/").pop())}</em></div>`).join("")
    : '<span class="muted">Shift+单击图库图片，最多 3 张</span>';
  row.querySelectorAll(".ref-chip").forEach(el => el.onclick = () => {
    state.img.refs.splice(+el.dataset.i, 1); renderRefRow();
  });
}

/* ---------------- 图片提示词流程 ---------------- */
function setSt(id, text, ok) { const el = $(id); if (el) { el.textContent = text; el.className = "st" + (ok ? " ok" : ""); } }

$("#analyzeBase").onclick = async () => {
  if (!state.img.base) return toast("先在图库单击一张底图", true);
  setSt("#st1", "分析中…");
  const fname = state.img.base.rel.split("/").pop();
  $("#analyzed").textContent = "分析中：" + fname;
  const r = await api("/api/img/analyze", { path: state.img.base.path });
  if (r.error) { setSt("#st1", "失败", false); return toast("分析失败：" + r.error, true); }
  state.img.analysis = r.analysis;
  $("#analyzed").textContent = "已分析：" + fname;
  const a = r.analysis;
  const map = { subject: "主体", light: "光线", material: "材质", composition: "构图", palette: "色调" };
  $("#analysisOut").innerHTML = Object.keys(map).filter(k => a[k])
    .map(k => `<div class="kv-row"><b>${map[k]}</b><span>${esc(a[k])}</span></div>`).join("") +
    (a.issues && a.issues.length ? `<div class="kv-row warn"><b>可改进</b><span>${a.issues.map(esc).join("；")}</span></div>` : "");
  setSt("#st1", "完成", true); setSt("#st3", "待生成", false);
};

$("#decomposeBtn").onclick = async () => {
  if (!state.img.refs.length) return toast("先 Shift+单击选几张参考图", true);
  setSt("#st2", "拆解中…");
  const r = await api("/api/img/decompose", { path: state.img.refs[0].path });
  if (r.error) { setSt("#st2", "失败", false); return toast("拆解失败：" + r.error, true); }
  state.img.decomp = r.decompose;
  const d = r.decompose || {};
  $("#decompOut").innerHTML = (d.transferable || [])
    .map(t => `<div class="dec-item"><b>${esc(t.item)}</b><span>${esc(t.how)}</span></div>`).join("")
    + ((d.avoid || []).length ? `<div class="dec-item avoid"><b>不建议照搬</b><span>${d.avoid.map(esc).join("；")}</span></div>` : "");
  setSt("#st2", "完成", true);
};

$("#dirBtn").onclick = async () => {
  if (!state.img.analysis) return toast("先完成第 ① 步底图分析", true);
  setSt("#st3", "生成中…");
  const r = await api("/api/img/directions", {
    analysis: state.img.analysis, workflow: $("#imgWorkflow").value, requirement: $("#requirement").value
  });
  if (r.error) { setSt("#st3", "失败", false); return toast("生成失败：" + r.error, true); }
  state.img.directions = r.directions || [];
  $("#dirs").innerHTML = state.img.directions.map((d, i) => `<div class="dir-card" data-i="${i}">
      <b>${esc(d.title)}</b><p>${esc(d.why || "")}</p><em>${esc(d.how || "")}</em></div>`).join("");
  $("#dirs").querySelectorAll(".dir-card").forEach(el => el.onclick = () => {
    $$("#dirs .dir-card").forEach(x => x.classList.remove("sel"));
    el.classList.add("sel");
    state.img.direction = state.img.directions[+el.dataset.i];
    setSt("#st4", "已选方向", true);
  });
  setSt("#st3", "完成", true);
};

$("#genImgPrompt").onclick = async () => {
  if (!state.img.analysis) return toast("先完成底图分析", true);
  setSt("#st5", "生成中…");
  const r = await api("/api/img/prompt", {
    analysis: state.img.analysis,
    direction: state.img.direction || {},
    form: {
      requirement: $("#requirement").value,
      purpose: $("#purpose").value,
      spec: $("#spec").value,
      constraint: $("#constraint").value
    },
    refNotes: (state.img.decomp && state.img.decomp.transferable) || []
  });
  if (r.error) { setSt("#st5", "失败", false); return toast("生成失败：" + r.error, true); }
  state.img.history = [];
  $("#optUndo").style.display = "none";
  $("#zhOut").value = r.zh || "";
  $("#enOut").value = r.en || "";
  $("#paramsOut").textContent = r.params || "";
  $("#checklist").innerHTML = (r.checklist || []).map(c => `<li>${esc(c)}</li>`).join("");
  setSt("#st5", "完成", true);
};

function applyImgResult(r) {
  if (r.zh) $("#zhOut").value = r.zh;
  if (r.en) $("#enOut").value = r.en;
  if (r.params) $("#paramsOut").textContent = r.params;
  if (r.checklist) $("#checklist").innerHTML = r.checklist.map(c => `<li>${esc(c)}</li>`).join("");
}

function currentPromptSet() {
  return { zh: $("#zhOut").value, en: $("#enOut").value, params: $("#paramsOut").textContent };
}

async function optimizeImg() {
  const instruction = $("#optReq").value.trim();
  const hasCur = ($("#zhOut").value || $("#enOut").value).trim();
  if (!state.img.analysis && !hasCur) return toast("先做底图分析，或先生成一版提示词", true);
  const btn = $("#optBtn");
  btn.disabled = true;
  btn.textContent = "优化中…";
  try {
    const r = await api("/api/img/optimize", {
      analysis: state.img.analysis || {},
      direction: state.img.direction || {},
      form: {
        requirement: $("#requirement").value,
        purpose: $("#purpose").value,
        spec: $("#spec").value,
        constraint: $("#constraint").value
      },
      current: hasCur ? currentPromptSet() : {},
      instruction: instruction || "整体提升质感与可执行性"
    });
    if (r.error) return toast("优化失败：" + r.error, true);
    state.img.history.push(currentPromptSet());
    applyImgResult(r);
    $("#optUndo").style.display = "";
    setSt("#st5", "已优化", true);
    toast(r.note ? "已优化：" + r.note : "已优化");
  } finally {
    btn.disabled = false;
    btn.textContent = "AI 优化提示词";
  }
}

$("#optBtn").onclick = optimizeImg;
$("#optUndo").onclick = () => {
  const prev = state.img.history.pop();
  if (!prev) return;
  applyImgResult(prev);
  if (!state.img.history.length) $("#optUndo").style.display = "none";
  toast("已撤销上一版");
};

$("#copyZh").onclick = () => copy($("#zhOut").value);
$("#copyEn").onclick = () => copy(($("#enOut").value + " " + $("#paramsOut").textContent).trim());
$("#openMJ2").onclick = () => window.open("https://www.midjourney.com/imagine", "_blank");
if ($("#recursive")) {
  $("#recursive").checked = state.recursive;
  $("#recursive").onchange = async (e) => { state.recursive = e.target.checked; await boot(); };
}
if ($("#imgFilter")) $("#imgFilter").oninput = renderImages;
if ($("#pickDir")) $("#pickDir").onclick = async () => {
  const r = await api("/api/pick-dir", {});
  if (r.canceled) return;
  if (r.error) return toast("选择失败：" + r.error, true);
  await boot();
  toast("图库已切换到：" + r.galleryDir);
};
function renderGalleryPath() {
  const el = $("#galleryPath");
  if (el) { el.textContent = state.gallery || ""; el.title = state.gallery || ""; }
}
if ($("#imgFilter2")) $("#imgFilter2").oninput = renderImages;

/* ---------------- 视频提示词 ---------------- */
function renderPresets() {
  const bar = $("#presetBar"); if (!bar) return;
  const list = state.vmode === "all" ? state.presets : state.presets.filter(p => (p.mode || "camera") === state.vmode);
  if (list.length && !list.some(p => p.id === state.preset)) selectPreset(list[0].id);
  bar.innerHTML = list.map(p =>
    `<button class="preset ${state.preset === p.id ? "active" : ""}" data-id="${esc(p.id)}">${p.icon || "▸"} ${esc(p.name)}</button>`).join("");
  bar.querySelectorAll(".preset").forEach(b => b.onclick = () => selectPreset(b.dataset.id));
  document.querySelectorAll(".vmode").forEach(b => b.classList.toggle("active", b.dataset.vmode === state.vmode));
  const lw = $("#loopWrap"), lp = $("#loopChk");
  if (lw) lw.style.display = state.vmode === "live2d" ? "" : "none";
  if (lp && state.vmode === "live2d") lp.checked = true;
}
function selectPreset(id) {
  state.preset = id;
  const p = state.presets.find(x => x.id === id);
  if ($("#presetDesc")) $("#presetDesc").textContent = p ? p.desc + `（建议 ${p.duration}s / ${p.ratio}）` : "";
  if (p && $("#duration")) { $("#duration").value = String(p.duration); }
  renderPresets();
}
function renderCatTabs() {
  const t = $("#catTabs"); if (!t) return;
  t.innerHTML = Object.keys(state.lib).map(c =>
    `<button data-cat="${esc(c)}" class="${c === state.cat ? "active" : ""}">${esc(c)}</button>`).join("");
  t.querySelectorAll("button").forEach(b => b.onclick = () => { state.cat = b.dataset.cat; renderCatTabs(); renderChips(); });
}
function renderChips() {
  const box = $("#chips"); if (!box) return;
  const lines = (state.lib[state.cat] || "").split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith("#"));
  box.innerHTML = lines.map(l => `<span class="chip">${esc(l.trim())}</span>`).join("");
  box.querySelectorAll(".chip").forEach(c => c.onclick = () => insert(c.textContent));
}
function insert(line) {
  const map = { "场景": "f_scene", "人物": "f_subject", "动作": "f_action", "镜头": "f_camera", "运镜": "f_camera",
                "光线": "f_light", "风格": "f_style", "H3示例": "f_style", "负面": "f_negative" };
  const id = map[state.cat] || state.lastField || "f_style";
  const el = $("#" + id); if (!el) return;
  const sep = el.value && !/[，,。.]$/.test(el.value) ? "，" : "";
  el.value = el.value + sep + line; el.focus();
}
function fields() {
  return {
    subject: $("#f_subject").value, action: $("#f_action").value, scene: $("#f_scene").value,
    camera: $("#f_camera").value, light: $("#f_light").value, style: $("#f_style").value
  };
}
async function makeVideoPrompt(mode) {
  toast(mode === "llm" ? "AI 正在优化…" : "拼装中…");
  const r = await api("/api/video-prompt", { fields: fields(), preset: state.preset, mode });
  if (r.error) return toast(r.error, true);
  if (!r.prompt) {
    const fb = await api("/api/video-prompt", { fields: fields(), preset: state.preset, mode: "rule" });
    $("#videoOut").value = fb.prompt || ""; return toast("AI 返回空，已回退规则", true);
  }
  $("#videoOut").value = r.prompt;
  state.videoHistory = []; $("#videoUndo").style.display = "none";
  toast("已生成");
}
async function analyze(slotIdx, override) {
  const s = state.slots[slotIdx || 0];
  const path = override || (s && s.path);
  if (!path) return toast("先把图放进参考图 1", true);
  toast("分析中…");
  const r = await api("/api/analyze", { path });
  if (r.error) return toast("分析失败：" + r.error, true);
  const map = { subject: "f_subject", action: "f_action", scene: "f_scene", camera: "f_camera", light: "f_light", style: "f_style" };
  for (const k in map) if (r.fields[k]) $("#" + map[k]).value = r.fields[k];
  toast("已回填六个字段");
}
function renderSlots() {
  $$(".slot").forEach((el, i) => {
    const s = state.slots[i];
    el.classList.toggle("filled", !!s);
    el.innerHTML = s
      ? `<img src="/media/${encodeURI(s.rel)}"><span class="slot-name">${esc(s.rel.split("/").pop())}</span>`
      : `<span>参考图 ${i + 1}</span><em>${["主体", "场景", "动作"][i]}</em>`;
    el.onclick = () => { if (s) { state.slots[i] = null; renderSlots(); } else state.activeSlot = i; };
  });
}
function assignImage(path, rel) {
  let idx = state.slots.findIndex(s => !s);
  if (idx === -1) idx = state.activeSlot;
  state.slots[idx] = { path, rel }; state.activeSlot = (idx + 1) % 3; renderSlots();
}
async function copy(t) {
  try { await navigator.clipboard.writeText(t); } catch { }
  toast("已复制");
}
function stripParams(s) { return s.replace(/\s*--[a-z]+(\s+[^\s-][^\s]*)?/gi, "").trim(); }
async function genVideo() {
  const prompt = stripParams(($("#videoOut").value || "").trim());
  if (!prompt) return toast("先生成视频提示词", true);
  if (!state.slots.some(Boolean)) return toast("至少选一张参考图", true);
  if (!$("#projectSel").value) return toast("先选或新建项目", true);
  $("#genVideo").disabled = true; toast("提交中…"); $("#bar").style.width = "8%";
  const pre = state.presets.find(p => p.id === state.preset);
  const r = await api("/api/video/submit", {
    prompt, duration: $("#duration").value, presetName: pre ? pre.name : "",
    images: state.slots.filter(Boolean).map(s => s.path), project: $("#projectSel").value,
    loop: !!(document.getElementById("loopChk") && document.getElementById("loopChk").checked)
  });
  if (r.archived && r.archived.ok) toast("已归档提示词与参考图到项目");
  if (r.error) { $("#genVideo").disabled = false; $("#bar").style.width = "0"; return toast(r.error, true); }
  poll(r.id);
}
async function poll(id) {
  const t0 = Date.now();
  const tick = async () => {
    const s = await api("/api/video/status?id=" + id);
    if (s.state === "running") {
      const sec = Math.round((Date.now() - t0) / 1000);
      toast(`生成中… ${sec}s`); $("#bar").style.width = Math.min(92, 8 + sec * 1.6) + "%";
      setTimeout(tick, 3000);
    } else if (s.state === "done") {
      $("#bar").style.width = "100%"; toast(`完成 · ${s.elapsed}s`);
      const v = $("#player"); v.src = s.url; v.classList.add("show");
      $("#cost").textContent = (s.cost || "") + (s.saved ? "　已归档" : "");
      $("#genVideo").disabled = false; boot();
    } else {
      $("#bar").style.width = "0"; toast("失败：" + (s.error || "未知"), true); $("#genVideo").disabled = false;
    }
  };
  tick();
}
function askText(title, defVal) {
  return new Promise((resolve) => {
    const mask = $("#modal"), input = $("#modalInput");
    $("#modalTitle").textContent = title;
    input.value = defVal || "";
    mask.style.display = "flex";
    input.focus(); input.select();
    const done = (v) => { mask.style.display = "none"; cleanup(); resolve(v); };
    const ok = () => done(input.value.trim());
    const cancel = () => done(null);
    const onKey = (e) => {
      if (e.key === "Enter") { e.preventDefault(); ok(); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    };
    function cleanup() {
      $("#modalOk").removeEventListener("click", ok);
      $("#modalCancel").removeEventListener("click", cancel);
      input.removeEventListener("keydown", onKey);
    }
    $("#modalOk").addEventListener("click", ok);
    $("#modalCancel").addEventListener("click", cancel);
    input.addEventListener("keydown", onKey);
  });
}

async function newProject() {
  const name = await askText("新建项目", "");
  if (!name) return;
  toast("正在创建项目…");
  const r = await api("/api/project/create", { name });
  if (r.error) return toast("创建失败：" + r.error, true);
  await boot();
  const key = r.path.split("\\").pop();
  $("#projectSel").value = key;
  state.project = key;
  toast("项目已建：" + key);
}

document.querySelectorAll(".vmode").forEach(b => b.onclick = () => {
  state.vmode = b.dataset.vmode;
  const list = state.vmode === "all" ? state.presets : state.presets.filter(p => (p.mode || "camera") === state.vmode);
  if (list.length) selectPreset(list[0].id);
  renderPresets();
  scheduleSave();
});
if ($("#wfBtn")) $("#wfBtn").onclick = async () => {
  const btn = $("#wfBtn");
  btn.disabled = true; btn.textContent = "更新中…";
  try {
    const r = await api("/api/workflows/update", {});
    if (r.error) toast("更新失败：" + r.error, true);
    else toast("工作流已更新：" + r.files.length + " 个文件 → 项目模板/工作流目录");
  } finally { btn.disabled = false; btn.textContent = "↓ 更新工作流"; }
};
if ($("#ruleBtn")) $("#ruleBtn").onclick = () => makeVideoPrompt("rule");
if ($("#llmBtn")) $("#llmBtn").onclick = () => makeVideoPrompt("llm");
if ($("#analyzeBtn")) $("#analyzeBtn").onclick = () => analyze(0);
if ($("#copyVideo")) $("#copyVideo").onclick = () => copy($("#videoOut").value);

if ($("#refineBtn")) $("#refineBtn").onclick = async () => {
  const instruction = ($("#optReqVideo").value || "").trim();
  const current = $("#videoOut").value.trim();
  if (!instruction && !current) return toast("先写优化要求，或先生成一版视频词", true);
  const btn = $("#refineBtn");
  btn.disabled = true; btn.textContent = "优化中…";
  toast("正在按要求优化…");
  try {
    const pre = state.presets.find(p => p.id === state.preset);
    const r = await api("/api/video-prompt", {
      fields: fields(), preset: state.preset, mode: "refine",
      current, instruction, presetName: pre ? pre.name : ""
    });
    if (r.error) return toast("优化失败：" + r.error, true);
    state.videoHistory.push(current);
    $("#videoOut").value = r.prompt || "";
    $("#videoUndo").style.display = "";
    toast("已按要求优化");
  } finally {
    btn.disabled = false; btn.textContent = "按要求优化";
  }
};

if ($("#videoUndo")) $("#videoUndo").onclick = () => {
  const prev = state.videoHistory.pop();
  if (prev === undefined) return;
  $("#videoOut").value = prev;
  if (!state.videoHistory.length) $("#videoUndo").style.display = "none";
  toast("已撤销");
};
if ($("#genVideo")) $("#genVideo").onclick = genVideo;
if ($("#archiveBtn")) $("#archiveBtn").onclick = async () => {
  const project = $("#projectSel").value;
  if (!project) return toast("先选或新建项目", true);
  const prompt = stripParams($("#videoOut").value || "");
  const imgs = state.slots.filter(Boolean).map(s => s.path);
  if (!prompt && !imgs.length) return toast("没有可归档的内容", true);
  const pre = state.presets.find(p => p.id === state.preset);
  const r = await api("/api/project/archive", {
    project, prompt, images: imgs, duration: $("#duration").value, presetName: pre ? pre.name : ""
  });
  if (r.error) return toast("归档失败：" + r.error, true);
  if (!r.ok) return toast("归档失败：" + (r.reason || "未知"), true);
  toast("已归档：提示词" + (r.refs && r.refs.length ? " + " + r.refs.length + " 张参考图" : ""));
};
$("#newProject").onclick = newProject;
$("#projectSel").onchange = (e) => { state.project = e.target.value; };
$$("textarea, input").forEach(el => el.addEventListener("focus", () => { state.lastField = el.id; }));


/* ---------------- 自动保存 / 恢复（重启不丢已填内容） ---------------- */
const PKEY = "trb.state.v1";
let restoredOnce = false;

function collectState() {
  const g = (id) => { const el = document.getElementById(id); return el ? el.value : ""; };
  return {
    mode: state.mode,
    vmode: state.vmode,
    project: g("projectSel"),
    video: {
      prompt: g("videoOut"), duration: g("duration"), optReq: g("optReqVideo"),
      playerSrc: (document.getElementById("player") || {}).src || "",
      cost: (document.getElementById("cost") || {}).textContent || "",
      slots: state.slots.map(s => (s && s.path) || ""),
      fields: { subject: g("f_subject"), action: g("f_action"), scene: g("f_scene"), camera: g("f_camera"), light: g("f_light"), style: g("f_style") }
    },
    image: {
      zh: g("zhOut"), en: g("enOut"), optReq: g("optReq"),
      params: document.getElementById("paramsOut") ? document.getElementById("paramsOut").textContent : "",
      checklist: document.getElementById("checklist") ? document.getElementById("checklist").innerHTML : ""
    }
  };
}
function saveState() { if (!saveEnabled) return; try { localStorage.setItem(PKEY, JSON.stringify(collectState())); } catch (e) {} }
let saveTimer = null;
let saveEnabled = false;
function scheduleSave() { if (!saveEnabled) return; clearTimeout(saveTimer); saveTimer = setTimeout(saveState, 600); }

function restoreState() {
  if (restoredOnce) return;
  restoredOnce = true;
  let st = null;
  try { st = JSON.parse(localStorage.getItem(PKEY) || "null"); } catch (e) { st = null; }
  if (!st) return;
  if (st.mode) setMode(st.mode);
  if (st.vmode) { state.vmode = st.vmode; renderPresets(); }
  if (st.project && document.getElementById("projectSel")) {
    const sel = document.getElementById("projectSel");
    if ([...sel.options].some(o => o.value === st.project)) { sel.value = st.project; state.project = st.project; }
  }
  const v = st.video || {};
  if (v.prompt) { const el = document.getElementById("videoOut"); if (el) el.value = v.prompt; }
  if (v.duration) { const el = document.getElementById("duration"); if (el) el.value = v.duration; }
  if (v.optReq) { const el = document.getElementById("optReqVideo"); if (el) el.value = v.optReq; }
  if (v.playerSrc) {
    const pl = document.getElementById("player");
    if (pl) { pl.src = v.playerSrc; pl.classList.add("show"); }
    const c = document.getElementById("cost");
    if (c && v.cost) c.textContent = v.cost;
    const vs = document.getElementById("vstate");
    if (vs) { vs.textContent = "已恢复上次结果"; vs.className = "vstate"; }
  }
  if (v.fields) {
    const map = { subject: "f_subject", action: "f_action", scene: "f_scene", camera: "f_camera", light: "f_light", style: "f_style" };
    for (const k in map) { const el = document.getElementById(map[k]); if (el && v.fields[k]) el.value = v.fields[k]; }
  }
  if (Array.isArray(v.slots) && v.slots.length === 3) {
    state.slots = v.slots.map((p) => {
      if (!p) return null;
      const hit = state.images.find(i => i.path === p);
      return { path: p, rel: hit ? hit.rel : p.split(/[\\/]/).pop() };
    });
    renderSlots();
  }
  const im = st.image || {};
  const setVal = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
  setVal("zhOut", im.zh); setVal("enOut", im.en); setVal("optReq", im.optReq);
  if (im.params) { const el = document.getElementById("paramsOut"); if (el) el.textContent = im.params; }
  if (im.checklist) { const el = document.getElementById("checklist"); if (el) el.innerHTML = im.checklist; }
}

document.addEventListener("input", scheduleSave, true);
document.addEventListener("change", scheduleSave, true);
document.addEventListener("click", () => setTimeout(scheduleSave, 300), true);
window.addEventListener("beforeunload", saveState);

boot().then(() => { try { restoreState(); } catch (e) {} saveEnabled = true; });
setInterval(async () => {
  const s = await api("/api/state");
  const cd = $("#comfyDot"); if (cd) { cd.textContent = s.comfy ? "ComfyUI 在线" : "ComfyUI 离线"; cd.className = "pill " + (s.comfy ? "on" : "off"); }
}, 15000);