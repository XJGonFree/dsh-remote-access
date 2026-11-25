/**
 * Dependency-free QR Code encoder (byte mode, error-correction level M,
 * versions 1–12) that renders a standalone SVG string.
 *
 * Why hand-rolled: the browser half of a dsh client plugin may only
 * `require('react')`, so a QR library cannot ship with this plugin, and loading
 * one from a CDN would leak the pairing URL to a third party. The host half is
 * the only place that can build the matrix, so it lives here and the panel just
 * renders the SVG it is handed.
 *
 * Verified module-for-module against the `qrcode` package and decoded back with
 * `jsqr` (see `_qrtest/verify.mjs`); a QR that renders but does not scan would
 * be worse than no QR at all.
 */

/* ------------------------------------------------------------------ *
 * Galois field GF(256) and Reed–Solomon
 * ------------------------------------------------------------------ */

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)

{
  let value = 1
  for (let index = 0; index < 255; index += 1) {
    EXP[index] = value
    LOG[value] = index
    value <<= 1
    if ((value & 0x100) !== 0) value ^= 0x11d
  }
  for (let index = 255; index < 512; index += 1) EXP[index] = EXP[index - 255]
}

function gfMultiply(left, right) {
  if (left === 0 || right === 0) return 0
  return EXP[LOG[left] + LOG[right]]
}

/** Generator polynomial ∏(x − α^i) for i in [0, degree). */
function rsGenerator(degree) {
  let polynomial = Uint8Array.of(1)
  for (let index = 0; index < degree; index += 1) {
    const next = new Uint8Array(polynomial.length + 1)
    for (let position = 0; position < polynomial.length; position += 1) {
      next[position] ^= polynomial[position]
      next[position + 1] ^= gfMultiply(polynomial[position], EXP[index])
    }
    polynomial = next
  }
  return polynomial
}

function rsRemainder(data, degree) {
  const generator = rsGenerator(degree)
  const remainder = new Uint8Array(degree)
  for (const byte of data) {
    const factor = byte ^ remainder[0]
    remainder.copyWithin(0, 1)
    remainder[degree - 1] = 0
    if (factor !== 0) {
      for (let index = 0; index < degree; index += 1) {
        remainder[index] ^= gfMultiply(generator[index + 1], factor)
      }
    }
  }
  return remainder
}

/* ------------------------------------------------------------------ *
 * Version tables (error-correction level M)
 * ------------------------------------------------------------------ */

/**
 * [ecCodewordsPerBlock, group1Blocks, group1DataCodewords,
 *  group2Blocks, group2DataCodewords]
 */
const BLOCKS_M = [
  undefined,
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
  [30, 1, 50, 4, 51],
  [22, 6, 36, 2, 37],
]

const ALIGNMENT = [
  undefined,
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
]

const MAX_VERSION = 12
/** Error-correction level M is `00` in the format-info field. */
const EC_BITS_M = 0b00

function dataCodewords(version) {
  const [, group1Blocks, group1Words, group2Blocks, group2Words] = BLOCKS_M[version]
  return group1Blocks * group1Words + group2Blocks * group2Words
}

function totalCodewords(version) {
  const [ecPerBlock, group1Blocks, group1Words, group2Blocks, group2Words] = BLOCKS_M[version]
  const blocks = group1Blocks + group2Blocks
  return group1Blocks * group1Words + group2Blocks * group2Words + blocks * ecPerBlock
}

function sizeOf(version) {
  return 17 + 4 * version
}

/* ------------------------------------------------------------------ *
 * Bit stream
 * ------------------------------------------------------------------ */

function buildCodewords(text, version) {
  const bytes = Buffer.from(text, 'utf8')
  const capacity = dataCodewords(version)
  const bits = []
  const push = (value, length) => {
    for (let index = length - 1; index >= 0; index -= 1) bits.push((value >> index) & 1)
  }

  push(0b0100, 4)
  if (version < 10) push(bytes.length, 8)
  else push(bytes.length, 16)
  for (const byte of bytes) push(byte, 8)

  const capacityBits = capacity * 8
  const terminator = Math.min(4, capacityBits - bits.length)
  push(0, terminator)
  while (bits.length % 8 !== 0) bits.push(0)

  const codewords = []
  for (let index = 0; index < bits.length; index += 8) {
    let value = 0
    for (let offset = 0; offset < 8; offset += 1) value = (value << 1) | bits[index + offset]
    codewords.push(value)
  }
  const pad = [0xec, 0x11]
  let padIndex = 0
  while (codewords.length < capacity) {
    codewords.push(pad[padIndex % 2])
    padIndex += 1
  }
  return Uint8Array.from(codewords)
}

/** Split into blocks, add ECC per block, then interleave both halves. */
function interleave(codewords, version) {
  const [ecPerBlock, group1Blocks, group1Words, group2Blocks, group2Words] = BLOCKS_M[version]
  const blocks = []
  let offset = 0
  for (let index = 0; index < group1Blocks; index += 1) {
    blocks.push(codewords.subarray(offset, offset + group1Words))
    offset += group1Words
  }
  for (let index = 0; index < group2Blocks; index += 1) {
    blocks.push(codewords.subarray(offset, offset + group2Words))
    offset += group2Words
  }

  const eccs = blocks.map(block => rsRemainder(block, ecPerBlock))
  const longest = Math.max(...blocks.map(block => block.length))
  const out = []
  for (let index = 0; index < longest; index += 1) {
    for (const block of blocks) {
      if (index < block.length) out.push(block[index])
    }
  }
  for (let index = 0; index < ecPerBlock; index += 1) {
    for (const ecc of eccs) out.push(ecc[index])
  }
  return Uint8Array.from(out)
}

/* ------------------------------------------------------------------ *
 * Matrix construction
 * ------------------------------------------------------------------ */

function createMatrix(size) {
  const modules = Array.from({ length: size }, () => new Array(size).fill(false))
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false))
  return { modules, reserved, size }
}

function placeFinder(matrix, row, column) {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const y = row + dy
      const x = column + dx
      if (y < 0 || x < 0 || y >= matrix.size || x >= matrix.size) continue
      const inRing = (dy >= 0 && dy <= 6 && (dx === 0 || dx === 6))
        || (dx >= 0 && dx <= 6 && (dy === 0 || dy === 6))
      const inCore = dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4
      matrix.modules[y][x] = inRing || inCore
      matrix.reserved[y][x] = true
    }
  }
}

function placeAlignment(matrix, version) {
  const centers = ALIGNMENT[version]
  for (const row of centers) {
    for (const column of centers) {
      // Skip the three corners occupied by finder patterns.
      const nearFinder = (row <= 8 && column <= 8)
        || (row <= 8 && column >= matrix.size - 9)
        || (row >= matrix.size - 9 && column <= 8)
      if (nearFinder) continue
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const ring = Math.max(Math.abs(dy), Math.abs(dx))
          matrix.modules[row + dy][column + dx] = ring !== 1
          matrix.reserved[row + dy][column + dx] = true
        }
      }
    }
  }
}

function placeTiming(matrix) {
  for (let index = 8; index < matrix.size - 8; index += 1) {
    const dark = index % 2 === 0
    matrix.modules[6][index] = dark
    matrix.reserved[6][index] = true
    matrix.modules[index][6] = dark
    matrix.reserved[index][6] = true
  }
}

function reserveFormatAreas(matrix) {
  for (let index = 0; index < 9; index += 1) {
    if (!matrix.reserved[8][index]) { matrix.reserved[8][index] = true }
    if (!matrix.reserved[index][8]) { matrix.reserved[index][8] = true }
  }
  for (let index = 0; index < 8; index += 1) {
    matrix.reserved[8][matrix.size - 1 - index] = true
    matrix.reserved[matrix.size - 1 - index][8] = true
  }
  // The always-dark module.
  matrix.modules[matrix.size - 8][8] = true
  matrix.reserved[matrix.size - 8][8] = true
}

function placeVersionInfo(matrix, version) {
  if (version < 7) return
  // 18-bit BCH(18,6) version block, poly 0x1f25.
  let remainder = version
  for (let index = 0; index < 12; index += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25)
  }
  const bits = (version << 12) | remainder
  for (let index = 0; index < 18; index += 1) {
    const bit = ((bits >>> index) & 1) === 1
    const row = Math.floor(index / 3)
    const column = index % 3
    matrix.modules[matrix.size - 11 + column][row] = bit
    matrix.reserved[matrix.size - 11 + column][row] = true
    matrix.modules[row][matrix.size - 11 + column] = bit
    matrix.reserved[row][matrix.size - 11 + column] = true
  }
}

function placeFormatInfo(matrix, mask) {
  const data = (EC_BITS_M << 3) | mask
  let remainder = data
  for (let index = 0; index < 10; index += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537)
  }
  const bits = ((data << 10) | remainder) ^ 0x5412
  const bitAt = index => ((bits >>> index) & 1) === 1

  // First copy: bits 0–5 down column 8, then the two diagonal cells, then
  // bits 9–14 leftwards along row 8. Note (row, column) vs (column, row) here —
  // this block is sympathetically easy to transpose, and a transposed first copy
  // still scans because the second copy is redundant.
  for (let index = 0; index < 6; index += 1) matrix.modules[index][8] = bitAt(index)
  matrix.modules[7][8] = bitAt(6)
  matrix.modules[8][8] = bitAt(7)
  matrix.modules[8][7] = bitAt(8)
  for (let index = 9; index < 15; index += 1) matrix.modules[8][14 - index] = bitAt(index)

  // Second copy: bits 0–7 right-to-left along row 8, bits 8–14 down column 8.
  for (let index = 0; index < 8; index += 1) matrix.modules[8][matrix.size - 1 - index] = bitAt(index)
  for (let index = 8; index < 15; index += 1) matrix.modules[matrix.size - 15 + index][8] = bitAt(index)
  // The always-dark module sits at row 4·version+9 (= size−8), column 8.
  matrix.modules[matrix.size - 8][8] = true
}

function placeData(matrix, codewords) {
  let bitIndex = 0
  const totalBits = codewords.length * 8
  const readBit = () => {
    if (bitIndex >= totalBits) return false
    const byte = codewords[bitIndex >>> 3]
    const bit = ((byte >>> (7 - (bitIndex & 7))) & 1) === 1
    bitIndex += 1
    return bit
  }

  let upward = true
  for (let right = matrix.size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern: it is never part of the data area.
    if (right === 6) right = 5
    for (let step = 0; step < matrix.size; step += 1) {
      const row = upward ? matrix.size - 1 - step : step
      for (let offset = 0; offset < 2; offset += 1) {
        const column = right - offset
        if (matrix.reserved[row][column]) continue
        matrix.modules[row][column] = readBit()
      }
    }
    upward = !upward
  }
}

const MASKS = [
  (row, column) => (row + column) % 2 === 0,
  (row) => row % 2 === 0,
  (_row, column) => column % 3 === 0,
  (row, column) => (row + column) % 3 === 0,
  (row, column) => (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
  (row, column) => ((row * column) % 2) + ((row * column) % 3) === 0,
  (row, column) => (((row * column) % 2) + ((row * column) % 3)) % 2 === 0,
  (row, column) => (((row + column) % 2) + ((row * column) % 3)) % 2 === 0,
]

function applyMask(matrix, mask) {
  const test = MASKS[mask]
  for (let row = 0; row < matrix.size; row += 1) {
    for (let column = 0; column < matrix.size; column += 1) {
      if (matrix.reserved[row][column]) continue
      if (test(row, column)) matrix.modules[row][column] = !matrix.modules[row][column]
    }
  }
}

/**
 * Standard penalty scoring (rules N1–N4); lower is better.
 *
 * Implemented literally against the specification's run-length formulation
 * rather than with shortcuts: mask choice changes roughly half the modules, so a
 * scoring difference would silently produce a different (still scannable, but
 * subtly worse-contrast) code than every other encoder.
 */
function penalty(matrix) {
  const { modules, size } = matrix
  const N1 = 3
  const N2 = 3
  const N3 = 40
  const N4 = 10
  let score = 0

  // Rule 3 tracks the 1:1:3:1:1 finder-like sequence with its quiet zone.
  const countPatterns = (history) => {
    const n = history[1]
    const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n
    return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0)
      + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0)
  }
  const addHistory = (length, history) => {
    const run = history[0] === 0 ? length + size : length
    history.pop()
    history.unshift(run)
  }
  const terminateAndCount = (color, length, history) => {
    let run = length
    if (color) {
      addHistory(run, history)
      run = 0
    }
    run += size
    addHistory(run, history)
    return countPatterns(history)
  }

  const scoreLine = (read) => {
    let total = 0
    let color = false
    let run = 0
    const history = [0, 0, 0, 0, 0, 0, 0]
    for (let index = 0; index < size; index += 1) {
      const value = read(index)
      if (value === color) {
        run += 1
        if (run === 5) total += N1
        else if (run > 5) total += 1
      } else {
        addHistory(run, history)
        if (!color) total += countPatterns(history) * N3
        color = value
        run = 1
      }
    }
    total += terminateAndCount(color, run, history) * N3
    return total
  }

  for (let row = 0; row < size; row += 1) score += scoreLine(column => modules[row][column])
  for (let column = 0; column < size; column += 1) score += scoreLine(row => modules[row][column])

  // Rule 2: 2×2 blocks of one colour.
  for (let row = 0; row < size - 1; row += 1) {
    for (let column = 0; column < size - 1; column += 1) {
      const value = modules[row][column]
      if (value === modules[row][column + 1]
        && value === modules[row + 1][column]
        && value === modules[row + 1][column + 1]) score += N2
    }
  }

  // Rule 4: deviation of the dark-module proportion from 50%.
  let dark = 0
  for (const line of modules) for (const value of line) if (value) dark += 1
  const total = size * size
  const deviation = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
  score += Math.max(0, deviation) * N4
  return score
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

function buildMatrix(text) {
  if (typeof text !== 'string' || text === '') throw new Error('qr: text is required')
  let version = 1
  const byteLength = Buffer.byteLength(text, 'utf8')
  // 4 mode bits + 8/16 length bits + data bits must fit the data codewords.
  while (version <= MAX_VERSION) {
    const capacityBits = dataCodewords(version) * 8
    const lengthBits = version < 10 ? 8 : 16
    if (4 + lengthBits + byteLength * 8 <= capacityBits) break
    version += 1
  }
  if (version > MAX_VERSION) {
    throw new Error(`qr: text is too long (${byteLength} bytes) for version ${MAX_VERSION}-M`)
  }

  const codewords = interleave(buildCodewords(text, version), version)
  const size = sizeOf(version)

  // Build once unmasked, then score each mask on a copy.
  let best
  let bestScore = Number.POSITIVE_INFINITY
  let bestMask = 0
  for (let mask = 0; mask < 8; mask += 1) {
    const matrix = createMatrix(size)
    placeFinder(matrix, 0, 0)
    placeFinder(matrix, 0, size - 7)
    placeFinder(matrix, size - 7, 0)
    placeAlignment(matrix, version)
    placeTiming(matrix)
    placeVersionInfo(matrix, version)
    reserveFormatAreas(matrix)
    placeData(matrix, codewords)
    placeFormatInfo(matrix, mask)
    applyMask(matrix, mask)
    const score = penalty(matrix)
    if (score < bestScore) {
      bestScore = score
      best = matrix
      bestMask = mask
    }
  }
  return { modules: best.modules, size, version, mask: bestMask }
}

/**
 * `qrSvg(text)` → a standalone SVG string sized for on-screen scanning.
 * Dark modules become one path so the markup stays small.
 */
export function qrSvg(text, options = {}) {
  const { modules, size } = buildMatrix(text)
  const quiet = 4
  const extent = size + quiet * 2
  const parts = []
  for (let row = 0; row < size; row += 1) {
    let column = 0
    while (column < size) {
      if (!modules[row][column]) { column += 1; continue }
      let run = 1
      while (column + run < size && modules[row][column + run]) run += 1
      parts.push(`M${column + quiet} ${row + quiet}h${run}v1h-${run}z`)
      column += run
    }
  }
  const pixel = Number(options.pixelSize) > 0 ? Math.round(Number(options.pixelSize)) : 0
  const dimension = pixel > 0 ? ` width="${pixel}" height="${pixel}"` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${extent} ${extent}"${dimension} `
    + 'shape-rendering="crispEdges" role="img" aria-label="pairing QR code">'
    + `<rect width="${extent}" height="${extent}" fill="#ffffff"/>`
    + `<path d="${parts.join('')}" fill="#000000"/>`
    + '</svg>'
}

export default qrSvg
