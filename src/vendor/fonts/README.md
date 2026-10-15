# Text-image fonts

The typefaces Compose's **Text to image** cards are set in. They are bundled
so the images render the same on every system without loading fonts from the
network, and are embedded into each card as `data:` URLs when it is drawn.

| Family | npm package | Files | License |
| --- | --- | --- | --- |
| Literata (variable: weight, optical size) | `@fontsource-variable/literata@5.3.0` | `literata-*-opsz-normal.woff2` | SIL OFL 1.1, `LICENSE-literata.txt` |
| Inter (variable: weight, optical size) | `@fontsource-variable/inter@5.3.0` | `inter-*-opsz-normal.woff2` | SIL OFL 1.1, `LICENSE-inter.txt` |
| Bricolage Grotesque (variable: weight, optical size) | `@fontsource-variable/bricolage-grotesque@5.3.0` | `bricolage-grotesque-*-opsz-normal.woff2` | SIL OFL 1.1, `LICENSE-bricolage-grotesque.txt` |
| Instrument Serif | `@fontsource/instrument-serif@5.3.0` | `instrument-serif-*-400-normal.woff2` | SIL OFL 1.1, `LICENSE-instrument-serif.txt` |

The woff2 files are byte-identical to the packages' `files/` directories.
`faces.js` lists each file with its weight range and `unicode-range`, taken
from the packages' CSS. `scripts/vendor-fonts.mjs` regenerates the whole
directory from the pinned versions.
