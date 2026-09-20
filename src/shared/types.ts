/**
 * Shared data model for AI Blocker Stickers.
 *
 * PRIVACY INVARIANT: nothing in this file may ever hold the covered text.
 * Only HMACs, lengths, and digit-stripped, truncated context strings are stored.
 * `tests/unit/privacy.test.ts` enforces this over serialized records.
 */

export interface DocRect {
  /** Document-relative coordinates (scrollX/scrollY already added). */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ViewRect {
  /** Viewport-relative coordinates, as returned by getBoundingClientRect(). */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Which kind of label produced `Fingerprint.labelContext`.
 * `label` / `row` / `sibling` name one record; `column` names a whole table
 * column and is therefore worthless for telling two rows apart.
 */
export type LabelSource = 'label' | 'row' | 'column' | 'sibling';

export interface TableContext {
  /** Normalised header text of this cell's column, if any. */
  header?: string;
  colIndex?: number;
  rowIndex?: number;
}

/**
 * Everything we know about an element at placement time, used to find it again
 * after reload, reflow, framework re-render, or navigation.
 */
export interface Fingerprint {
  tag: string;
  /** Only present when the id passes the stability heuristics. */
  id?: string;
  /** data-testid | data-test | data-cy | data-qa */
  testId?: string;
  name?: string;
  type?: string;
  role?: string;
  ariaLabel?: string;
  placeholder?: string;
  /** Up to 5 stable class tokens. */
  classes: string[];
  /** Unique-at-creation CSS path, at most 8 segments. */
  cssPath: string;
  /** Positional XPath from the document root. */
  xpath: string;
  /** Nearest label text: lowercased, digits stripped, <= 40 chars. */
  labelContext?: string;
  /**
   * Where `labelContext` came from. Only `column` is shared by every row of a
   * table, so it is the one source that does NOT identify a record.
   */
  labelSource?: LabelSource;
  /**
   * HMAC of the nearest record key (`data-key`, `data-id`, ...) on the element
   * or one of its first four ancestors. Never the raw value: on real pages the
   * key often *is* the account number.
   */
  keyHmac?: string;
  /** Which attribute `keyHmac` was taken from. */
  keyAttr?: string;
  /** Nearest preceding h1-h4 text, normalised, <= 40 chars. */
  headingContext?: string;
  tableContext?: TableContext;
  /** HMAC-SHA256 (per-install key) of the normalised text. Never the text. */
  textHmac?: string;
  textLen: number;
  /** Layout signature at creation; a weak tie-breaker and the ghost position. */
  rect: DocRect;
  viewportW: number;
  docH: number;
}

export type MaskMode = 'text' | 'input' | 'visual-only';

export type StickerSource = 'manual' | 'selection' | 'context-menu' | 'rect';

export interface StickerScope {
  /** Segment glob: `*` matches one segment, `**` matches the rest. */
  pathPattern: string;
}

export interface StickerFrame {
  /** 0 = top frame. */
  depth: number;
  /** Glob over the frame URL, only set for depth > 0. */
  urlPattern?: string;
}

export interface StickerBase {
  id: string;
  /** User-entered label drawn on the sticker. UI warns to keep it non-sensitive. */
  label?: string;
  scope: StickerScope;
  frame: StickerFrame;
  source: StickerSource;
  /** Extra pixels around the anchor box. */
  padding: number;
  createdAt: number;
  updatedAt: number;
}

export interface ElementSticker extends StickerBase {
  kind: 'element';
  anchor: Fingerprint;
  maskMode: MaskMode;
}

export interface RectFraction {
  fx: number;
  fy: number;
  fw: number;
  fh: number;
}

export interface RectSticker extends StickerBase {
  kind: 'rect';
  /** The deepest element that fully contained the rectangle at draw time. */
  container: Fingerprint;
  /** Rectangle as fractions of the container's box. */
  frac: RectFraction;
  /** Absolute size at draw time, used when the container's aspect ratio drifts. */
  px: { w: number; h: number };
  maskUnderlyingText: boolean;
}

export type Sticker = ElementSticker | RectSticker;

export interface SiteRecord {
  v: 1;
  origin: string;
  enabled: boolean;
  stickers: Sticker[];
  updatedAt: number;
}

export interface KeyCombo {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  /** KeyboardEvent.code, e.g. "Space". Omit for modifier-only combos. */
  code?: string;
}

export interface Settings {
  v: 1;
  peek: {
    single: KeyCombo;
    all: KeyCombo;
    holdDelayMs: number;
    maxHoldMs: number;
  };
  appearance: {
    color: string;
    showLabel: boolean;
  };
  ghostAnchors: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  v: 1,
  peek: {
    single: { ctrl: true, shift: true },
    all: { ctrl: true, shift: true, code: 'Space' },
    holdDelayMs: 150,
    maxHoldMs: 8000,
  },
  appearance: {
    color: '#1f2937',
    showLabel: true,
  },
  ghostAnchors: true,
};

/** Runtime status of one sticker inside a frame. */
export type AnchorStatus = 'resolving' | 'resolved' | 'lost';

export type Confidence = 'high' | 'low';

export interface TabState {
  editMode: boolean;
  paused: boolean;
  stickerCount: number;
  lostCount: number;
  peeking: boolean;
}

export const DEFAULT_TAB_STATE: TabState = {
  editMode: false,
  paused: false,
  stickerCount: 0,
  lostCount: 0,
  peeking: false,
};
