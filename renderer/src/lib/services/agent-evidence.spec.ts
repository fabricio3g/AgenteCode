import { describe, expect, it } from 'vitest';
import { requestedVisualArtifacts } from './agent-evidence';

describe('requestedVisualArtifacts', () => {
  it('detects explicit visual deliverable requests', () => {
    expect(requestedVisualArtifacts('Make a bar chart of sales by quarter')).toContain('chart');
    expect(requestedVisualArtifacts('Draw a flowchart of the login flow')).toContain('diagram');
    expect(requestedVisualArtifacts('Show me a map of our offices in Spain')).toContain('map');
    expect(requestedVisualArtifacts('Build a KPI dashboard for the team')).toContain('dashboard');
    expect(requestedVisualArtifacts('Give me a fact sheet on solar panels')).toContain('info_card');
    expect(requestedVisualArtifacts('Create an HTML card for the pricing tiers')).toContain('html_card');
  });

  it('ignores plain conversation without deliverable intent', () => {
    expect(requestedVisualArtifacts('What is a bar chart?')).toEqual([]);
    expect(requestedVisualArtifacts('Explain architecture diagrams')).toEqual([]);
    expect(requestedVisualArtifacts('How do I create a map?')).toEqual([]);
    expect(requestedVisualArtifacts("Don't create a map, just explain it")).toEqual([]);
    expect(requestedVisualArtifacts('What is the capital of Peru?')).toEqual([]);
    expect(requestedVisualArtifacts('Explain how photosynthesis works')).toEqual([]);
    expect(requestedVisualArtifacts('Map these fields to the new schema')).toEqual([]);
    expect(requestedVisualArtifacts('Write a report about Madrid')).toEqual([]);
  });

  it('does not confuse bare tech words with card requests', () => {
    // Website builds have their own enforcement; only explicit "html card" counts.
    expect(requestedVisualArtifacts('Build a landing page with HTML and CSS')).toEqual([]);
  });

  it('sends mind maps to the diagram tool, never geocoding', () => {
    expect(requestedVisualArtifacts('Create a mind map of the project')).toEqual(['diagram']);
  });
});
