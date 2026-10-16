# Branding

- `icon.svg` — Master icon (vector). Edit this, then re-render the PNGs.
- `icon-1024.png` — App icon master (Expo: `icon` field, 1024×1024)
- `icon-512.png` / `icon-256.png` / `icon-48.png` — web / favicon sizes

## Design

Classic torch on deep navy — the torch stands for the **Kenaz rune (ᚲ)**, the "torch" rune of the Elder Futhark, echoing the name **Kvasir** (Norse god of wisdom). Torch = enlightenment, learning in the dark, focus.

**Colors:**
- Background gradient: `#1c2b4d` → `#0b1226` (navy night)
- Flame: `#dc2626` → `#ea580c` → `#f59e0b` → `#fde68a`
- Wood/handle: `#5c2708` → `#8a4513` → `#c8741f`
- Accent gold: `#fbbf24`

**Re-render PNGs** (resvg via uv):

```bash
for s in 1024 512 256 48; do
  uv tool run --from resvg-cli resvg --width $s --height $s icon.svg icon-$s.png
done
```
