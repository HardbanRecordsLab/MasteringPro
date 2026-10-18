/** node scripts/passport-selftest.mjs — sign / verify / tamper checks for the master passport. */
import { randomBytes } from 'node:crypto';
import { canonical, signPassport, useKeyForTests, verifyPassport, keyId } from '../src/services/passport.js';

let failed = 0;
const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); if (!c) failed++; };
useKeyForTests(randomBytes(32).toString('base64'));
const sha = 'a'.repeat(64);
const p = signPassport({ sha256: sha, file: { name: 'x.wav', format: 'WAV 24-bit', sampleRate: 48000 }, measurements: { integratedLufs: -14.04, truePeakDbtp: -1.02 }, junk: 'dropped' });
ok(p.payload.measurements.integratedLufs === -14 && !('junk' in p.payload), 'values are rounded and unknown fields dropped');
ok(verifyPassport(p).valid, 'a fresh passport verifies');
ok(verifyPassport(p, sha).fileMatches === true && verifyPassport(p, 'b'.repeat(64)).fileMatches === false, 'file-hash match is reported');
const tampered = JSON.parse(JSON.stringify(p)); tampered.payload.measurements.truePeakDbtp = -3;
ok(!verifyPassport(tampered).valid, 'changing one number breaks the signature');
ok(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }) === '{"a":[2,{"c":2,"d":1}],"b":1}', 'canonical JSON sorts keys at every level');
const seed = randomBytes(32).toString('base64');
useKeyForTests(seed); const k1 = keyId(); const p2 = signPassport({ sha256: sha });
useKeyForTests(seed); ok(keyId() === k1 && verifyPassport(p2).valid, 'the same seed gives the same key after a restart');
useKeyForTests(randomBytes(32).toString('base64')); ok(!verifyPassport(p2).valid, 'another key rejects it');
let threw = false; try { signPassport({ sha256: 'nothex' }); } catch { threw = true; }
ok(threw, 'a bad hash is refused');
console.log(failed ? `\n${failed} FAILED` : '\nall passport checks passed');
process.exit(failed ? 1 : 0);
