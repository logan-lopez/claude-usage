/**
 * The explorer's row budget. One rule: a page is the rows its viewport shows, so every `movement()`
 * page size comes from the viewport that key scrolls.
 */
export const MIN_COLUMNS = 80;
export const MIN_ROWS = 24;
/** Header (3 rows) and footer (2 rows) around the content. */
export const CHROME_ROWS = 5;

/** Content height for a terminal of `rows`. */
export const contentHeight = (rows: number) => Math.max(1, rows - CHROME_ROWS);

/** A viewport of `height` shows this many rows; its last row is the position indicator. */
export const visibleRows = (viewportHeight: number) => Math.max(1, viewportHeight - 1);

/** A `SessionTable` of `height` has one header row above its body. */
export const tableBodyRows = (tableHeight: number) => Math.max(1, tableHeight - 1);
