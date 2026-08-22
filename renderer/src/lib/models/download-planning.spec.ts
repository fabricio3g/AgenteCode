import { describe, expect, it } from 'vitest';
import {
  aggregateProgress,
  applyResumeResponse,
  checkDiskSpace,
  expandShards,
  planResume
} from '../../../../main/download-planning';

describe('expandShards', () => {
  it('passes plain files through untouched', () => {
    expect(expandShards('qwen3-8b-q4_k_m.gguf')).toEqual(['qwen3-8b-q4_k_m.gguf']);
  });

  it('expands a sharded GGUF into every shard in order', () => {
    expect(expandShards('llama-3-70b-00001-of-00003.gguf')).toEqual([
      'llama-3-70b-00001-of-00003.gguf',
      'llama-3-70b-00002-of-00003.gguf',
      'llama-3-70b-00003-of-00003.gguf'
    ]);
  });

  it('preserves the zero padding width of the requested file', () => {
    const shards = expandShards('big-model-0001-of-0012.gguf');
    expect(shards).toHaveLength(12);
    expect(shards[0]).toBe('big-model-0001-of-0012.gguf');
    expect(shards[11]).toBe('big-model-0012-of-0012.gguf');
  });

  it('ignores lookalike names that are not shards', () => {
    expect(expandShards('model-of-the-day.gguf')).toEqual(['model-of-the-day.gguf']);
  });
});

describe('planResume', () => {
  it('restarts cleanly when there is no partial file', () => {
    const plan = planResume({ partSize: 0, storedEtag: '"abc"' });
    expect(plan.offset).toBe(0);
    expect(plan.writeMode).toBe('truncate');
    expect(plan.headers).toEqual({});
  });

  it('never resumes without a stored etag — bytes cannot be proven', () => {
    const plan = planResume({ partSize: 4096, storedEtag: null });
    expect(plan.offset).toBe(0);
    expect(plan.writeMode).toBe('truncate');
  });

  it('resumes from the part size with Range + If-Range when the etag matches', () => {
    const plan = planResume({ partSize: 4096, storedEtag: '"abc"' });
    expect(plan.offset).toBe(4096);
    expect(plan.writeMode).toBe('append');
    expect(plan.headers.Range).toBe('bytes=4096-');
    expect(plan.headers['If-Range']).toBe('"abc"');
  });
});

describe('applyResumeResponse', () => {
  it('keeps the resume on a 206', () => {
    const plan = planResume({ partSize: 1000, storedEtag: '"e"' });
    const applied = applyResumeResponse(plan, 206);
    expect(applied.offset).toBe(1000);
    expect(applied.writeMode).toBe('append');
  });

  it('falls back to a full restart when the server answers 200', () => {
    const plan = planResume({ partSize: 1000, storedEtag: '"e"' });
    const applied = applyResumeResponse(plan, 200);
    expect(applied.offset).toBe(0);
    expect(applied.writeMode).toBe('truncate');
  });

  it('leaves a fresh download untouched by the response status', () => {
    const plan = planResume({ partSize: 0, storedEtag: null });
    const applied = applyResumeResponse(plan, 200);
    expect(applied.offset).toBe(0);
    expect(applied.writeMode).toBe('truncate');
  });
});

describe('aggregateProgress', () => {
  it('sums shard totals into job-level progress', () => {
    const totals = aggregateProgress([
      { sizeBytes: 500, doneBytes: 500 },
      { sizeBytes: 500, doneBytes: 250 }
    ]);
    expect(totals.totalBytes).toBe(1000);
    expect(totals.downloadedBytes).toBe(750);
    expect(totals.progress).toBe(75);
  });

  it('reports zero progress before sizes are known', () => {
    const totals = aggregateProgress([{ sizeBytes: 0, doneBytes: 0 }]);
    expect(totals.progress).toBe(0);
  });

  it('clamps to 100 and tolerates negative junk', () => {
    const totals = aggregateProgress([{ sizeBytes: 100, doneBytes: 500 }, { sizeBytes: -5, doneBytes: NaN as unknown as number }]);
    expect(totals.progress).toBe(100);
    expect(totals.downloadedBytes).toBe(500);
  });
});

describe('checkDiskSpace', () => {
  it('blocks when the remaining bytes exceed free space', () => {
    const error = checkDiskSpace({ expectedRemainingBytes: 40 * 1024 ** 3, freeBytes: 10 * 1024 ** 3 });
    expect(error).toContain('Not enough disk space');
    expect(error).toContain('40.0 GB needed');
    expect(error).toContain('10.0 GB free');
  });

  it('allows a download that fits', () => {
    expect(checkDiskSpace({ expectedRemainingBytes: 4 * 1024 ** 3, freeBytes: 10 * 1024 ** 3 })).toBeNull();
  });

  it('does not block on an unknown volume', () => {
    expect(checkDiskSpace({ expectedRemainingBytes: 999, freeBytes: Number.POSITIVE_INFINITY })).toBeNull();
  });
});
