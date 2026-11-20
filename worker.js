import { json2satrec } from './vendor/io.js';
import { propagate } from './vendor/propagation.js';
import { gstime } from './vendor/propagation/gstime.js';
import { eciToEcf, eciToGeodetic } from './vendor/transforms.js';

const rotationRate = 7.29211514670698e-5;
let scenario;
const csv = value => `"${String(value).replaceAll('"', '""')}"`;

self.onmessage = event => {
  try {
    if (event.data.type === 'start') {
      const { satellites, start, duration, step } = event.data;
      scenario = { satellites: satellites.map(satellite => ({ ...satellite, satrec: json2satrec(satellite.elements) })), start, duration, step, index: 0, count: Math.ceil(duration / step) + 1 };
    }
    if (!scenario) throw new Error('外推任务尚未初始化。');
    let output = '';
    const last = Math.min(scenario.count, scenario.index + 100);
    for (; scenario.index < last; scenario.index++) {
      const offset = Math.min(scenario.index * scenario.step, scenario.duration);
      const instant = new Date(scenario.start + offset * 1000);
      const timestamp = new Date(instant.getTime() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
      const gmst = gstime(instant), cosine = Math.cos(gmst), sine = Math.sin(gmst);
      for (const satellite of scenario.satellites) {
        const state = propagate(satellite.satrec, instant);
        if (!state?.position || !state.velocity) throw new Error(`${satellite.name} 在 ${timestamp} 外推失败。`);
        const position = eciToEcf(state.position, gmst);
        const geographic = eciToGeodetic(state.position, gmst);
        const velocity = { x: cosine * state.velocity.x + sine * state.velocity.y + rotationRate * position.y, y: -sine * state.velocity.x + cosine * state.velocity.y - rotationRate * position.x, z: state.velocity.z };
        const values = [geographic.longitude * 180 / Math.PI, geographic.latitude * 180 / Math.PI, geographic.height, position.x, position.y, position.z, velocity.x, velocity.y, velocity.z];
        if (!values.every(Number.isFinite)) throw new Error(`${satellite.name} 在 ${timestamp} 的外推结果无效。`);
        output += [timestamp, satellite.name, satellite.id, satellite.designator, ...values.map((value, index) => value.toFixed(index < 6 ? 6 : 9))].map(csv).join(',') + '\r\n';
      }
    }
    self.postMessage({ output, completed: scenario.index, count: scenario.count, done: scenario.index === scenario.count });
  } catch (error) { self.postMessage({ error: error.message }); }
};
