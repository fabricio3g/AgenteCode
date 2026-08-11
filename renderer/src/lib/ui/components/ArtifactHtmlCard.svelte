<svelte:options runes={true} />

<script lang="ts">
  import type { HtmlCardArtifactPayload } from '$lib/types/chat';

  interface Props {
    payload: HtmlCardArtifactPayload;
  }

  let { payload }: Props = $props();

  const srcdoc = $derived.by(() => {
    const body = String(payload.html || '');
    // Minimal document shell; styles inherit readable defaults for light/dark-ish content.
    return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><style>
      :root { color-scheme: light dark; }
      html, body { margin: 0; padding: 0; background: transparent; color: inherit; font: 14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
      body { padding: 0.35rem 0.15rem; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid rgba(127,127,127,0.35); padding: 0.35rem 0.5rem; text-align: left; }
      img { max-width: 100%; height: auto; }
    </style></head><body>${body}</body></html>`;
  });
</script>

<section class="html-card" aria-label={payload.title || 'HTML card'}>
  {#if payload.title}
    <header class="html-card-header">
      <h3>{payload.title}</h3>
    </header>
  {/if}
  <div class="html-card-frame-wrap">
    <iframe
      class="html-card-frame"
      title={payload.title || 'HTML card'}
      srcdoc={srcdoc}
      sandbox=""
      referrerpolicy="no-referrer"
    ></iframe>
  </div>
</section>

<style>
  .html-card {
    width: var(--inline-block-width);
    max-width: 100%;
    margin-top: 0.65rem;
    padding: 0.75rem 0.85rem 0.85rem;
    border: 0;
    border-radius: var(--artifact-radius);
    background: var(--artifact-surface);
    box-shadow: var(--artifact-elev);
    color: var(--text);
  }

  .html-card-header h3 {
    margin: 0 0 0.55rem;
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--text);
  }

  /*
   * The frame fills the wrap instead of being pinned to 220px. Previously the wrap
   * allowed up to min(48vh, 360px) while the iframe was fixed at 220px under
   * `overflow: hidden`, so a card taller than 220px was cropped with no scrollbar
   * and no indication anything was missing. The iframe's own document scrolls now.
   */
  .html-card-frame-wrap {
    width: 100%;
    height: min(48vh, 360px);
    min-height: 120px;
    border-radius: calc(var(--artifact-radius, 12px) - 4px);
    background: color-mix(in srgb, var(--surface, #fff) 92%, transparent);
  }

  .html-card-frame {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    background: transparent;
  }
</style>
