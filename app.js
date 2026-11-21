import { initGlobe } from './globe.js';

const $ = id => document.getElementById(id);
const storageKey = 'tle-ephemeris-selection-v1';
const selected = new Map();
let results = [], catalog, moreQuery = '', selectionBusy = false, worker, writer, cancelled = false;

try {
  for (const satellite of JSON.parse(localStorage.getItem(storageKey) || '[]')) selected.set(satellite.id, satellite);
} catch { $('search-status').textContent = '读取已选卫星失败，请重新检索。'; }

function saveSelection() {
  try { localStorage.setItem(storageKey, JSON.stringify([...selected.values()])); }
  catch { $('search-status').textContent = '浏览器无法保存卫星选择，本次选择仍可使用。'; }
}
async function selectSatellite(satellite) {
  if (satellite.elements) { selected.set(satellite.id, satellite); return; }
  const response = await fetch(`https://celestrak.org/NORAD/elements/gp.php?${new URLSearchParams({ CATNR: satellite.id, FORMAT: 'JSON' })}`, { signal: AbortSignal.timeout(20000) });
  if (response.status === 404) throw new Error(`${satellite.name} 暂无可用轨道根数`);
  if (!response.ok) throw new Error(`获取 ${satellite.name} 轨道根数失败（HTTP ${response.status}）`);
  const records = await response.json();
  const record = Array.isArray(records) && records.find(item => Number(item.NORAD_CAT_ID) === satellite.id);
  if (!record) throw new Error(`${satellite.name} 暂无可用轨道根数`);
  const updated = { id: satellite.id, name: record.OBJECT_NAME || satellite.name, designator: record.OBJECT_ID || satellite.designator, epoch: record.EPOCH || '', fetched: new Date().toISOString(), elements: record };
  selected.set(updated.id, updated);
}

async function loadCatalog() {
  if (catalog) return catalog;
  const response = await fetch('https://celestrak.org/pub/satcat.csv', { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`CelesTrak 目录返回 HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    parts.push(decoder.decode(value, { stream: true }));
    $('search-status').textContent = `正在读取在轨目录，已接收 ${(received / 1048576).toFixed(1)} MB…`;
  }
  parts.push(decoder.decode());
  const text = parts.join('');
  const rows = text.match(/(?:"(?:[^"]|"")*"|[^,\r\n]*)(?:,(?:"(?:[^"]|"")*"|[^,\r\n]*))*(?:\r?\n|$)/g) || [];
  const parse = row => (row.trimEnd().match(/("(?:[^"]|"")*"|[^,]*)(,|$)/g) || []).map(field => field.replace(/,$/, '').replace(/^"|"$/g, '').replaceAll('""', '"'));
  const headers = parse(rows.shift() || '');
  const indexes = ['OBJECT_NAME', 'OBJECT_ID', 'NORAD_CAT_ID', 'DECAY_DATE', 'ORBIT_CENTER', 'ORBIT_TYPE'].map(name => headers.indexOf(name));
  if (indexes.slice(0, 4).some(index => index < 0)) throw new Error('CelesTrak 目录格式有误');
  const [nameIndex, designationIndex, idIndex, decayIndex, centerIndex, orbitIndex] = indexes;
  catalog = [];
  for (const row of rows) {
    const fields = parse(row);
    if (!fields[idIndex] || fields[decayIndex] || (centerIndex >= 0 && fields[centerIndex] && fields[centerIndex] !== 'EA') || (orbitIndex >= 0 && fields[orbitIndex] && !['ORB', 'DOC'].includes(fields[orbitIndex]))) continue;
    catalog.push({ id: Number(fields[idIndex]), name: fields[nameIndex] || '未命名卫星', designator: fields[designationIndex] || '' });
  }
  return catalog;
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
    checkbox.disabled = selectionBusy;
    checkbox.onchange = async () => {
      selectionBusy = true; render();
      try {
        if (checkbox.checked) await selectSatellite(satellite); else selected.delete(satellite.id);
        saveSelection();
      } catch (error) { $('search-status').textContent = `选择失败：${error.message}`; }
      finally { selectionBusy = false; render(); }
    };
    const detail = document.createElement('span'), title = document.createElement('strong'), meta = document.createElement('span');
    title.textContent = satellite.name; meta.className = 'meta'; meta.textContent = `NORAD ${satellite.id} · 国际编号 ${satellite.designator || '—'}`;
    if (satellite.elements) meta.textContent += ` · 根数历元 UTC ${satellite.epoch || '—'} · 获取时间 UTC ${satellite.fetched.replace('T', ' ').slice(0, 19)}`;
    detail.append(title, meta); label.append(checkbox, detail); $('results').append(label);
  }
  $('select-all').disabled = !results.length || selectionBusy;
}

$('search-form').onsubmit = async event => {
  event.preventDefault();
  const query = $('query').value.trim().toUpperCase();
  if (!query) return;
  moreQuery = /^\d+$/.test(query) ? query : '';
  $('search-more').hidden = !moreQuery;
  $('search-more').disabled = true;
  $('search-button').disabled = true; $('search-status').textContent = '正在查询 CelesTrak…';
  try {
    if (/^\d{4}-[0-9A-Z]*$/.test(query) && !/^\d{4}-\d{3}[A-Z]{0,3}$/.test(query)) {
      $('search-status').textContent = catalog ? '正在匹配在轨目录…' : '正在读取在轨目录，首次查询可能需要一些时间…';
      const matches = (await loadCatalog()).filter(item => String(item.id).includes(query) || item.designator.toUpperCase().includes(query));
      results = matches.slice(0, 50);
      render();
      $('search-status').textContent = matches.length ? `找到 ${matches.length} 个在轨对象${matches.length > 50 ? '，显示前 50 个' : ''}，选中时获取轨道根数。` : '未找到匹配的在轨对象。';
      return;
    }
    let key = 'NAME', value = query, designation;
    if (/^\d+$/.test(query)) { key = 'CATNR'; value = query; }
    else if (/^\d{4}-\d{3}[A-Z]{0,3}$/.test(query)) { key = 'INTDES'; value = query.slice(0, 8); designation = query; }
    else { const hjs = query.match(/^HJS(?:[-\s]*(\d+[A-Z]*))?$/); if (hjs) value = 'HULIANWANG JISHU SHIYAN' + (hjs[1] ? ` ${hjs[1]}` : ''); }
    const response = await fetch(`https://celestrak.org/NORAD/elements/gp.php?${new URLSearchParams({ [key]: value, FORMAT: 'JSON' })}`, { signal: AbortSignal.timeout(20000) });
    if (response.status === 404) { results = []; $('search-status').textContent = '未找到匹配卫星。'; render(); return; }
    if (!response.ok) throw new Error(`CelesTrak 返回 HTTP ${response.status}`);
    const records = await response.json();
    if (!Array.isArray(records)) throw new Error('CelesTrak 返回的数据格式有误');
    const fetched = new Date().toISOString();
    results = records.filter(record => record.NORAD_CAT_ID && record.OBJECT_NAME && (key !== 'CATNR' || String(record.NORAD_CAT_ID) === String(Number(value))) && (key !== 'NAME' || record.OBJECT_NAME.toUpperCase().includes(value)) && (!designation || designation.length === 8 || record.OBJECT_ID?.toUpperCase() === designation)).slice(0, 50).map(record => ({ id: Number(record.NORAD_CAT_ID), name: record.OBJECT_NAME, designator: record.OBJECT_ID || '', epoch: record.EPOCH || '', fetched, elements: record }));
    for (const satellite of results) if (selected.has(satellite.id)) selected.set(satellite.id, satellite);
    saveSelection(); render(); $('search-status').textContent = results.length ? `找到 ${results.length} 颗匹配卫星${records.length > 50 ? '，最多显示 50 颗' : ''}。` : '未找到匹配卫星。';
  } catch (error) { $('search-status').textContent = `查询失败：${error.message}，请检查网络后重试。`; }
  finally { $('search-button').disabled = false; $('search-more').disabled = false; }
};
$('query').addEventListener('input', () => { if ($('query').value.trim().toUpperCase() !== moreQuery) $('search-more').hidden = true; });
$('search-more').onclick = async () => {
  if (!moreQuery || $('query').value.trim().toUpperCase() !== moreQuery) return;
  $('search-button').disabled = true; $('search-more').disabled = true;
  $('search-status').textContent = catalog ? '正在匹配在轨目录…' : '正在读取在轨目录，首次查询可能需要一些时间…';
  try {
    const matches = (await loadCatalog()).filter(item => String(item.id).includes(moreQuery));
    results = matches.slice(0, 50);
    render();
    $('search-status').textContent = matches.length ? `找到 ${matches.length} 个在轨对象${matches.length > 50 ? '，显示前 50 个' : ''}，选中时获取轨道根数。` : '未找到匹配的在轨对象。';
  } catch (error) { $('search-status').textContent = `查询失败：${error.message}，请检查网络后重试。`; }
  finally { $('search-button').disabled = false; $('search-more').disabled = false; }
};
$('select-all').onclick = async () => {
  selectionBusy = true; render();
  let failed = 0;
  for (const satellite of results) {
    if (selected.has(satellite.id)) continue;
    $('search-status').textContent = `正在获取 ${satellite.name} 的轨道根数…`;
    try { await selectSatellite(satellite); saveSelection(); }
    catch { failed++; }
  }
  selectionBusy = false; render();
  $('search-status').textContent = failed ? `已选择可获取根数的对象，${failed} 个对象的根数获取失败。` : '已选择全部结果。';
};
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
initGlobe({
  getSatellites: () => [...selected.values()],
  getTimes: () => {
    const parse = value => Date.parse(`${value.length === 16 ? value + ':00' : value}+08:00`);
    const start = parse($('start').value), end = parse($('end').value);
    return { start, duration:(end - start) / 1000, step:Number($('step').value) };
  },
});
