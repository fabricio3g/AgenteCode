import { describe, expect, it } from 'vitest';
import { normalizeDeck } from '$shared/deck';

describe('normalizeDeck', () => {
  it('picks a layout from what each slide holds', () => {
    const deck = normalizeDeck({
      title: 'Q4 kickoff',
      slides: [
        { title: 'Q4 kickoff', content: 'Plan for October–December' },
        { title: 'Numbers', stats: [{ value: '€612K', label: 'Revenue' }] },
        { title: 'Budget', chart: { type: 'donut', labels: ['A', 'B'], datasets: [{ label: 'x', data: [1, 2] }] } },
        { title: 'Projects', table: { rows: [{ client: 'Aurora', due: 'Nov 28' }] } },
        { title: 'Hire or not', left: ['Designer'], right: { heading: 'Freelance', bullets: ['Motion'] } },
        { quote: 'Fewer projects, done properly.', author: 'Studio' },
        { title: 'Goals', bullets: ['- Win two retainers', '* Ship Aurora'] },
        { title: 'Part two' }
      ]
    });
    expect(deck.slides.map((slide) => slide.layout)).toEqual(['title', 'stats', 'chart', 'table', 'two-column', 'quote', 'bullets', 'section']);
    expect(deck.slides[0].subtitle).toBe('Plan for October–December');
    expect(deck.slides[2].chart).toEqual({ type: 'doughnut', labels: ['A', 'B'], series: [{ name: 'x', values: [1, 2] }] });
    expect(deck.slides[3].table).toEqual({ columns: ['client', 'due'], rows: [['Aurora', 'Nov 28']] });
    expect(deck.slides[5].attribution).toBe('Studio');
    expect(deck.slides[6].bullets).toEqual(['Win two retainers', 'Ship Aurora']);
    expect(deck).toMatchObject({ theme: 'light', accent: 'blue' });
  });

  it('keeps an explicit layout and reads old outline-only decks', () => {
    const deck = normalizeDeck({ title: 'Old', theme: 'dark', slides: [{ title: 'One', content: ['a', 'b'], layout: 'default' }, { layout: 'section', title: 'Two' }] });
    expect(deck.theme).toBe('dark');
    expect(deck.slides.map((slide) => slide.layout)).toEqual(['bullets', 'section']);
    expect(deck.slides[0].content).toEqual(['a', 'b']);
  });
});
