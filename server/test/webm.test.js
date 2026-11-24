// El arreglo de los .webm grabados en el teléfono (web/js/webm.js): cierra el salto de tiempos y corrige la duración.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixWebm } from '../../web/js/webm.js';

// Elemento EBML con tamaño de 1 byte (alcanza para el archivo de prueba).
const el = (id, ...data) => {
  const body = data.flat();
  assert.ok(body.length < 127);
  return [...id, 0x80 | body.length, ...body];
};
const uint = (v, n) => Array.from({ length: n }, (_, k) => (v / 256 ** (n - 1 - k)) & 0xff);
const f32 = (v) => [...new Uint8Array(new Float32Array([v]).buffer)].reverse();
const block = (rel) => el([0xa3], 0x81, ...uint(rel, 2), 0x80, 0xfb, 0xff, 0xfe);

// Como el audio del teléfono: un cuadro en el segundo 0 y el resto desde el segundo 176,591.
function brokenWebm() {
  const info = el([0x15, 0x49, 0xa9, 0x66], el([0x2a, 0xd7, 0xb1], uint(1e6, 3)), el([0x44, 0x89], f32(179051)));
  const c1 = el([0x1f, 0x43, 0xb6, 0x75], el([0xe7], 0), block(0));
  const c2 = el([0x1f, 0x43, 0xb6, 0x75], el([0xe7], uint(176591, 3)), block(0), block(2000));
  const cues = el([0x1c, 0x53, 0xbb, 0x6b], el([0xbb], el([0xb3], uint(176591, 3))));
  const segment = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...info, ...c1, ...c2, ...cues];
  return new Uint8Array([...el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], [0x77, 0x65, 0x62, 0x6d])), ...segment]);
}
const at = (b, seq) => Buffer.from(b).indexOf(Buffer.from(seq));

test('webm: cierra el salto de tiempos y corrige la duración', () => {
  const input = brokenWebm();
  const fixed = fixWebm(input);
  assert.equal(fixed.length, input.length, 'mismo tamaño');
  const dur = at(fixed, [0x44, 0x89, 0x84]) + 3;
  assert.equal(new DataView(fixed.buffer, dur, 4).getFloat32(0), 2040, '20 ms + 2000 ms del último bloque + 20 ms');
  const tc = [...Buffer.from(fixed).entries()].filter(([i, x]) => x === 0xe7 && fixed[i + 1] === 0x83).map(([i]) => i)[0];
  assert.deepEqual([...fixed.subarray(tc + 2, tc + 5)], uint(20, 3), 'el segundo cluster empieza un cuadro después del primero');
  const cue = at(fixed, [0xb3, 0x83]) + 2;
  assert.deepEqual([...fixed.subarray(cue, cue + 3)], uint(20, 3), 'las cues siguen al cluster');
  assert.equal(input[dur + 1], f32(179051)[1], 'no toca el original');
});

test('webm: lo que está bien o no se entiende queda igual', () => {
  const fixed = fixWebm(brokenWebm());
  assert.equal(fixWebm(fixed), fixed, 'ya arreglado: sin cambios');
  const junk = new Uint8Array([1, 2, 3, 4, 5]);
  assert.equal(fixWebm(junk), junk);
  const cut = brokenWebm().subarray(0, 60);
  assert.equal(fixWebm(cut), cut, 'archivo cortado');
});
