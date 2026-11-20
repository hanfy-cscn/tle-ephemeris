const $ = id => document.getElementById(id);
const storageKey = 'tle-ephemeris-selection-v1';
const selected = new Map();
let results = [], worker, writer, cancelled = false;

try {
  for (const satellite of JSON.parse(localStorage.getItem(storageKey) || '[]')) selected.set(satellite.id, satellite);
} catch { $('search-status').textContent = '读取已选卫星失败，请重新检索。'; }

function saveSelection() {
  try { localStorage.setItem(storageKey, JSON.stringify([...selected.values()])); }
  catch { $('search-status').textContent = '浏览器无法保存卫星选择，本次选择仍可使用。'; }
}
function render() {
  $('count').textContent = selected.size;
  $('selected').replaceChildren();
  if (!selected.size) {
    const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '尚未选择卫星'; $('selected').append(empty);
  }
  for (const satellite of selected.values()) {
    const chip = document.createElement('span'); chip.className = 'chip';
    const text = document.createElement('span'); text.textContent = `${satellite.name} · ${satellite.id}`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `移除 ${satellite.name}`);
    remove.onclick = () => { selected.delete(satellite.id); saveSelection(); render(); };
    chip.append(text, remove); $('selected').append(chip);
  }
  $('results').replaceChildren();
  for (const satellite of results) {
    const label = document.createElement('label'); label.className = 'result';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(satellite.id);
    checkbox.onchange = () => { if (checkbox.checked) selected.set(satellite.id, satellite); else selected.delete(satellite.id); saveSelection(); render(); };
    const detail = document.createElement('span'), title = document.createElement('strong'), meta = document.createElement('span');
    title.textContent = satellite.name; meta.className = 'meta'; meta.textContent = `NORAD ${satellite.id} · 国际编号 ${satellite.designator || '—'} · 根数历元 UTC ${satellite.epoch || '—'} · 获取时间 UTC ${satellite.fetched.replace('T', ' ').slice(0, 19)}`;
    detail.append(title, meta); label.append(checkbox, detail); $('results').append(label);
  }
  $('select-all').disabled = !results.length;
}

$('search-form').onsubmit = async event => {
  event.preventDefault();
  const query = $('query').value.trim().toUpperCase();
  if (!query) return;
  $('search-button').disabled = true; $('search-status').textContent = '正在查询 CelesTrak…';
  try {
    let key = 'NAME', value = query, designation;
    if (/^\d+$/.test(query)) { key = 'CATNR'; value = query; }
    else if (/^\d{4}-\d{3}[A-Z]{0,3}$/.test(query)) { key = 'INTDES'; value = query.slice(0, 8); designation = query; }
    else { const hjs = query.match(/^HJS(?:[-\s]*(\d+[A-Z]*))?$/); if (hjs) value = 'HULIANWANG JISHU SHIYAN' + (hjs[1] ? ` ${hjs[1]}` : ''); }
    const response = await fetch(`https://celestrak.org/NORAD/elements/gp.php?${new URLSearchParams({ [key]: value, FORMAT: 'JSON' })}`);
    if (response.status === 404) { results = []; $('search-status').textContent = '未找到匹配卫星。'; render(); return; }
    if (!response.ok) throw new Error(`CelesTrak 返回 HTTP ${response.status}`);
    const records = await response.json();
    if (!Array.isArray(records)) throw new Error('CelesTrak 返回的数据格式有误');
    const fetched = new Date().toISOString();
    results = records.filter(record => record.NORAD_CAT_ID && record.OBJECT_NAME && (key !== 'NAME' || record.OBJECT_NAME.toUpperCase().includes(value)) && (!designation || designation.length === 8 || record.OBJECT_ID?.toUpperCase() === designation)).slice(0, 50).map(record => ({ id: Number(record.NORAD_CAT_ID), name: record.OBJECT_NAME, designator: record.OBJECT_ID || '', epoch: record.EPOCH || '', fetched, elements: record }));
    for (const satellite of results) if (selected.has(satellite.id)) selected.set(satellite.id, satellite);
    saveSelection(); render(); $('search-status').textContent = results.length ? `找到 ${results.length} 颗匹配卫星${records.length > 50 ? '，最多显示 50 颗' : ''}。` : '未找到匹配卫星。';
  } catch (error) { $('search-status').textContent = `查询失败：${error.message}，请检查网络后重试。`; }
  finally { $('search-button').disabled = false; }
};
$('select-all').onclick = () => { for (const satellite of results) selected.set(satellite.id, satellite); saveSelection(); render(); };
$('clear').onclick = () => { selected.clear(); saveSelection(); render(); };

function beijingInput(date) { return new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 19); }
const now = new Date(); now.setMilliseconds(0); $('start').value = beijingInput(now); $('end').value = beijingInput(new Date(now.getTime() + 3600000));
document.querySelector('.shortcuts').onclick = event => {
  const days = Number(event.target.dataset.days); if (!days || !$('start').value) return;
  const start = Date.parse(`${$('start').value.length === 16 ? $('start').value + ':00' : $('start').value}+08:00`);
  if (Number.isFinite(start)) $('end').value = beijingInput(new Date(start + days * 86400000));
};
$('cancel').onclick = () => { cancelled = true; worker?.terminate(); worker = undefined; writer?.abort().catch(() => {}); writer = undefined; $('export').disabled = false; $('cancel').hidden = true; $('export-status').textContent = '已取消导出。'; };
$('export-form').onsubmit = async event => {
  event.preventDefault();
  if (!selected.size) { $('export-status').textContent = '请先选择卫星。'; return; }
  const parseTime = value => Date.parse(`${value.length === 16 ? value + ':00' : value}+08:00`);
  const start = parseTime($('start').value), end = parseTime($('end').value), step = Number($('step').value), duration = (end - start) / 1000;
  if (!Number.isInteger(duration) || duration <= 0 || !Number.isSafeInteger(step) || step < 1) { $('export-status').textContent = '请检查起止时间和采样步长。'; return; }
  const filename = `tle-ephemeris-${beijingInput(new Date()).replaceAll(':', '-')}.csv`;
  let chunks = [];
  try {
    if (typeof window.showSaveFilePicker === 'function') {
      const handle = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: 'CSV 文件', accept: { 'text/csv': ['.csv'] } }] });
      writer = await handle.createWritable();
    }
    cancelled = false; $('export').disabled = true; $('cancel').hidden = false; $('progress').hidden = false; $('progress').value = 0;
    const header = '\ufefftime_bjt,satellite_name,norad_catalog_id,international_designator,longitude_deg,latitude_deg,height_km,ecef_x_km,ecef_y_km,ecef_z_km,ecef_vx_kmps,ecef_vy_kmps,ecef_vz_kmps\r\n';
    if (writer) await writer.write(header); else chunks.push(header);
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = async ({data}) => {
      try {
        if (data.error) throw new Error(data.error);
        if (writer) await writer.write(data.output); else chunks.push(data.output);
        if (cancelled) return;
        $('progress').value = data.completed / data.count * 100; $('export-status').textContent = `正在外推 ${data.completed} / ${data.count} 个时间片`;
        if (data.done) {
          if (writer) { await writer.close(); writer = undefined; }
          else { const url = URL.createObjectURL(new Blob(chunks, {type:'text/csv;charset=utf-8'})); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
          worker.terminate(); worker = undefined; $('export').disabled = false; $('cancel').hidden = true; $('export-status').textContent = '星历 CSV 已生成。';
        } else worker.postMessage({type:'next'});
      } catch (error) { worker?.terminate(); worker = undefined; await writer?.abort().catch(() => {}); writer = undefined; $('export').disabled = false; $('cancel').hidden = true; $('export-status').textContent = `导出失败：${error.message}`; }
    };
    worker.onerror = event => { worker?.terminate(); worker = undefined; writer?.abort().catch(() => {}); writer = undefined; $('export').disabled = false; $('cancel').hidden = true; $('export-status').textContent = `导出失败：${event.message}`; };
    worker.postMessage({type:'start', satellites:[...selected.values()], start, duration, step});
  } catch (error) { if (error.name !== 'AbortError') $('export-status').textContent = `导出失败：${error.message}`; }
};
render();
