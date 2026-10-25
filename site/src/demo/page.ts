/**
 * The fictional page the demo captures ("Fernhill", a made-up notes app), pre-rendered by
 * site/scripts/render-demo-page.mjs in a desktop and a phone layout.
 */
import data from './pageData.json';

export type LayoutName = 'desktop' | 'mobile';
export type TargetName =
  | 'plusPrice'
  | 'tablePrice'
  | 'refund'
  | 'teamButton'
  | 'teamCard'
  | 'teamPrice'
  | 'plusBilled'
  | 'plusOffline'
  | 'plusButton';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageLayout {
  name: LayoutName;
  /** Absolute URL of the full-page image. */
  src: string;
  /** The top of the page alone: what the window shows first, while the full image loads. */
  poster: string;
  dpr: number;
  /** Page size, CSS px. */
  css: { w: number; h: number };
  /** Where the hints point, page CSS px. */
  targets: Readonly<Record<TargetName, Box>>;
  url: string;
  title: string;
}

export const PAGE_URL = 'https://fernhill.notes/pricing';
export const PAGE_HOST = 'fernhill.notes';
export const PAGE_TITLE = 'Plans and pricing · Fernhill';

/** Frames narrower than this show the phone layout of the page. */
export const PHONE_MAX_FRAME_W = 600;

export function pageLayout(name: LayoutName): PageLayout {
  const l = data.layouts[name];
  return {
    name,
    src: `${import.meta.env.BASE_URL}${l.src}`,
    poster: `${import.meta.env.BASE_URL}${l.poster.src}`,
    dpr: data.dpr,
    css: l.css,
    targets: l.targets as Record<TargetName, Box>,
    url: PAGE_URL,
    title: PAGE_TITLE,
  };
}
