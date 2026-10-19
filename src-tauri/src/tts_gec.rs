// Edge "Read aloud" v2 Sec-MS-GEC token ("<16 hex CS64>-<64 hex tweaked SHA-256>").
// Ported from edge-tts (rany2/edge-tts, LGPLv3) src/edge_tts/drm.py. The Python
// keeps big ints and masks to 32 bits at the end; only additions, xors, shifts and
// multiplications feed those low bits, so u32 wrapping arithmetic gives the same result.
// No clock-skew correction yet: if 403s come back, correct with the server's Date header.

const WIN_EPOCH: u64 = 11_644_473_600;

const SHA256_INITIAL: [u32; 8] =
  [0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19];
const SHA256_STATE: [u32; 8] =
  [0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A, 0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2];
const SHA256_SCHEDULE: [u32; 14] = [
  0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA, 0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6,
  0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33, 0xD258B060, 0x72766564,
];
const K: [u32; 64] = [
  0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
  0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
  0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
  0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
  0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
  0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
  0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
  0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
];
const SHA256_ADJUSTMENT: u32 = 0xC9DC06A7;
const SIGMA0_ADJUSTMENT: u32 = 0x059C0B80;
const SIGMA1_ADJUSTMENT: u32 = 0x000B92C0;

const CS64_COEFFICIENTS: [(u32, u32); 14] = [
  (0xE82E91B1, 0xB32700D0),
  (0x44DE24C6, 0x88DFF51D),
  (0x3BEB65BC, 0x29514038),
  (0xC89C5933, 0xB328CBDF),
  (0x8D1EC211, 0xD405B4D5),
  (0x314EF5D5, 0x26E55F3C),
  (0xE92491B1, 0x607801C6),
  (0xF0A5B9D5, 0x82B2C1FB),
  (0x06064CF3, 0xFA51A3DA),
  (0xDA79FA60, 0x207CC464),
  (0xBED20560, 0x3C3C74F3),
  (0x89F9C9F8, 0xD2D14B61),
  (0x35FA38C6, 0xBB04A2C1),
  (0xCB49E3C6, 0xC5626167),
];
const CS64_FACTOR: u32 = 0x82893933;
const CS64_ADJUSTMENT0: u32 = 0xF2F90B1A;
const CS64_ADJUSTMENT1: u32 = 0x0B1A0000;

fn sigma0(v: u32) -> u32 {
  v.rotate_right(7) ^ v.rotate_right(18) ^ (v >> 3)
}

fn sigma1(v: u32) -> u32 {
  v.rotate_right(17) ^ v.rotate_right(19) ^ (v >> 10)
}

fn expand(w: &mut Vec<u32>, first: usize) {
  for i in first..64 {
    let v = sigma1(w[i - 2]).wrapping_add(w[i - 7]).wrapping_add(sigma0(w[i - 15])).wrapping_add(w[i - 16]);
    w.push(v);
  }
}

// Standard SHA-256 rounds, optionally resuming at round `first` with the tweaked constants.
fn rounds(state: [u32; 8], w: &[u32], first: usize) -> [u32; 8] {
  let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
  for i in first..64 {
    let k = if first == 14 && i == 14 { SHA256_ADJUSTMENT } else { K[i] };
    let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
    let t1 = h.wrapping_add(s1).wrapping_add(g ^ (e & (f ^ g))).wrapping_add(k).wrapping_add(w[i]);
    let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
    let t2 = s0.wrapping_add((a & b) | (c & (a | b)));
    h = g;
    g = f;
    f = e;
    e = d.wrapping_add(t1);
    d = c;
    c = b;
    b = a;
    a = t1.wrapping_add(t2);
  }
  [a, b, c, d, e, f, g, h]
}

fn add_states(x: [u32; 8], y: [u32; 8]) -> [u32; 8] {
  std::array::from_fn(|i| x[i].wrapping_add(y[i]))
}

fn sha256_init(data: &[u8]) -> [u32; 8] {
  let mut w = vec![0u32; 14];
  w.push(u32::from_be_bytes([0, data[0], data[1], data[2]]));
  w.push(u32::from_be_bytes([data[3], data[4], data[5], data[6]]));
  for i in 16..30 {
    let mut v = SHA256_SCHEDULE[i - 16];
    if i - 2 >= 14 {
      let s = sigma1(w[i - 2]);
      v = v.wrapping_add(if i == 16 { s ^ SIGMA1_ADJUSTMENT } else { s });
    }
    if i - 7 >= 14 {
      v = v.wrapping_add(w[i - 7]);
    }
    if i - 15 >= 14 {
      let s = sigma0(w[i - 15]);
      v = v.wrapping_add(if i == 29 { s ^ SIGMA0_ADJUSTMENT } else { s });
    }
    w.push(v);
  }
  let w30 = sigma1(w[28])
    .wrapping_add(w[23])
    .wrapping_add(sigma0(w[15]))
    .wrapping_add(w[14])
    .wrapping_add(SHA256_ADJUSTMENT)
    .wrapping_sub(K[14]);
  w.push(w30);
  expand(&mut w, 31);
  add_states(SHA256_INITIAL, rounds(SHA256_STATE, &w, 14))
}

fn sha256_digest(data: &[u8]) -> [u8; 32] {
  let length = 57 + data.len();
  let mut padded = data[7..].to_vec();
  padded.push(0x80);
  let zeros = (55i64 - length as i64).rem_euclid(64) as usize;
  padded.extend(std::iter::repeat(0).take(zeros));
  padded.extend_from_slice(&((length * 8) as u64).to_be_bytes());
  let mut state = sha256_init(&data[..7]);
  for block in padded.chunks(64) {
    let mut w: Vec<u32> = block.chunks(4).map(|c| u32::from_be_bytes([c[0], c[1], c[2], c[3]])).collect();
    expand(&mut w, 16);
    state = add_states(state, rounds(state, &w, 0));
  }
  let mut out = [0u8; 32];
  for (i, s) in state.iter().enumerate() {
    out[i * 4..i * 4 + 4].copy_from_slice(&s.to_be_bytes());
  }
  out
}

fn rol16(v: u32) -> u32 {
  v.rotate_left(16)
}

fn cs64_digest(data: &[u8], digest: &[u8; 32]) -> (u32, u32) {
  let key_a = u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]) | 1;
  let key_b = u32::from_le_bytes([digest[4], digest[5], digest[6], digest[7]]) | 1;
  let factors = [key_a.wrapping_mul(CS64_FACTOR), key_b.wrapping_mul(CS64_FACTOR)];
  let mut terms: Vec<u32> =
    CS64_COEFFICIENTS.iter().enumerate().map(|(i, (c, _))| c.wrapping_mul(factors[i % 2])).collect();
  let mut offsets: Vec<u32> = CS64_COEFFICIENTS.iter().map(|(_, o)| *o).collect();

  let mut bytes = vec![0u8];
  bytes.extend_from_slice(data);
  while bytes.len() % 4 != 0 {
    bytes.push(0);
  }
  let mut words: Vec<u32> = bytes.chunks(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
  if words.len() % 2 == 1 {
    words.push(0);
  }
  for (i, &word) in words.iter().enumerate() {
    let even = i % 2 == 0;
    let mut term = word.wrapping_mul(if even { key_a } else { key_b });
    let mut offset = rol16(word).wrapping_mul(if even { 0xEF0569FB } else { 0xC31713DB });
    if i == 0 {
      term = term.wrapping_add(CS64_ADJUSTMENT0.wrapping_mul(factors[0]));
      offset = offset.wrapping_add(CS64_ADJUSTMENT1);
    }
    terms.push(term);
    offsets.push(offset);
  }

  let (mut swap_acc, mut swap_last, mut state, mut acc) = (0u32, 0u32, 0u32, 0u32);
  for i in (0..terms.len()).step_by(2) {
    let (x, y) = (terms[i], terms[i + 1]);
    let q = rol16(offsets[i].wrapping_add(x)).wrapping_mul(0x76F50F34);
    swap_acc = swap_acc.wrapping_add(rol16(q).wrapping_mul(0xC3EFEA97).wrapping_add(q));
    let q = rol16(offsets[i + 1].wrapping_add(y)).wrapping_mul(0x1881CE3C);
    swap_last = rol16(q).wrapping_mul(0x35BD1EC9).wrapping_add(q);
    swap_acc = swap_acc.wrapping_add(swap_last);

    state = state.wrapping_mul(key_a).wrapping_add(x);
    state = rol16(state).wrapping_mul(0xCF98B111);
    state = rol16(state).wrapping_mul(0x87085B9F);
    state = rol16(state).wrapping_mul(0x12CEB96D);
    state = rol16(state).wrapping_mul(0x257E1D83);
    acc = acc.wrapping_add(state);
    let mut t = state.wrapping_mul(key_b).wrapping_add(y);
    t = rol16(t).wrapping_mul(0xA27416F5);
    t = rol16(t).wrapping_mul(0xD38396FF);
    state = rol16(rol16(t).wrapping_mul(0x7C932B89)).wrapping_mul(0xBFA49F69);
    acc = acc.wrapping_add(state);
  }
  (swap_last ^ state, swap_acc ^ acc)
}

fn hex_upper(bytes: &[u8]) -> String {
  bytes.iter().map(|b| format!("{b:02X}")).collect()
}

// Input as before: Windows file-time ticks (rounded down to 5 minutes) + token.
pub fn sec_ms_gec_v2(unix_secs: u64, token: &str) -> String {
  let mut t = unix_secs + WIN_EPOCH;
  t -= t % 300;
  let data = format!("{}{}", t as u128 * 10_000_000, token).into_bytes();
  let digest = sha256_digest(&data);
  let (lo, hi) = cs64_digest(&data, &digest);
  let mut cs64 = lo.to_le_bytes().to_vec();
  cs64.extend_from_slice(&hi.to_le_bytes());
  format!("{}-{}", hex_upper(&cs64), hex_upper(&digest))
}
