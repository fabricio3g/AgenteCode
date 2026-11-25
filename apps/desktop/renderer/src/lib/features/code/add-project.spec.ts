import { describe, expect, it } from 'vitest';
import { defaultProjectsRoot, joinPath, shortPath } from './add-project';

const listing = (names: string[]) => ({ home: '/home/me', places: [{ name: 'Home', path: '/home/me' }, ...names.map((name) => ({ name, path: `/home/me/${name}` }))] });

describe('add project', () => {
  it('puts new projects in the remembered folder, else a usual one, else home', () => {
    expect(defaultProjectsRoot(listing(['Desktop', 'Code']), '/srv/work')).toBe('/srv/work');
    expect(defaultProjectsRoot(listing(['Desktop', 'Projects', 'Code']))).toBe('/home/me/Code');
    expect(defaultProjectsRoot(listing(['Desktop', 'Projects']))).toBe('/home/me/Projects');
    expect(defaultProjectsRoot(listing(['Desktop']))).toBe('/home/me');
  });

  it('shortens paths under home with ~', () => {
    expect(shortPath('/home/me/Code/app', '/home/me')).toBe('~/Code/app');
    expect(shortPath('/home/me', '/home/me')).toBe('~');
    expect(shortPath('/home/meadow/x', '/home/me')).toBe('/home/meadow/x');
    expect(shortPath('C:\\Users\\Me\\Code\\app', 'C:\\Users\\me')).toBe('~/Code/app');
  });

  it('joins with the parent\'s own separator', () => {
    expect(joinPath('/home/me/Code/', ' app ')).toBe('/home/me/Code/app');
    expect(joinPath('C:\\Users\\me\\Code', 'app')).toBe('C:\\Users\\me\\Code\\app');
  });
});
