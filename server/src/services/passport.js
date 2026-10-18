// Master Passport — an Ed25519-signed statement of what MasteringPro measured on an exported master.
//
// It binds the exported file's SHA-256 to its loudness / true peak / codec / mono measurements and the issue time.
// The audio never reaches the server: the browser measures the file and sends only the numbers + hash, so the passport
// certifies "MasteringPro issued this for that exact file at that time" — editing any value breaks the signature.
// Same scheme as Metadata Engine's passport (Ed25519 over canonical JSON, base64 signature, keyId = sha256(pub)[:16]).
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');   // Ed25519 private key DER header
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');            // Ed25519 public key DER header
export const ISSUER = { name: 'MasteringPro', version: '2.0', by: 'HardbanRecords Lab' };

let keyPair = null;

/** PASSPORT_PRIVATE_KEY = base64 of the raw 32-byte seed. Without it an in-memory key is used (valid until restart). */
function keys() {
  if (keyPair) return keyPair;
  const seed = (process.env.PASSPORT_PRIVATE_KEY || '').trim();
  let privateKey;
  if (seed) {
    privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed, 'base64')]), format: 'der', type: 'pkcs8' });
  } else {
    privateKey = generateKeyPairSync('ed25519').privateKey;
    console.warn('[passport] PASSPORT_PRIVATE_KEY not set — using a temporary key; passports will not verify after a restart');
  }
  const publicKey = createPublicKey(privateKey);
  const rawPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length);
  keyPair = { privateKey, publicKey, publicB64: rawPub.toString('base64') };
  return keyPair;
}

export function useKeyForTests(seedB64) {
  keyPair = null;
  if (seedB64 === undefined) delete process.env.PASSPORT_PRIVATE_KEY;
  else process.env.PASSPORT_PRIVATE_KEY = seedB64;
}

export const publicKeyB64 = () => keys().publicB64;
export const keyId = (pubB64 = publicKeyB64()) => createHash('sha256').update(Buffer.from(pubB64, 'base64')).digest('hex').slice(0, 16);

/** Deterministic JSON: sorted keys, no whitespace. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

const num = (v, digits = 2) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** digits) / 10 ** digits : null);
const txt = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null);

/** Whitelists and rounds what the browser sent; anything else is dropped. */
export function buildPayload(input, issuedAt = new Date()) {
  const sha256 = String(input?.sha256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('sha256 must be 64 hex characters');
  const f = input.file || {};
  const m = input.measurements || {};
  const d = input.delivery || {};
  const payload = {
    v: 1,
    kind: 'master',
    sha256,
    file: {
      name: txt(f.name, 200), format: txt(f.format, 40), sampleRate: num(f.sampleRate, 0), bitDepth: num(f.bitDepth, 0),
      channels: num(f.channels, 0), durationSec: num(f.durationSec, 2), bytes: num(f.bytes, 0),
    },
    measurements: {
      integratedLufs: num(m.integratedLufs, 1), truePeakDbtp: num(m.truePeakDbtp, 1), lra: num(m.lra, 1),
      targetLufs: num(m.targetLufs, 1), targetPeakDbtp: num(m.targetPeakDbtp, 1), standard: 'ITU-R BS.1770-4 / EBU R128',
    },
    delivery: Array.isArray(d.codecs)
      ? { codecs: d.codecs.slice(0, 6).map((c) => ({ id: txt(c.id, 20), truePeakDbtp: num(c.truePeakDbtp, 1) })), monoCorrelation: num(d.monoCorrelation, 2) }
      : null,
    release: input.release ? {
      title: txt(input.release.title), artist: txt(input.release.artist), album: txt(input.release.album), isrc: txt(input.release.isrc, 12),
    } : null,
    measuredBy: 'MasteringPro, in the browser — the audio was never uploaded',
    issuer: ISSUER,
    issuedAt: issuedAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  return payload;
}

export function signPassport(input, issuedAt) {
  const payload = buildPayload(input, issuedAt);
  const signature = sign(null, Buffer.from(canonical(payload), 'utf8'), keys().privateKey).toString('base64');
  return { alg: 'Ed25519', keyId: keyId(), payload, signature };
}

export function verifyPassport(passport, sha256) {
  try {
    if (!passport || passport.alg !== 'Ed25519' || !passport.payload || !passport.signature) return { valid: false, reason: 'not a MasteringPro passport' };
    if (passport.keyId && passport.keyId !== keyId()) return { valid: false, reason: 'signed with a different key' };
    const ok = verify(null, Buffer.from(canonical(passport.payload), 'utf8'), keys().publicKey, Buffer.from(passport.signature, 'base64'));
    if (!ok) return { valid: false, reason: 'the passport was changed after it was signed' };
    const out = { valid: true, keyId: keyId(), issuedAt: passport.payload.issuedAt, sha256: passport.payload.sha256 };
    if (sha256) out.fileMatches = String(sha256).toLowerCase() === passport.payload.sha256;
    return out;
  } catch {
    return { valid: false, reason: 'malformed passport' };
  }
}
