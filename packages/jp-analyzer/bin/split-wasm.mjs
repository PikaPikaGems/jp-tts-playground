// Split a wasm binary into its program and its data segments.
//
// Sudachi's dictionary is compiled into the wasm as an active data segment (116 MB). Browsers keep a copy of every
// data segment inside the compiled module for as long as the instance lives, on top of the copy in linear memory.
// Removing the data section and writing the bytes into memory ourselves after instantiation avoids that second copy.
// This is only safe when nothing runs at instantiation (no start section) and no code uses memory.init
// (no DataCount section), both of which are checked here.

const SECTION = { start: 8, data: 11, dataCount: 12 };

function leb(buf, i) {
  let result = 0, shift = 0, byte;
  do {
    byte = buf[i++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return [result, i];
}

/**
 * @param {Uint8Array} wasm
 * @returns {{ code: Uint8Array, segments: { offset: number, bytes: Uint8Array }[] }}
 */
export function splitWasm(wasm) {
  if (wasm[0] !== 0 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d) throw new Error("not a wasm file");
  const kept = [wasm.subarray(0, 8)];
  const segments = [];
  let i = 8;
  while (i < wasm.length) {
    const id = wasm[i];
    const [size, bodyStart] = leb(wasm, i + 1);
    const end = bodyStart + size;
    if (id === SECTION.start) throw new Error("wasm has a start function; its data cannot be moved out safely");
    if (id === SECTION.dataCount) throw new Error("wasm uses bulk memory (DataCount section); not supported");
    if (id === SECTION.data) {
      let [count, j] = leb(wasm, bodyStart);
      while (count--) {
        let flags, offset, len;
        [flags, j] = leb(wasm, j);
        // flags 0 = active segment in memory 0 with a constant offset expression: i32.const <n> end
        if (flags !== 0 || wasm[j] !== 0x41) throw new Error(`unsupported data segment (flags ${flags})`);
        [offset, j] = leb(wasm, j + 1);
        if (wasm[j] !== 0x0b) throw new Error("unsupported data segment offset expression");
        [len, j] = leb(wasm, j + 1);
        segments.push({ offset, bytes: wasm.subarray(j, j + len) });
        j += len;
      }
    } else {
      kept.push(wasm.subarray(i, end));
    }
    i = end;
  }
  const code = new Uint8Array(kept.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const k of kept) { code.set(k, o); o += k.length; }
  return { code, segments };
}
