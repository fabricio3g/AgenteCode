import { describe, expect, it } from 'vitest';
import { boldEdit, fontSizeEdit, paddingEdit, paddingSides, parsePx, radiusEdit, startsBurst, stepValue, swatchesFor } from './design-edit-ops';

describe('steps', () => {
  it('walks a ladder from any value, holding at the ends', () => {
    expect(stepValue(16, [10, 14, 16, 20], 1)).toBe(20);
    expect(stepValue(17, [10, 14, 16, 20], 1)).toBe(20);
    expect(stepValue(17, [10, 14, 16, 20], -1)).toBe(16);
    expect(stepValue(20, [10, 14, 16, 20], 1)).toBe(20);
    expect(stepValue(10, [10, 14, 16, 20], -1)).toBe(10);
  });
  it('reads px lengths only', () => {
    expect(parsePx('16px')).toBe(16);
    expect(parsePx('12.5px 4px')).toBe(12.5);
    expect(parsePx('1rem')).toBeNull();
    expect(parsePx(undefined)).toBeNull();
  });
});

describe('edit ops', () => {
  it('steps the font size', () => {
    expect(fontSizeEdit({ 'font-size': '16px' }, 1)).toEqual({ 'font-size': '18px' });
    expect(fontSizeEdit({ 'font-size': '16px' }, -1)).toEqual({ 'font-size': '14px' });
    expect(fontSizeEdit({}, 1)).toEqual({ 'font-size': '18px' });
  });
  it('toggles bold at 600', () => {
    expect(boldEdit({ 'font-weight': '400' })).toEqual({ 'font-weight': '700' });
    expect(boldEdit({ 'font-weight': '600' })).toEqual({ 'font-weight': '400' });
    expect(boldEdit({})).toEqual({ 'font-weight': '700' });
  });
  it('steps the radius on all corners', () => {
    expect(radiusEdit({ 'border-radius': '0px' }, 1)).toEqual({ 'border-radius': '2px' });
    expect(radiusEdit({ 'border-radius': '8px' }, -1)).toEqual({ 'border-radius': '6px' });
    expect(radiusEdit({ 'border-radius': '50%' }, 1)).toEqual({ 'border-radius': '2px' });
  });
  it('steps each side of the padding and collapses equal sides', () => {
    expect(paddingSides('8px 16px')).toEqual([8, 16, 8, 16]);
    expect(paddingEdit({ padding: '8px 16px' }, 1)).toEqual({ padding: '12px 20px' });
    expect(paddingEdit({ padding: '8px' }, 1)).toEqual({ padding: '12px' });
    expect(paddingEdit({ padding: '8px 16px 4px 2px' }, 1)).toEqual({ padding: '12px 20px 6px 4px' });
    expect(paddingEdit({ padding: '0px' }, -1)).toEqual({ padding: '0px' });
    expect(paddingEdit({}, 1)).toEqual({ padding: '2px' });
  });
});

describe('swatchesFor', () => {
  it("uses the design's literal colour tokens as var() references", () => {
    const css = ':root { --bg: #ffffff; --accent: #e76d1f; --gap: 8px; --glow: var(--accent); }';
    const { fromDesign, fallback } = swatchesFor(css);
    expect(fromDesign).toEqual([
      { label: 'bg', show: '#ffffff', css: 'var(--bg)' },
      { label: 'accent', show: '#e76d1f', css: 'var(--accent)' }
    ]);
    expect(fallback).toEqual([]);
  });
  it('offers neutrals and the ember when the design has no colours', () => {
    const { fromDesign, fallback } = swatchesFor(undefined);
    expect(fromDesign).toEqual([]);
    expect(fallback.map((swatch) => swatch.css)).toContain('#e76d1f');
  });
});

describe('startsBurst', () => {
  it('starts a burst for the first edit and after a pause', () => {
    expect(startsBurst(null, 1000)).toBe(true);
    expect(startsBurst(1000, 5000)).toBe(false);
    expect(startsBurst(1000, 60_000)).toBe(true);
  });
});
