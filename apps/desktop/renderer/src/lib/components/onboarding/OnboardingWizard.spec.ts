// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import OnboardingWizard from './OnboardingWizard.svelte';
import GeneralSettings from '../settings/GeneralSettings.svelte';
const state = vi.hoisted(()=>({onboardingOpen:false,onboardingCompleted:false,userName:'',editorCommand:'',roleplayEnabled:false}));
const markComplete = vi.hoisted(()=>vi.fn());
vi.mock('$lib/stores/app.svelte',()=>({appStore:state}));
vi.mock('$lib/services/onboarding',()=>({gatherOnboardingHardware:vi.fn(async()=>({hardware:null,runtime:null})),markOnboardingComplete:markComplete}));
afterEach(()=>cleanup());
it('labels setup and its progress, and supports closing with Escape',async()=>{
  state.onboardingOpen=true;
  const view=render(OnboardingWizard);
  expect(view.getByRole('dialog',{name:'Set up Agente'})).toBeTruthy();
  expect(document.querySelectorAll('.setup-progress li')).toHaveLength(4);
  expect(document.querySelector('[aria-current=step]')?.textContent).toContain('1');
  await fireEvent.keyDown(document,{key:'Escape'});
  expect(state.onboardingOpen).toBe(false);
  expect(markComplete).toHaveBeenCalled();
});
it('reopens setup from general settings without resetting installed preferences',async()=>{
  state.onboardingOpen=false;
  const view=render(GeneralSettings,{enableThinking:true,hfToken:'',onsaveHfToken:()=>{}});
  await fireEvent.click(view.getByRole('button',{name:'Open setup wizard'}));
  expect(state.onboardingOpen).toBe(true);
  expect(state.editorCommand).toBe('');
});
