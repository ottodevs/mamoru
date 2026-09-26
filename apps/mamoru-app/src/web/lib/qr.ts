// Minimal QR encoder: byte mode, error correction M, versions 1 to 6 (up to 106 bytes).
// Enough for a Base address. Follows ISO/IEC 18004 as laid out in Nayuki's reference implementation.

const RAW = [0, 26, 44, 70, 100, 134, 172]
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16]
const BLOCKS = [0, 1, 1, 1, 2, 2, 4]
const ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]] as number[][]

function gfMul(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

function rsDivisor(degree: number): number[] {
  const r = new Array<number>(degree).fill(0)
  r[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j] as number, root)
      if (j + 1 < r.length) r[j] = (r[j] as number) ^ (r[j + 1] as number)
    }
    root = gfMul(root, 0x02)
  }
  return r
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const r = new Array<number>(divisor.length).fill(0)
  for (const b of data) {
    const factor = b ^ (r.shift() as number)
    r.push(0)
    divisor.forEach((d, i) => {
      r[i] = (r[i] as number) ^ gfMul(d, factor)
    })
  }
  return r
}

export type QrMatrix = boolean[][]

export function encodeQr(text: string): QrMatrix {
  const bytes = Array.from(new TextEncoder().encode(text))
  let version = 1
  for (; version <= 6; version++) {
    const dataCap = RAW[version]! - ECC_PER_BLOCK[version]! * BLOCKS[version]!
    if (4 + 8 + bytes.length * 8 <= dataCap * 8) break
  }
  if (version > 6) throw new Error('QR text too long')
  const eccLen = ECC_PER_BLOCK[version]!
  const nBlocks = BLOCKS[version]!
  const raw = RAW[version]!
  const dataCap = raw - eccLen * nBlocks

  // Bit stream: mode 0100, 8-bit length, bytes, terminator, byte pad, 0xEC/0x11 pad.
  const bits: number[] = []
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1)
  }
  put(4, 4)
  put(bytes.length, 8)
  for (const b of bytes) put(b, 8)
  put(0, Math.min(4, dataCap * 8 - bits.length))
  while (bits.length % 8) bits.push(0)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))
  for (let p = 0xec; data.length < dataCap; p ^= 0xec ^ 0x11) data.push(p)

  // Error correction per block, then interleave (every block has the same length for these versions).
  const blockLen = dataCap / nBlocks
  const div = rsDivisor(eccLen)
  const blocks = Array.from({ length: nBlocks }, (_, i) => data.slice(i * blockLen, (i + 1) * blockLen))
  const eccs = blocks.map((b) => rsRemainder(b, div))
  const codewords: number[] = []
  for (let i = 0; i < blockLen; i++) for (const b of blocks) codewords.push(b[i]!)
  for (let i = 0; i < eccLen; i++) for (const e of eccs) codewords.push(e[i]!)

  const size = version * 4 + 17
  const mod: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const fn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const setF = (x: number, y: number, dark: boolean) => {
    mod[y]![x] = dark
    fn[y]![x] = true
  }

  for (let i = 0; i < size; i++) {
    setF(6, i, i % 2 === 0)
    setF(i, 6, i % 2 === 0)
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= size || y >= size) continue
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        setF(x, y, d !== 2 && d !== 4)
      }
  }
  finder(3, 3)
  finder(size - 4, 3)
  finder(3, size - 4)
  const al = ALIGN[version]!
  for (let i = 0; i < al.length; i++)
    for (let j = 0; j < al.length; j++) {
      const last = al.length - 1
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) setF(al[i]! + dx, al[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }

  const drawFormat = (mask: number) => {
    const d = mask // error correction M has format bits 00
    let rem = d
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const f = ((d << 10) | rem) ^ 0x5412
    const bit = (i: number) => ((f >>> i) & 1) !== 0
    for (let i = 0; i <= 5; i++) setF(8, i, bit(i))
    setF(8, 7, bit(6))
    setF(8, 8, bit(7))
    setF(7, 8, bit(8))
    for (let i = 9; i < 15; i++) setF(14 - i, 8, bit(i))
    for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i++) setF(8, size - 15 + i, bit(i))
    setF(8, size - 8, true)
  }
  drawFormat(0)

  let k = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let v = 0; v < size; v++)
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const up = ((right + 1) & 2) === 0
        const y = up ? size - 1 - v : v
        if (!fn[y]![x] && k < codewords.length * 8) {
          mod[y]![x] = ((codewords[k >>> 3]! >>> (7 - (k & 7))) & 1) !== 0
          k++
        }
      }
  }

  const MASKS: ((x: number, y: number) => boolean)[] = [
    (x, y) => (x + y) % 2 === 0,
    (_x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ]
  const applyMask = (m: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y]![x] && MASKS[m]!(x, y)) mod[y]![x] = !mod[y]![x]
  }
  // Penalty rules 1, 2 and 4: runs, 2x2 blocks, dark balance.
  const penalty = () => {
    let p = 0
    let dark = 0
    for (let a = 0; a < size; a++) {
      let runR = 1
      let runC = 1
      for (let b = 0; b < size; b++) {
        if (mod[a]![b]) dark++
        if (b > 0) {
          runR = mod[a]![b] === mod[a]![b - 1] ? runR + 1 : 1
          runC = mod[b]![a] === mod[b - 1]![a] ? runC + 1 : 1
          if (runR === 5) p += 3
          else if (runR > 5) p++
          if (runC === 5) p += 3
          else if (runC > 5) p++
        }
        if (a > 0 && b > 0) {
          const c = mod[a]![b]
          if (c === mod[a - 1]![b] && c === mod[a]![b - 1] && c === mod[a - 1]![b - 1]) p += 3
        }
      }
    }
    return p + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10
  }
  let best = 0
  let bestP = Infinity
  for (let m = 0; m < 8; m++) {
    applyMask(m)
    drawFormat(m)
    const p = penalty()
    if (p < bestP) {
      bestP = p
      best = m
    }
    applyMask(m)
  }
  applyMask(best)
  drawFormat(best)
  return mod
}

/** SVG path of the dark modules, one unit per module. */
export function qrPath(m: QrMatrix): string {
  let d = ''
  m.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) d += `M${x} ${y}h1v1h-1z`
    }),
  )
  return d
}
