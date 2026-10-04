import { describe, expect, it } from 'vitest';
import { toolTarget } from './tool-ui';
describe('tool targets', () => {
  it('keeps task identifiers and timeout configuration out of the timeline', () => {
    expect(toolTarget('task_output', '{"task_id":"child-123","timeout_ms":180000}')).toBe('');
    expect(toolTarget('kill_task', '{"task_id":"child-123"}')).toBe('');
    expect(toolTarget('task', '{"description":"Inspect files","prompt":"Full instructions"}')).toBe('Inspect files');
  });
  it('retains commands, formatted descriptions, and unfamiliar tool arguments', () => {
    expect(toolTarget('bash', 'npm test\nextra')).toBe('npm test');
    expect(toolTarget('task_output', 'Inspect files')).toBe('Inspect files');
    expect(toolTarget('custom', '{"argument":1}')).toBe('{"argument":1}');
  });
});
