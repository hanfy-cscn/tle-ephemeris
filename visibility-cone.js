const WGS84_EQUATORIAL_RADIUS_METERS = 6_378_137;
const WGS84_POLAR_RADIUS_METERS = 6_356_752.314245;
const MIN_HALF_ANGLE_RAD = 0.001;

function finiteVector(vector, name) {
  if (!vector || vector.length !== 3 || !Array.from(vector).every(Number.isFinite)) {
    throw new TypeError(`${name} must contain three finite coordinates`);
  }
  return [Number(vector[0]), Number(vector[1]), Number(vector[2])];
}

function subtract(first, second) {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

function dot(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function cross(first, second) {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

function normalize(vector, name) {
  const length = Math.hypot(...vector);
  if (!Number.isFinite(length) || length <= Number.EPSILON) {
    throw new RangeError(`${name} must have non-zero length`);
  }
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function coneRay(axis, basisU, basisV, halfAngleRad, azimuthRad) {
  const axialWeight = Math.cos(halfAngleRad);
  const radialWeight = Math.sin(halfAngleRad);
  return normalize([
    axis[0] * axialWeight + (basisU[0] * Math.cos(azimuthRad) + basisV[0] * Math.sin(azimuthRad)) * radialWeight,
    axis[1] * axialWeight + (basisU[1] * Math.cos(azimuthRad) + basisV[1] * Math.sin(azimuthRad)) * radialWeight,
    axis[2] * axialWeight + (basisU[2] * Math.cos(azimuthRad) + basisV[2] * Math.sin(azimuthRad)) * radialWeight,
  ], "cone ray");
}

function rayEllipsoidIntersection(origin, direction) {
  const equatorialRadiusSquared = WGS84_EQUATORIAL_RADIUS_METERS ** 2;
  const polarRadiusSquared = WGS84_POLAR_RADIUS_METERS ** 2;
  const a = (direction[0] ** 2 + direction[1] ** 2) / equatorialRadiusSquared
    + direction[2] ** 2 / polarRadiusSquared;
  const b = 2 * ((origin[0] * direction[0] + origin[1] * direction[1]) / equatorialRadiusSquared
    + origin[2] * direction[2] / polarRadiusSquared);
  const c = (origin[0] ** 2 + origin[1] ** 2) / equatorialRadiusSquared
    + origin[2] ** 2 / polarRadiusSquared - 1;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return undefined;
  const root = Math.sqrt(discriminant);
  const distances = [(-b - root) / (2 * a), (-b + root) / (2 * a)].filter((distance) => distance > 0);
  if (!distances.length) return undefined;
  const distance = Math.min(...distances);
  return [
    origin[0] + distance * direction[0],
    origin[1] + distance * direction[1],
    origin[2] + distance * direction[2],
  ];
}

export function buildSignalBeamCone({ apex, center, boundaryPositions, segmentCount = 28, edgeMargin = 1.03 }) {
  const coneApex = finiteVector(apex, "apex");
  const coneCenter = finiteVector(center, "center");
  if (!ArrayBuffer.isView(boundaryPositions) || boundaryPositions.length < 9 || boundaryPositions.length % 3 !== 0) {
    throw new RangeError("boundaryPositions must contain at least three Cartesian positions");
  }
  if (!Number.isInteger(segmentCount) || segmentCount < 12) {
    throw new RangeError("segmentCount must be an integer of at least 12");
  }
  if (!Number.isFinite(edgeMargin) || edgeMargin < 1) {
    throw new RangeError("edgeMargin must be a finite number no smaller than one");
  }

  const axis = normalize(subtract(coneCenter, coneApex), "beam axis");
  let maxBoundaryAngle = 0;
  for (let offset = 0; offset < boundaryPositions.length; offset += 3) {
    const boundaryPoint = finiteVector(boundaryPositions.subarray(offset, offset + 3), "boundary position");
    const direction = normalize(subtract(boundaryPoint, coneApex), "boundary direction");
    maxBoundaryAngle = Math.max(maxBoundaryAngle, Math.acos(Math.max(-1, Math.min(1, dot(axis, direction)))));
  }
  const halfAngleRad = Math.min(Math.PI / 2 - MIN_HALF_ANGLE_RAD, Math.max(MIN_HALF_ANGLE_RAD, maxBoundaryAngle * edgeMargin));
  const reference = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const basisU = normalize(cross(reference, axis), "cone transverse basis");
  const basisV = cross(axis, basisU);
  const rimPositions = new Float64Array(segmentCount * 3);
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const direction = coneRay(axis, basisU, basisV, halfAngleRad, 2 * Math.PI * segment / segmentCount);
    const intersection = rayEllipsoidIntersection(coneApex, direction);
    if (!intersection) return undefined;
    rimPositions.set(intersection, 3 * segment);
  }

  return { apex: coneApex, halfAngleRad, rimPositions };
}

export function buildOffNadirCone({ apex, halfAngleDeg, segmentCount = 36 }) {
  const coneApex = finiteVector(apex, "apex");
  if (!Number.isFinite(halfAngleDeg) || halfAngleDeg <= 0 || halfAngleDeg >= 90) {
    throw new RangeError("halfAngleDeg must be between 0 and 90 degrees");
  }
  if (!Number.isInteger(segmentCount) || segmentCount < 12) {
    throw new RangeError("segmentCount must be an integer of at least 12");
  }
  const axis = normalize(coneApex.map((value) => -value), "nadir axis");
  const reference = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const basisU = normalize(cross(reference, axis), "cone transverse basis");
  const basisV = cross(axis, basisU);
  const halfAngleRad = halfAngleDeg * Math.PI / 180;
  const rimPositions = new Float64Array(segmentCount * 3);
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const direction = coneRay(axis, basisU, basisV, halfAngleRad, 2 * Math.PI * segment / segmentCount);
    const intersection = rayEllipsoidIntersection(coneApex, direction);
    if (!intersection) throw new RangeError("visibility cone does not intersect the WGS84 ellipsoid");
    rimPositions.set(intersection, segment * 3);
  }
  return { apex: coneApex, halfAngleRad, rimPositions };
}
