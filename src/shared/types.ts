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
  /**
   * Only present when the id passes the stability heuristics AND reads like
   * an identifier (`^[A-Za-z_][\w-]{0,40}$`, no run of 4+ digits). A stable id
   * that fails the second test is stored as `idHmac` instead.
   */
  id?: string;
  /** HMAC (per-install key, exact value) of a stable but non-identifier id. */
  idHmac?: string;
  /** data-testid | data-test | data-cy | data-qa, identifier-like values only. */
  testId?: string;
  /** HMAC of a test id that is not identifier-like. */
  testIdHmac?: string;
  /** Identifier-like `name` attribute. */
  name?: string;
  /** HMAC of a `name` attribute that is not identifier-like. */
  nameHmac?: string;
  /** Keyword-shaped values only. */
  type?: string;
  role?: string;
  /** Normalised like `labelContext`: lowercased, digits and punctuation stripped, <= 40 chars. */
  ariaLabel?: string;
  /** Normalised like `labelContext`. */
  placeholder?: string;

  /** Up to 5 stable class tokens. */
  classes: string[];
  /** Unique-at-creation CSS path, at most 8 segments. */
  cssPath: string;
  /** Positional XPath from the document root. */
  xpath: string;
  /**
   * For an element inside shadow trees: the CSS path of each shadow host,
   * outermost first, each relative to the tree that holds it. `cssPath` is
   * then relative to the innermost shadow root.
   */
  hostPath?: string[];
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

/**
 * How a sticker was placed. `suggest`: the user covered an auto-suggest
 * suggestion. `session-auto`: covered automatically while the tab was locked;
 * kept in memory only, unless the user keeps it when the AI session ends.
 * `backstop`: covered automatically, in memory only, while another sticker
 * on the page is lost (a moved copy of its text or of its kind of number).
 */
export type StickerSource = 'manual' | 'selection' | 'context-menu' | 'rect' | 'suggest' | 'session-auto' | 'backstop';

/**
 * `pattern`: `pathPattern` is matched as a glob (record ids generalised).
 * `exact`: this page only, matched by `pathHmac`; `pathPattern` is then only
 * the sanitised display form and is never used for matching.
 */
export type ScopeKind = 'pattern' | 'exact';

export interface StickerScope {
  /** Absent on stickers stored before exact scopes existed: treated as `pattern`. */
  kind?: ScopeKind;
  /**
   * Segment glob: `*` matches one segment, `**` matches the rest. Always
   * sanitised (no record or document id), for `exact` scopes too.
   */
  pathPattern: string;
  /**
   * `exact` only: HMAC (per-install key) of the normalised pathname, plus
   * the search string when `includeQuery`. Never the raw path.
   */
  pathHmac?: string;
  includeQuery?: boolean;
  /**
   * In-page viewer identity (content/state/view.ts). Set when the sticker was
   * placed inside an overlay viewer (a Drive file preview) whose URL is the
   * page behind it: HMAC (per-install key) of the first `viewLen` characters
   * of the viewer's document text, whitespace removed. The sticker is active
   * only while a viewer whose text hashes the same is open. Never the text.
   */
  viewHmac?: string;
  /** Characters hashed into `viewHmac` (at most VIEW_TEXT_MAX). */
  viewLen?: number;
}

export interface StickerFrame {
  /** 0 = top frame. */
  depth: number;
  /** Glob over the frame URL (origin + sanitised path), only set for depth > 0. */
  urlPattern?: string;
  /**
   * HMAC of the frame's origin + normalised path, set instead of `urlPattern`
   * when the frame URL names a document (a Drive preview): the sticker then
   * applies in that one frame document only.
   */
  urlHmac?: string;
}

export function scopeKindOf(scope: StickerScope): ScopeKind {
  return scope.kind === 'exact' ? 'exact' : 'pattern';
}

export interface StickerBase {
  id: string;
  /** User-entered label drawn on the sticker. UI warns to keep it non-sensitive. */
  label?: string;
  scope: StickerScope;
  frame: StickerFrame;
  source: StickerSource;
  /**
   * The high-strength pattern the covered text matched at creation, if any.
   * Only the detector's name is stored, never the text.
   */
  detector?: BackstopDetector;
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

/**
 * How `RectSticker.container` was picked. `block` is the nearest block-level
 * ancestor of the text under the rectangle (a paragraph, a table cell): its box
 * is settled as soon as its own lines are, so the fractions project to the same
 * place on reload. `hit` is the legacy fallback — the deepest element that
 * fully contained the rectangle, which on prose is often a page-level wrapper.
 */
export type RectContainerKind = 'block' | 'hit';

export interface RectSticker extends StickerBase {
  kind: 'rect';
  /** The element the fractions are relative to; see `containerKind`. */
  container: Fingerprint;
  /** Which rule chose `container`. Absent on stickers stored before this existed. */
  containerKind?: RectContainerKind;
  /** Rectangle as fractions of the container's box. */
  frac: RectFraction;
  /** Absolute size at draw time, used when the container's aspect ratio drifts. */
  px: { w: number; h: number };
  maskUnderlyingText: boolean;
  /**
   * The text the rectangle covered at creation (content/anchor/text-anchor.ts).
   * Absent when it covered no text (an image, a canvas) and on stickers stored
   * before this existed: those follow the container fractions only.
   */
  text?: RectText;
  /**
   * The deepest element holding all the covered text, when that is not the
   * container itself (a labelled `<span>` inside a paragraph). Resolved when
   * the container cannot be: its label can name the field when the
   * container's own text has changed (the same view showing another record).
   */
  inner?: Fingerprint;
}

/**
 * Text anchor of a rect sticker. Only HMACs and layout numbers: the covered
 * characters are found again by hashing candidate windows of `len`.
 */
export interface RectText {
  /** HMAC (per-install key) of the covered characters, whitespace removed. Never the text. */
  coverHmac: string;
  /** Number of covered characters, whitespace removed. */
  len: number;
  /** HMAC of every covered token (lowercased), for the lost-sticker backstop. */
  tokenHmacs: string[];
  /**
   * Pixels between the covered text's box and the drawn rectangle, at line
   * height `lh`. The sticker is drawn around wherever the text is now, grown
   * by these margins (scaled by the current line height over `lh`).
   */
  margin: { l: number; t: number; r: number; b: number };
  lh: number;
}

/**
 * The high-strength detector the covered text matched at creation
 * (content/detect/patterns.ts). Lets a lost sticker's pattern backstop cover
 * a moved copy of the same kind of number. Never the text.
 */
export type BackstopDetector = 'ssn' | 'itin' | 'card' | 'iban' | 'maskedLast4';

export type Sticker = ElementSticker | RectSticker;

export interface SiteRecord {
  v: 1;
  origin: string;
  enabled: boolean;
  stickers: Sticker[];
  updatedAt: number;
  /** Auto-suggest on this site. Absent: `Settings.scanDefault`. */
  scanEnabled?: boolean;
  /**
   * Suggestions the user dismissed on this site, as HMACs (per-install key)
   * of pattern + element path + label. Never the matched text.
   */
  dismissedSuggestions?: string[];
  /** Detectors the user taught for this site only (`scope: 'site'`). */
  customDetectors?: CustomDetector[];
}

/**
 * A user-defined detector ("teach a pattern"). Only the derived SHAPE is
 * stored: a regular expression source, label keywords, a name and a scope.
 * Never the example it was derived from (content/detect/derive.ts).
 */
export type DetectorSource = 'example' | 'catalog' | 'template' | 'regex';
export type DetectorStrength = 'high' | 'medium' | 'low';

export interface CustomDetector {
  id: string;
  name: string;
  source: DetectorSource;
  /** Regular expression source (checked by content/detect/template.ts `checkRegex`). */
  regex: string;
  /** `i` and/or `u`; `g` is added at run time. */
  flags?: string;
  /** Normalised label keywords (lowercase words, no digits). */
  labels: string[];
  strength: DetectorStrength;
  scope: 'site' | 'global';
  /** Site-scoped detectors: the origin they belong to. */
  origin?: string;
  createdAt: number;
}

/** Per store (the global list in Settings, each site's list): at most this many. */
export const MAX_CUSTOM_DETECTORS = 50;
export const DETECTOR_NAME_MAX = 40;
const DETECTOR_REGEX_MAX = 200;

/**
 * Structural clean-up of a stored detector list: known fields only, bounded
 * sizes, newest `MAX_CUSTOM_DETECTORS` kept. Regex safety is checked where the
 * regex is compiled (content/detect/custom.ts), not here.
 */
export function cleanDetectors(list: unknown, scope: 'site' | 'global'): CustomDetector[] {
  if (!Array.isArray(list)) return [];
  const out: CustomDetector[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const d = raw as Partial<CustomDetector>;
    if (typeof d.id !== 'string' || !/^[\w-]{1,64}$/.test(d.id) || seen.has(d.id)) continue;
    if (typeof d.regex !== 'string' || !d.regex || d.regex.length > DETECTOR_REGEX_MAX) continue;
    const flags = typeof d.flags === 'string' && /^[iu]{0,2}$/.test(d.flags) ? d.flags : undefined;
    const strength: DetectorStrength = d.strength === 'high' || d.strength === 'medium' ? d.strength : 'low';
    const source: DetectorSource = d.source === 'catalog' || d.source === 'template' || d.source === 'regex' ? d.source : 'example';
    const labels = (Array.isArray(d.labels) ? d.labels : [])
      .filter((l): l is string => typeof l === 'string')
      .map((l) => l.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40))
      .filter(Boolean)
      .slice(0, 8);
    const name = (typeof d.name === 'string' ? d.name : '').replace(/\s+/g, ' ').trim().slice(0, DETECTOR_NAME_MAX) || 'Custom pattern';
    seen.add(d.id);
    out.push({
      id: d.id,
      name,
      source,
      regex: d.regex,
      ...(flags ? { flags } : {}),
      labels,
      strength,
      scope,
      ...(scope === 'site' && typeof d.origin === 'string' ? { origin: d.origin } : {}),
      createdAt: typeof d.createdAt === 'number' && Number.isFinite(d.createdAt) ? d.createdAt : 0,
    });
  }
  return out.length > MAX_CUSTOM_DETECTORS ? out.slice(out.length - MAX_CUSTOM_DETECTORS) : out;
}

/** Auto-suggest sensitivity (see `accepts` in content/detect/patterns.ts). */
export type ScanSensitivity = 'labeled-only' | 'balanced' | 'aggressive';
export const SCAN_SENSITIVITIES: readonly ScanSensitivity[] = ['labeled-only', 'balanced', 'aggressive'];

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
  /**
   * Strict input masking: a covered text field's live `.value` holds bullets
   * and the real value is handed back only to FormData / form submission.
   * `locked` (default): only while the AI-session lock is on.
   */
  strictInputs: StrictInputsMode;
  /** Auto-suggest on sites that have no per-site choice yet. */
  scanDefault: boolean;
  scanSensitivity: ScanSensitivity;
  /** Detectors the user taught for every site (`scope: 'global'`). */
  customDetectors?: CustomDetector[];
  /** Catalogue toggles by entry id (content/detect/catalog.ts); absent: the entry's default. */
  catalog?: Record<string, boolean>;
}

export type StrictInputsMode = 'locked' | 'always' | 'never';
export const STRICT_INPUTS_MODES: readonly StrictInputsMode[] = ['locked', 'always', 'never'];

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
  strictInputs: 'locked',
  scanDefault: true,
  scanSensitivity: 'balanced',
};

/** Fill in defaults and drop unknown values from a stored (possibly partial or stale) settings object. */
export function normalizeSettings(s: Partial<Settings> | undefined | null): Settings {
  const src = s && typeof s === 'object' ? s : {};
  return {
    ...DEFAULT_SETTINGS,
    ...src,
    peek: { ...DEFAULT_SETTINGS.peek, ...(src.peek ?? {}) },
    appearance: { ...DEFAULT_SETTINGS.appearance, ...(src.appearance ?? {}) },
    strictInputs: STRICT_INPUTS_MODES.includes(src.strictInputs as StrictInputsMode)
      ? (src.strictInputs as StrictInputsMode)
      : DEFAULT_SETTINGS.strictInputs,
    scanDefault: typeof src.scanDefault === 'boolean' ? src.scanDefault : DEFAULT_SETTINGS.scanDefault,
    scanSensitivity: SCAN_SENSITIVITIES.includes(src.scanSensitivity as ScanSensitivity)
      ? (src.scanSensitivity as ScanSensitivity)
      : DEFAULT_SETTINGS.scanSensitivity,
    customDetectors: cleanDetectors(src.customDetectors, 'global'),
    catalog: cleanCatalog(src.catalog),
  };
}

function cleanCatalog(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (/^[a-z0-9-]{1,40}$/.test(k) && typeof v === 'boolean') out[k] = v;
  }
  return out;
}

import type { LockReason } from './lock';

/** Runtime status of one sticker inside a frame. */
export type AnchorStatus = 'resolving' | 'resolved' | 'lost';

export type Confidence = 'high' | 'low';

export interface TabState {
  editMode: boolean;
  paused: boolean;
  stickerCount: number;
  lostCount: number;
  peeking: boolean;
  /** The last save could not persist every sticker on this site (see SiteStore.flush). */
  saveError: boolean;
  /** AI-session lock: peek, pause, delete and the edit tools are refused. */
  locked: boolean;
  lockReason?: LockReason;
  /** Covered text fields whose `.value` currently holds bullets (strict input masking). */
  strictInputs?: number;
  /** Auto-suggest suggestions waiting on this page (unlocked only). */
  suggestionCount?: number;
  /** Stickers covered automatically during this lock, not yet kept or discarded. */
  autoCount?: number;
  /**
   * How the page draws its content (content/detect/canvas-detect.ts). On
   * 'canvas' pages the text is pixels: suggestions and Cover element cannot
   * see it, and only Draw rectangle helps.
   */
  rendering: RenderingMode;
  /**
   * Stickers that apply to this URL but belong to an in-page viewer that is
   * not open (another document's preview, or none). Not tracked or drawn.
   */
  otherViews?: number;
}

export type RenderingMode = 'dom' | 'canvas' | 'mixed';

export const DEFAULT_TAB_STATE: TabState = {
  editMode: false,
  paused: false,
  stickerCount: 0,
  lostCount: 0,
  peeking: false,
  saveError: false,
  locked: false,
  rendering: 'dom',
};
