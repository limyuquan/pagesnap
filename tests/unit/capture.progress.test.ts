import { describe, expect, it } from 'vitest';
import { recentMedian } from '@/capture/progress';

describe('popup progress cadence', () => {
  it('needs a few gaps before it reports a cadence', () => {
    expect(recentMedian([530, 534])).toBeNull();
    expect(recentMedian([530, 534, 540])).toBe(534);
  });

  it('uses only the recent gaps and ignores a one-off stall', () => {
    expect(recentMedian([5000, 530, 531, 2400, 533, 532, 534])).toBe(532.5);
    expect(recentMedian([530, 532, 534, 536])).toBe(533);
  });
});
