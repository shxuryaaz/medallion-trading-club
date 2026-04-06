/** Default panel symbols — merged with scalp engine watchlist on the server. */
export const DEFAULT_WATCHLIST_PANEL_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "STOUSDT",
  "USDCUSDT",
] as const;

export type WatchlistPanelSymbol = (typeof DEFAULT_WATCHLIST_PANEL_SYMBOLS)[number];
