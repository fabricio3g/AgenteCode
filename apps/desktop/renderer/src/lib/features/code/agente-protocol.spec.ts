import { describe, expect, it } from 'vitest';
import { codeStopReasonToHomeStopReason, normalizeHomeRuntimeMode } from '$shared/agente-protocol';

describe('codeStopReasonToHomeStopReason', () => {
  it('maps healthy endings to none — Home outcome carries completed/partial/stopped', () => {
    expect(codeStopReasonToHomeStopReason('stop')).toBe('none');
    expect(codeStopReasonToHomeStopReason('toolUse')).toBe('none');
  });

  it('maps length to the iteration cap and keeps errors as errors', () => {
    expect(codeStopReasonToHomeStopReason('length')).toBe('iteration_limit');
    expect(codeStopReasonToHomeStopReason('error')).toBe('error');
  });

  it('maps aborts to none — a user interrupt is not a failure', () => {
    expect(codeStopReasonToHomeStopReason('aborted')).toBe('none');
  });
});

describe('normalizeHomeRuntimeMode', () => {
  it('executes plan mode as supervised initially', () => {
    expect(normalizeHomeRuntimeMode('plan')).toBe('supervised');
  });

  it('passes full, supervised and unset through', () => {
    expect(normalizeHomeRuntimeMode('full')).toBe('full');
    expect(normalizeHomeRuntimeMode('supervised')).toBe('supervised');
    expect(normalizeHomeRuntimeMode(undefined)).toBeUndefined();
  });
});
