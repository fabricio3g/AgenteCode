import { AgentTool } from './base.ts';
import { scrapeUrlStructured } from '../web-scraper.ts';

export class WebScrapeTool extends AgentTool {
  name = 'web_scrape';
  description = 'Scrape a URL and return clean text with link metadata for crawling';
  parameters = {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to scrape' },
      max_length: { type: 'number', description: 'Maximum content length' },
      max_links: { type: 'number', description: 'Maximum links returned for crawling' }
    },
    required: ['url']
  };

  async execute({ url, max_length, max_links }) {
    return scrapeUrlStructured({
      url,
      maxLength: max_length,
      maxLinks: max_links
    });
  }
}
