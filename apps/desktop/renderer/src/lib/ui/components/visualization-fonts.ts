import inter from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?inline';
import hyperlegible from '@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-normal.woff2?inline';
import hyperlegibleBold from '@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-normal.woff2?inline';

/** Embedded OFL fonts work inside the offline widget sandbox and exported SVGs. */
export function visualizationFonts(family: string): string {
  if (family.includes('Atkinson')) return `@font-face{font-family:'Atkinson Hyperlegible';font-style:normal;font-weight:400;src:url('${hyperlegible}') format('woff2')}@font-face{font-family:'Atkinson Hyperlegible';font-style:normal;font-weight:700;src:url('${hyperlegibleBold}') format('woff2')}`;
  if (!family.includes('Inter')) return '';
  return `@font-face{font-family:'Inter Variable';font-style:normal;font-weight:100 900;src:url('${inter}') format('woff2')}`;
}
