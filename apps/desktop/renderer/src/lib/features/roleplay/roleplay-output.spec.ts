import { describe, expect, it } from 'vitest';
import { buildRoleplayStopStrings, stripSpeakerPrefix, stripTrailingPartialStop } from './roleplay-output';

const cast = ['Aiko', 'Rachel'];

describe('stripSpeakerPrefix', () => {
  it('strips the speaker prefix, keeping the line', () => {
    expect(stripSpeakerPrefix('Aiko: "You again?"', cast)).toBe('"You again?"');
    expect(stripSpeakerPrefix('Rachel：I was worried.', cast)).toBe('I was worried.');
  });

  it('strips bold and markdown variants', () => {
    expect(stripSpeakerPrefix('**Aiko:** Hello.', cast)).toBe('Hello.');
    expect(stripSpeakerPrefix('__Rachel__: Hi.', cast)).toBe('Hi.');
  });

  it('strips repeated prefixes', () => {
    expect(stripSpeakerPrefix('Aiko: Aiko: Hello.', cast)).toBe('Hello.');
  });

  it('never strips a name that is not in the scene', () => {
    expect(stripSpeakerPrefix('Note: keep the door locked.', cast)).toBe('Note: keep the door locked.');
    expect(stripSpeakerPrefix('Misaka: hello', cast)).toBe('Misaka: hello');
  });

  it('does not touch prefixes without a colon', () => {
    expect(stripSpeakerPrefix('Aiko said nothing.', cast)).toBe('Aiko said nothing.');
    expect(stripSpeakerPrefix('Aiko — wait.', cast)).toBe('Aiko — wait.');
  });

  it('is a no-op without names or text', () => {
    expect(stripSpeakerPrefix('Aiko: hi', [])).toBe('Aiko: hi');
    expect(stripSpeakerPrefix('', cast)).toBe('');
  });
});

describe('buildRoleplayStopStrings', () => {
  it('ends a reply at the user turn in a one-on-one scene', () => {
    // The speaker's own name is the only cast name present, and it is never a
    // boundary — so a solo scene knows exactly one turn marker.
    const stops = buildRoleplayStopStrings({ userName: 'Sam', speakerName: 'Aiko', castNames: ['Aiko'] });
    expect(stops).toEqual(['\nSam:', '\nSam']);
  });

  it('treats every other cast member as a turn boundary in a group scene', () => {
    const stops = buildRoleplayStopStrings({
      userName: 'Sam',
      speakerName: 'Aiko',
      castNames: ['Aiko', 'Rachel']
    });
    expect(stops).toEqual(['\nSam:', '\nRachel:', '\nSam', '\nRachel']);
    expect(stops.some((stop) => stop.includes('Aiko'))).toBe(false);
  });

  it('keeps the colon forms inside the provider cap', () => {
    const stops = buildRoleplayStopStrings({
      userName: 'Sam',
      speakerName: 'Aiko',
      castNames: ['Aiko', 'Rachel', 'Miki', 'Jun']
    });
    expect(stops).toHaveLength(4);
    expect(stops).toEqual(['\nSam:', '\nRachel:', '\nMiki:', '\nJun:']);
  });

  it('only knows the user when one turn may voice several characters', () => {
    const stops = buildRoleplayStopStrings({
      userName: 'Sam',
      speakerName: 'Aiko',
      castNames: ['Aiko', 'Rachel'],
      allowMultiSpeaker: true
    });
    expect(stops).toEqual(['\nSam:', '\nSam']);
  });

  it('sends nothing without a name', () => {
    expect(buildRoleplayStopStrings({})).toEqual([]);
  });
});

describe('stripTrailingPartialStop', () => {
  const stops = ['\nSam:', '\nSam'];

  it('removes a stop string the stream actually reached', () => {
    expect(stripTrailingPartialStop('*She sets down the cup.*\nSam:', stops)).toBe('*She sets down the cup.*');
    expect(stripTrailingPartialStop('*She sets down the cup.*\nSam', stops)).toBe('*She sets down the cup.*');
  });

  it('removes a fragment the stream cut through', () => {
    expect(stripTrailingPartialStop('*She sets down the cup.*\nSa', stops)).toBe('*She sets down the cup.*');
  });

  it('leaves prose that merely starts the same way', () => {
    expect(stripTrailingPartialStop('*She says something.*', stops)).toBe('*She says something.*');
    expect(stripTrailingPartialStop('*She glances up.*\nSomeone knocks.', stops)).toBe('*She glances up.*\nSomeone knocks.');
  });

  it('is a no-op with no text or no stops', () => {
    expect(stripTrailingPartialStop('', stops)).toBe('');
    expect(stripTrailingPartialStop('*Hi.*', [])).toBe('*Hi.*');
  });
});
