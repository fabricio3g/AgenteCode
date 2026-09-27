// Agent browser screen sizes, shared by the main-process panel and the
// renderer's picker. `fit` renders at the panel's own width (responsive, no
// emulation); the others render at their real size, scaled to fit the panel.

export type BrowserViewportPreset = 'fit' | 'desktop' | 'laptop' | 'tablet' | 'mobile';

export interface BrowserViewport {
  width: number;
  height: number;
  mobile: boolean;
  label: string;
}

export const BROWSER_VIEWPORTS: Record<Exclude<BrowserViewportPreset, 'fit'>, BrowserViewport> = {
  desktop: { width: 1280, height: 720, mobile: false, label: 'Desktop' },
  laptop: { width: 1440, height: 900, mobile: false, label: 'Laptop' },
  tablet: { width: 834, height: 1112, mobile: true, label: 'Tablet' },
  mobile: { width: 390, height: 844, mobile: true, label: 'Mobile' }
};
