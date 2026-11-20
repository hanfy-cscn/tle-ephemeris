import { json2satrec } from './vendor/io.js';
import { propagate, gstime } from './vendor/propagation.js';
import { eciToEcf } from './vendor/transforms.js';
import { buildOffNadirCone } from './visibility-cone.js';

export function initGlobe({ getSatellites, getTimes }) {
  const $ = id => document.getElementById(id);
  const viewer = new Cesium.Viewer('globe', { animation:false, timeline:false, baseLayerPicker:false, geocoder:false, homeButton:false, sceneModePicker:false, navigationHelpButton:false, baseLayer:false, terrainProvider:new Cesium.EllipsoidTerrainProvider(), infoBox:false, selectionIndicator:false });
  const imagery = Cesium.ImageryLayer.fromProviderAsync(Cesium.SingleTileImageryProvider.fromUrl('./assets/earth.jpg'));
  imagery.brightness = 0.65;
  viewer.imageryLayers.add(imagery);
  viewer.camera.setView({destination:Cesium.Cartesian3.fromDegrees(105, 30, 24000000)});
  const satelliteEntities = [], coneEntities = [], terminalEntities = [];
  let satellites = [], start, duration, step, frameCount = 0, selectedIndex = -1, playing = false, elapsed = 0, lastTick, renderedIndex = -1, trajectory;

  function clearCone() { for (const entity of coneEntities) viewer.entities.remove(entity); coneEntities.length = 0; }
  function renderTrajectory() {
    if (trajectory) viewer.entities.remove(trajectory);
    trajectory = undefined;
    if (!$('show-trajectory').checked || selectedIndex < 0) return;
    const points = [], stride = Math.max(1, Math.ceil((frameCount - 1) / 1200));
    for (let index = 0; index < frameCount; index += stride) {
      const instant = new Date(start + Math.min(index * step, duration) * 1000);
      const state = propagate(satellites[selectedIndex].satrec, instant);
      if (!state?.position) throw new Error(`${satellites[selectedIndex].name} 轨迹外推失败。`);
      const point = eciToEcf(state.position, gstime(instant));
      points.push(Cesium.Cartesian3.fromElements(point.x * 1000, point.y * 1000, point.z * 1000));
    }
    if ((frameCount - 1) % stride) {
      const instant = new Date(start + duration * 1000);
      const state = propagate(satellites[selectedIndex].satrec, instant);
      if (!state?.position) throw new Error(`${satellites[selectedIndex].name} 轨迹外推失败。`);
      const point = eciToEcf(state.position, gstime(instant));
      points.push(Cesium.Cartesian3.fromElements(point.x * 1000, point.y * 1000, point.z * 1000));
    }
    trajectory = viewer.entities.add({polyline:{positions:points,arcType:Cesium.ArcType.NONE,width:2,material:Cesium.Color.CYAN}});
  }
  function renderTerminals() {
    for (const entity of terminalEntities) viewer.entities.remove(entity);
    terminalEntities.length = 0;
    const messages = [];
    const angle = Number($('off-nadir').value);
    const validAngle = Number.isFinite(angle) && angle > 0 && angle < 90;
    for (const [index, row] of [...$('terminals').children].entries()) {
      const fields = row.querySelectorAll('input');
      const [name, longitudeText, latitudeText, heightText] = [...fields].map(field => field.value.trim());
      if (!name && !longitudeText && !latitudeText && !heightText) continue;
      const longitude = Number(longitudeText), latitude = Number(latitudeText), height = Number(heightText || 0);
      const terminalName = name || `终端 ${index + 1}`;
      if (!longitudeText || !latitudeText || !Number.isFinite(longitude) || Math.abs(longitude) > 180 || !Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(height) || height < 0) {
        messages.push(`${terminalName}：请填写有效经纬度和非负高度。`);
        continue;
      }
      const ground = Cesium.Cartesian3.fromDegrees(longitude, latitude, height);
      terminalEntities.push(viewer.entities.add({position:ground,point:{pixelSize:9,color:Cesium.Color.BLACK,outlineColor:Cesium.Color.WHITE,outlineWidth:2,disableDepthTestDistance:Number.POSITIVE_INFINITY},label:{text:terminalName,font:'14px sans-serif',fillColor:Cesium.Color.WHITE,outlineColor:Cesium.Color.BLACK,outlineWidth:3,style:Cesium.LabelStyle.FILL_AND_OUTLINE,pixelOffset:new Cesium.Cartesian2(10,-8),horizontalOrigin:Cesium.HorizontalOrigin.LEFT}}));
      let nearest = -1, nearestDistance = Infinity;
      if (validAngle) for (let i = 0; i < satelliteEntities.length; i++) {
        const satellite = satelliteEntities[i].position.getValue(viewer.clock.currentTime);
        const toTerminal = Cesium.Cartesian3.subtract(ground, satellite, new Cesium.Cartesian3());
        const distance = Cesium.Cartesian3.magnitude(toTerminal);
        const satelliteLength = Cesium.Cartesian3.magnitude(satellite);
        const cosine = -Cesium.Cartesian3.dot(toTerminal, satellite) / (distance * satelliteLength);
        if (cosine < Math.cos(Cesium.Math.toRadians(angle))) continue;
        const direction = Cesium.Cartesian3.normalize(Cesium.Cartesian3.negate(toTerminal, new Cesium.Cartesian3()), new Cesium.Cartesian3());
        const intersection = Cesium.IntersectionTests.rayEllipsoid(new Cesium.Ray(ground, direction), Cesium.Ellipsoid.WGS84);
        if (intersection && intersection.stop > 0.01 && intersection.start < distance - 0.01) continue;
        if (distance < nearestDistance) { nearest = i; nearestDistance = distance; }
      }
      if (!validAngle) messages.push(`${terminalName}：请填写有效离轴半角。`);
      else if (!satellites.length) messages.push(`${terminalName}：请先显示卫星。`);
      else if (nearest < 0) messages.push(`${terminalName}：当前无可视卫星。`);
      else {
        messages.push(`${terminalName} → ${satellites[nearest].name}（${(nearestDistance / 1000).toFixed(1)} km）`);
        terminalEntities.push(viewer.entities.add({polyline:{positions:[ground,satelliteEntities[nearest].position.getValue(viewer.clock.currentTime)],arcType:Cesium.ArcType.NONE,width:2,material:Cesium.Color.LIME}}));
      }
    }
    $('terminal-assignments').replaceChildren(...messages.map(message => { const line = document.createElement('div'); line.textContent = message; return line; }));
  }

  $('add-terminal').onclick = () => {
    const row = document.createElement('div'); row.className = 'terminal-row';
    for (const [title, key, type, value] of [['名称','name','text',''],['经度（°）','longitude','number',''],['纬度（°）','latitude','number',''],['高度（m）','height','number','']]) {
      const label = document.createElement('label'); label.textContent = title;
      const field = document.createElement('input'); field.type = type; field.dataset.field = key; field.value = value;
      if (type === 'number') field.step = 'any';
      if (key === 'height') field.placeholder = '默认 0';
      label.append(field); row.append(label);
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'subtle'; remove.textContent = '删除';
    remove.onclick = () => { row.remove(); renderTerminals(); };
    row.append(remove); $('terminals').append(row);
  };
  $('terminals').addEventListener('input', renderTerminals);
  function renderCone() {
    clearCone();
    if (!$('show-coverage').checked || selectedIndex < 0) return;
    const position = satelliteEntities[selectedIndex]?.position?.getValue(viewer.clock.currentTime);
    if (!position) return;
    const angle = Number($('off-nadir').value);
    if (!Number.isFinite(angle) || angle <= 0 || angle >= 90) { $('visual-status').textContent = '离轴半角应大于 0° 且小于 90°。'; return; }
    try {
      const cone = buildOffNadirCone({apex:[position.x, position.y, position.z], halfAngleDeg:angle, segmentCount:48});
      const rim = [];
      for (let i = 0; i < cone.rimPositions.length; i += 3) rim.push(Cesium.Cartesian3.fromArray(cone.rimPositions, i));
      coneEntities.push(viewer.entities.add({polyline:{positions:[...rim,rim[0]], width:2, material:Cesium.Color.DEEPSKYBLUE}}));
      for (let i = 0; i < rim.length; i++) coneEntities.push(viewer.entities.add({polygon:{hierarchy:new Cesium.PolygonHierarchy([position,rim[i],rim[(i+1)%rim.length]]), perPositionHeight:true, material:Cesium.Color.DODGERBLUE.withAlpha(.08)}}));
      $('visual-status').textContent = `已选 ${satellites[selectedIndex].name}。`;
    } catch { $('visual-status').textContent = '当前离轴半角超出地球边缘，请减小角度。'; }
  }

  function renderFrame(index) {
    renderedIndex = index;
    const seconds = Math.min(index * step, duration);
    const instant = new Date(start + seconds * 1000), gmst = gstime(instant);
    for (let i = 0; i < satellites.length; i++) {
      const state = propagate(satellites[i].satrec, instant);
      if (!state?.position) throw new Error(`${satellites[i].name} 在该时刻外推失败。`);
      const position = eciToEcf(state.position, gmst);
      satelliteEntities[i].position = Cesium.Cartesian3.fromElements(position.x * 1000, position.y * 1000, position.z * 1000);
      satelliteEntities[i].point.color = state.velocity?.z >= 0 ? Cesium.Color.RED : Cesium.Color.DODGERBLUE;
    }
    $('visual-progress').value = index;
    $('visual-time').textContent = `北京时间 ${new Date(instant.getTime() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ')}`;
    renderCone();
    renderTerminals();
  }

  function stop() { playing = false; lastTick = undefined; $('visual-play').textContent = '播放'; }
  function tick(now) {
    if (!playing) return;
    if (lastTick !== undefined) elapsed = Math.min(duration, elapsed + (now - lastTick) / 1000 * Number($('visual-speed').value));
    lastTick = now;
    const index = elapsed >= duration ? frameCount - 1 : Math.floor(elapsed / step);
    try { if (index !== renderedIndex) renderFrame(index); } catch (error) { stop(); $('visual-status').textContent = error.message; return; }
    if (elapsed >= duration) stop(); else requestAnimationFrame(tick);
  }

  $('show-globe').onclick = () => {
    try {
      const values = getTimes(), selected = getSatellites();
      if (!selected.length) throw new Error('请先选择卫星。');
      if (!Number.isInteger(values.duration) || values.duration <= 0 || !Number.isSafeInteger(values.step) || values.step < 1) throw new Error('请检查起止时间和采样步长。');
      const next = selected.map(satellite => ({...satellite, satrec:json2satrec(satellite.elements)}));
      stop(); clearCone(); if (trajectory) viewer.entities.remove(trajectory); trajectory = undefined; for (const entity of satelliteEntities) viewer.entities.remove(entity); satelliteEntities.length = 0;
      satellites = next; start = values.start; duration = values.duration; step = values.step; frameCount = Math.ceil(duration / step) + 1; selectedIndex = -1; elapsed = 0;
      for (const satellite of satellites) satelliteEntities.push(viewer.entities.add({name:satellite.name,point:{pixelSize:9,color:Cesium.Color.RED,outlineColor:Cesium.Color.WHITE,outlineWidth:1},label:{text:satellite.name,font:'14px sans-serif',fillColor:Cesium.Color.WHITE,outlineColor:Cesium.Color.BLACK,outlineWidth:3,style:Cesium.LabelStyle.FILL_AND_OUTLINE,pixelOffset:new Cesium.Cartesian2(12,-8),horizontalOrigin:Cesium.HorizontalOrigin.LEFT}}));
      $('visual-progress').max = frameCount - 1; $('visual-progress').disabled = false; $('visual-play').disabled = false;
      $('visual-status').textContent = `已显示 ${satellites.length} 颗卫星，点击卫星查看可视范围。`;
      renderFrame(0); viewer.resize();
    } catch (error) { $('visual-status').textContent = error.message; }
  };
  $('visual-play').onclick = () => { if (playing) return stop(); if (elapsed >= duration) elapsed = 0; playing = true; $('visual-play').textContent = '暂停'; requestAnimationFrame(tick); };
  $('visual-progress').oninput = event => { stop(); const index = Number(event.target.value); elapsed = Math.min(index * step,duration); try { renderFrame(index); } catch (error) { $('visual-status').textContent = error.message; } };
  $('show-coverage').onchange = renderCone;
  $('show-trajectory').onchange = () => { try { renderTrajectory(); } catch (error) { $('visual-status').textContent = error.message; } };
  $('off-nadir').onchange = () => { renderCone(); renderTerminals(); };
  viewer.screenSpaceEventHandler.setInputAction(event => {
    const picked = viewer.scene.pick(event.position);
    const index = satelliteEntities.indexOf(picked?.id);
    if (index >= 0) { selectedIndex = index; renderCone(); try { renderTrajectory(); } catch (error) { $('visual-status').textContent = error.message; } }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}
