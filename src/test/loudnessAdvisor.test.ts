import { describe, it, expect } from 'vitest';
import { adviseLoudness } from '@/components/mastering/LoudnessPenalty';

const spotify = { name: 'Spotify', lufs: -14, tp: -1 };

describe('adviseLoudness', () => {
  it('flags a true-peak ceiling breach', () => {
    const a = adviseLoudness({ lufs: -14, tp: -0.2, lra: 7 }, spotify);
    expect(a.some((x) => x.kind === 'warn' && /true peak/i.test(x.text))).toBe(true);
  });

  it('warns when the master is much louder than the target', () => {
    const a = adviseLoudness({ lufs: -8, tp: -1, lra: 4 }, spotify);
    expect(a.some((x) => /louder than Spotify/.test(x.text))).toBe(true);
  });

  it('notes available headroom when quiet', () => {
    const a = adviseLoudness({ lufs: -18, tp: -3, lra: 8 }, spotify);
    expect(a.some((x) => /quieter than Spotify/.test(x.text))).toBe(true);
  });

  it('calls a wide LRA out for streaming', () => {
    const a = adviseLoudness({ lufs: -14, tp: -1, lra: 13 }, spotify);
    expect(a.some((x) => /LRA 13/.test(x.text))).toBe(true);
  });

  it('says nothing urgent when in spec', () => {
    const a = adviseLoudness({ lufs: -14, tp: -1.2, lra: 7 }, spotify);
    expect(a).toHaveLength(1);
    expect(a[0].kind).toBe('ok');
  });
});
