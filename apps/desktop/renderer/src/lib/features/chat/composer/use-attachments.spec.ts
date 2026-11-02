// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
const { addFiles } = vi.hoisted(() => ({addFiles:vi.fn(async () => {})}));
vi.mock('$lib/stores/app.svelte', () => ({appStore:{addFiles}}));
import { ComposerAttachments } from './use-attachments.svelte';
afterEach(() => { vi.clearAllMocks(); document.body.replaceChildren(); });
function filesEvent(name: string, file: File) {
  const event = new Event(name,{bubbles:true,cancelable:true});
  Object.defineProperty(event,name==='paste'?'clipboardData':'dataTransfer',{value:{files:[file],types:['Files']}});
  return event;
}
describe('composer attachment ownership',()=>{
  it('attaches a pasted image and leaves ordinary text paste alone',()=>{
    const attachments=new ComposerAttachments(); const image=new File(['png'],'image.png',{type:'image/png'});
    const paste=filesEvent('paste',image); attachments.handlePaste(paste as ClipboardEvent);
    expect(paste.defaultPrevented).toBe(true); expect(addFiles).toHaveBeenCalledWith([image]);
    const text=new Event('paste',{cancelable:true}); attachments.handlePaste(text as ClipboardEvent);
    expect(text.defaultPrevented).toBe(false); expect(addFiles).toHaveBeenCalledTimes(1);
  });
  it('handles a card drop once, without a second document import',()=>{
    const attachments=new ComposerAttachments(); const off=attachments.listen();
    const card=document.createElement('div'); document.body.append(card);
    card.addEventListener('drop', event=>attachments.handleDrop(event));
    const image=new File(['png'],'image.png'); attachments.windowDragActive=true;
    card.dispatchEvent(filesEvent('drop',image));
    expect(addFiles).toHaveBeenCalledTimes(1); expect(attachments.windowDragActive).toBe(false); off();
  });
  it('accepts a file outside the composer and respects another surface handling it',()=>{
    const attachments=new ComposerAttachments(); const off=attachments.listen();
    const file=new File(['brief'],'brief.txt'); document.body.dispatchEvent(filesEvent('drop',file));
    expect(addFiles).toHaveBeenCalledWith([file]);
    const claimed=filesEvent('drop',file); claimed.preventDefault(); document.body.dispatchEvent(claimed);
    expect(addFiles).toHaveBeenCalledTimes(1); off();
  });
});
