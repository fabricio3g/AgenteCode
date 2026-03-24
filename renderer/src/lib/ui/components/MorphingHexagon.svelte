<svelte:options runes={true} />

<script lang="ts">
  interface Props {
    size?: number;
  }

  let { size = 18 }: Props = $props();
</script>

<div class="morph-icon" style="width:{size}px;height:{size}px;">
  <svg viewBox="0 0 24 24" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="morph-glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="0.6" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <linearGradient id="morph-stroke" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="var(--primary)" />
        <stop offset="50%" stop-color="var(--primary-fg)" />
        <stop offset="100%" stop-color="var(--primary)" />
      </linearGradient>
    </defs>

    <g filter="url(#morph-glow)">
      <polygon
        fill="none"
        stroke="var(--primary)"
        stroke-width="1.6"
        stroke-linejoin="round"
        stroke-dasharray="8 3"
        stroke-dashoffset="0"
        points="12,2 22,7 22,17 12,22 2,17 2,7"
      >
        <animate attributeName="points" dur="2.4s" repeatCount="indefinite"
          values="12,2 22,7 22,17 12,22 2,17 2,7;
                  12,3 21,8.5 18,18 6,20.5 1,12 7,4;
                  12,4 20,10 20,19 12,22 4,19 4,10;
                  12,2 22,7 22,17 12,22 2,17 2,7" />
        <animate attributeName="stroke-dashoffset" dur="1.2s" repeatCount="indefinite" from="0" to="22" />
      </polygon>

      <polygon
        fill="color-mix(in srgb, var(--primary) 6%, transparent)"
        stroke="none"
        points="12,5 19,8.5 19,15.5 12,19 5,15.5 5,8.5"
      >
        <animate attributeName="points" dur="2.4s" repeatCount="indefinite"
          values="12,5 19,8.5 19,15.5 12,19 5,15.5 5,8.5;
                  12,6.5 18,10 16,16.5 8,17.5 4,12 7.5,7;
                  12,7 17,11.5 17,17.5 12,19.5 7,17.5 7,11.5;
                  12,5 19,8.5 19,15.5 12,19 5,15.5 5,8.5" />
        <animate attributeName="fill-opacity" dur="1.5s" repeatCount="indefinite"
          values="0.12;0.22;0.12" />
      </polygon>

      <circle cx="12" cy="12" r="1.2" fill="var(--primary)" opacity="0.6">
        <animate attributeName="r" dur="1.8s" repeatCount="indefinite" values="1.2;1.8;1.2" />
        <animate attributeName="opacity" dur="1.8s" repeatCount="indefinite" values="0.6;1;0.6" />
      </circle>
    </g>
  </svg>
</div>

<style>
  .morph-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    animation: morph-spin 6s linear infinite;
    transform-origin: center;
  }

  @keyframes morph-spin {
    0%   { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
</style>
