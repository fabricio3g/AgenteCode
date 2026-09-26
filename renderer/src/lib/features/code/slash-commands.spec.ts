import { describe, expect, it } from 'vitest';
import { exactSlashCommand, matchSlashCommands, slashQuery } from './slash-commands';

const commands = [{ name: 'compact' }, { name: 'changes' }, { name: 'full', aliases: ['auto'] }, { name: 'new' }];

describe('slash commands', () => {
  it('only opens while the composer holds a single /word', () => {
    expect(slashQuery('/')).toBe('');
    expect(slashQuery('/Com')).toBe('com');
    expect(slashQuery('/compact now')).toBeNull();
    expect(slashQuery('fix /compact')).toBeNull();
  });

  it('filters by prefix first, then anywhere, and through aliases', () => {
    expect(matchSlashCommands(commands, 'c').map((c) => c.name)).toEqual(['compact', 'changes']);
    expect(matchSlashCommands(commands, 'ang').map((c) => c.name)).toEqual(['changes']);
    expect(matchSlashCommands(commands, 'au').map((c) => c.name)).toEqual(['full']);
    expect(matchSlashCommands(commands, '').length).toBe(4);
  });

  it('recognises an exact command on submit', () => {
    expect(exactSlashCommand(commands, '/compact ')?.name).toBe('compact');
    expect(exactSlashCommand(commands, '/auto')?.name).toBe('full');
    expect(exactSlashCommand(commands, '/compac')).toBeNull();
    expect(exactSlashCommand(commands, '/compact the logs')).toBeNull();
  });
});
