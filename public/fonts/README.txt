Fonts for the display's "Digits font" setting (Display Appearance), and the
UI font used by /foxy.css.

All are under the SIL Open Font License 1.1 - full text and copyright in the
OFL-*.txt file next to each one.

  barlow-condensed-700.woff2        Barlow Condensed Bold    (Google Fonts, digits subset)
  atkinson-hyperlegible-700.woff2   Atkinson Hyperlegible Bold (Google Fonts, digits subset)
  jetbrains-mono-700.woff2          JetBrains Mono Bold      (Google Fonts, digits subset)
  dseg7-classic-bold.woff2          DSEG7 Classic Bold       (unmodified, npm dseg@0.46.0)
  barlow-semi-condensed-*.woff2     Barlow Semi Condensed 500/600/700 (Google Fonts, Latin) - the UI font

The Google Fonts files only hold 0-9 : + - . and space, which is all the
countdown and clock ever show. Anything else falls back to the system font.
They live here (not on a CDN) so displays work with no internet, including
in Foxy Timer for Windows.
