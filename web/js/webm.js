// Arreglo para los .webm que graba el navegador del teléfono: a veces el primer pedazo queda en el segundo 0 y
// el resto en el segundo 176 (por ejemplo), así un audio de 2 s figura como 2:59. Acá se cierran esos saltos
// (tiempos de cada Cluster y de las Cues) y se corrige la duración. Sin DOM, para poder probarlo en Node.
// Si algo del archivo no se entiende, se devuelve tal cual.

const ID = {
  segment: 0x18538067, info: 0x1549a966, scale: 0x2ad7b1, duration: 0x4489, cluster: 0x1f43b675, timecode: 0xe7,
  simpleBlock: 0xa3, blockGroup: 0xa0, block: 0xa1, cues: 0x1c53bb6b, cuePoint: 0xbb, cueTime: 0xb3,
};
const GAP = 1000; // ms: en una grabación seguida no hay huecos; uno de más de 1 s es el error
const FRAME = 20; // ms: un cuadro de Opus

function vint(b, pos, keepMarker) {
  const len = Math.clz32(b[pos]) - 23;
  if (len < 1 || len > 8 || pos + len > b.length) throw new Error('vint');
  const mask = 0xff >> len;
  let value = keepMarker ? b[pos] : b[pos] & mask;
  let ones = (b[pos] & mask) === mask;
  for (let k = 1; k < len; k++) (value = value * 256 + b[pos + k]), (ones &&= b[pos + k] === 0xff);
  return { value, len, unknown: !keepMarker && ones };
}

function* children(b, start, end) {
  for (let pos = start; pos < end; ) {
    const id = vint(b, pos, true);
    const size = vint(b, pos + id.len, false);
    const data = pos + id.len + size.len;
    if (size.unknown && id.value !== ID.segment) throw new Error('tamaño desconocido');
    const elEnd = size.unknown ? end : data + size.value;
    if (elEnd > end) throw new Error('fuera de rango');
    yield { id: id.value, data, size: elEnd - data, end: elEnd };
    pos = elEnd;
  }
}

const readUint = (b, el) => b.subarray(el.data, el.end).reduce((v, x) => v * 256 + x, 0);
function writeUint(b, el, v) {
  for (let k = el.end - 1; k >= el.data; k--, v = Math.floor(v / 256)) b[k] = v & 0xff;
}

// Tiempo relativo (int16) de un SimpleBlock o Block.
function blockTime(b, el) {
  const track = vint(b, el.data, false);
  return new DataView(b.buffer, b.byteOffset + el.data + track.len, 2).getInt16(0);
}

export function fixWebm(input) {
  try {
    const b = input.slice();
    const segment = [...children(b, 0, b.length)].find((el) => el.id === ID.segment);
    if (!segment) return input;
    let duration = null;
    let scale = 1e6;
    const clusters = [];
    const cueTimes = [];
    for (const el of children(b, segment.data, segment.end)) {
      if (el.id === ID.info) {
        for (const c of children(b, el.data, el.end)) {
          if (c.id === ID.duration) duration = c;
          if (c.id === ID.scale) scale = readUint(b, c);
        }
      } else if (el.id === ID.cluster) {
        let tc = null;
        let last = 0;
        for (const c of children(b, el.data, el.end)) {
          if (c.id === ID.timecode) tc = c;
          if (c.id === ID.simpleBlock) last = Math.max(last, blockTime(b, c));
          if (c.id === ID.blockGroup) for (const g of children(b, c.data, c.end)) if (g.id === ID.block) last = Math.max(last, blockTime(b, g));
        }
        if (!tc) return input;
        clusters.push({ tc, time: readUint(b, tc), last });
      } else if (el.id === ID.cues) {
        for (const p of children(b, el.data, el.end)) {
          if (p.id === ID.cuePoint) for (const c of children(b, p.data, p.end)) if (c.id === ID.cueTime) cueTimes.push(c);
        }
      }
    }
    if (scale !== 1e6 || !clusters.length) return input; // los navegadores usan 1 ms; otra escala, no se toca

    let shift = 0;
    let prevEnd = null;
    const shifts = []; // [tiempo original del cluster, cuánto se le restó]
    for (const c of clusters) {
      let t = c.time - shift;
      if (prevEnd !== null && t - prevEnd > GAP) (shift += t - prevEnd - FRAME), (t = prevEnd + FRAME);
      shifts.push([c.time, shift]);
      writeUint(b, c.tc, t);
      prevEnd = t + c.last;
    }
    if (!shift) return input;
    for (const c of cueTimes) {
      const old = readUint(b, c);
      writeUint(b, c, Math.max(0, old - (shifts.findLast(([t]) => t <= old)?.[1] ?? 0)));
    }
    if (duration && (duration.size === 4 || duration.size === 8)) {
      const view = new DataView(b.buffer, b.byteOffset + duration.data, duration.size);
      duration.size === 4 ? view.setFloat32(0, prevEnd + FRAME) : view.setFloat64(0, prevEnd + FRAME);
    }
    return b;
  } catch {
    return input;
  }
}
