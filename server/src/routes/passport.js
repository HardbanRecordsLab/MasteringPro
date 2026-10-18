import { Hono } from 'hono';
import { requireUser } from '../auth.js';
import { keyId, publicKeyB64, signPassport, verifyPassport } from '../services/passport.js';

export const passportRoutes = new Hono();

// Public: the key anyone can use to check a passport offline.
passportRoutes.get('/public-key', (c) => c.json({ alg: 'Ed25519', publicKey: publicKeyB64(), keyId: keyId() }));

// Public: is this passport genuine, and (optionally) does it belong to this file hash?
passportRoutes.post('/verify', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  return c.json(verifyPassport(body?.passport, body?.sha256));
});

// Signed for a signed-in account: the browser sends the file hash + its own measurements.
passportRoutes.post('/sign', requireUser, async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  try {
    return c.json(signPassport(body));
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});
