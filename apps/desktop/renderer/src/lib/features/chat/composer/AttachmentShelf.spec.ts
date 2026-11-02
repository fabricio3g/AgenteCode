// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AttachmentShelf from './AttachmentShelf.svelte';
import type { DraftAttachment } from './attachment-shelf';
vi.mock('$lib/utils/transitions', () => ({ backdropIn: () => ({}), backdropOut: () => ({}), dialogIn: () => ({}), dialogOut: () => ({}) }));
vi.mock('../DocumentViewer.svelte', () => ({ default: null }));
afterEach(cleanup);
const files = (count: number): DraftAttachment[] => Array.from({length:count},(_,index) => ({
  id:String(index), name:`reference-${index}.png`, size:1024, type:'image/png', kind:'image', status:'ready', source:`data:image/png;base64,${index}`
}));
describe('draft attachment shelf', () => {
  it('keeps three previews in the draft and manages the complete collection', async () => {
    const onremove = vi.fn();
    const view = render(AttachmentShelf,{files:files(15),onremove});
    expect(view.getAllByRole('button',{name:/^Preview reference/})).toHaveLength(3);
    await fireEvent.click(view.getByRole('button',{name:'View all 15 attachments'}));
    const gallery = screen.getByRole('dialog',{name:'Attachments · 15'});
    expect(within(gallery).getAllByRole('button',{name:/^Preview reference/})).toHaveLength(15);
    await fireEvent.click(within(gallery).getByRole('checkbox',{name:'Select reference-4.png'}));
    await fireEvent.click(within(gallery).getByRole('checkbox',{name:'Select reference-8.png'}));
    await fireEvent.click(within(gallery).getByRole('button',{name:'Remove 2 selected'}));
    expect(onremove.mock.calls).toEqual([['4'],['8']]);
  });
  it('opens image previews, navigates with arrows, and returns to the gallery with Escape', async () => {
    render(AttachmentShelf,{files:files(4),onremove:vi.fn()});
    await fireEvent.click(screen.getByRole('button',{name:'View all 4 attachments'}));
    const gallery=screen.getByRole('dialog',{name:'Attachments · 4'});
    await fireEvent.click(within(gallery).getByRole('button',{name:'Preview reference-2.png'}));
    let preview=screen.getByRole('dialog',{name:'reference-2.png'});
    expect(within(preview).getByRole('img',{name:'reference-2.png'}).getAttribute('src')).toContain('base64,2');
    await fireEvent.click(within(preview).getByRole('button',{name:'Zoom in'}));
    expect(within(preview).getByRole('button',{name:'125%'})).toBeTruthy();
    await fireEvent.keyDown(window,{key:'ArrowRight'});
    preview=screen.getByRole('dialog',{name:'reference-3.png'});
    await fireEvent.keyDown(window,{key:'Escape'});
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'reference-3.png'})).toBeNull());
    expect(screen.getByRole('dialog',{name:'Attachments · 4'})).toBeTruthy();
  });
  it('loads an attachment once and ignores its result after switching files', async () => {
    let finish!: (value: string) => void;
    const loadSource=vi.fn(()=>new Promise<string>(resolve=>{finish=resolve;}));
    const items=files(2); items[0]={...items[0],source:undefined,loadSource};
    render(AttachmentShelf,{files:items,onremove:vi.fn()});
    await fireEvent.click(screen.getByRole('button',{name:'Preview reference-0.png'}));
    expect(loadSource).toHaveBeenCalledTimes(1);
    await fireEvent.click(screen.getByRole('button',{name:'Next attachment'}));
    finish('data:image/png;base64,late');
    await waitFor(()=>expect(screen.getByRole('dialog',{name:'reference-1.png'})).toBeTruthy());
    expect(within(screen.getByRole('dialog',{name:'reference-1.png'})).getByRole('img').getAttribute('src')).toContain('base64,1');
    expect(loadSource).toHaveBeenCalledTimes(1);
  });
  it('asks for a thumbnail once, because the tile never re-reads the value it writes', async () => {
    // Reading `thumbnail` inside the effect that sets it made the tile re-run for
    // every arriving thumbnail: attach an image and the renderer spun forever.
    const loadThumbnail=vi.fn(async () => 'data:image/png;base64,thumb');
    const items=files(1); items[0]={...items[0],source:undefined,thumbnail:undefined,loadThumbnail};
    const view=render(AttachmentShelf,{files:items,onremove:vi.fn()});
    await waitFor(()=>expect(view.getByRole('img',{name:'reference-0.png'})).toBeTruthy());
    await new Promise(resolve=>setTimeout(resolve,40));
    expect(loadThumbnail).toHaveBeenCalledTimes(1);
  });
});
