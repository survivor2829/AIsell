"""Generate SVG thumbnails for each theme based on themes.json"""
import json
from pathlib import Path

THEMES_DIR = Path(__file__).parent / "static" / "themes"

def hex_from_var(val):
    """Extract a usable color from a CSS variable value."""
    if val.startswith("linear-gradient"):
        # Extract first color from gradient
        import re
        colors = re.findall(r'#[0-9A-Fa-f]{6}', val)
        return colors[0] if colors else "#888888"
    if val.startswith("rgba"):
        import re
        m = re.match(r'rgba\((\d+),\s*(\d+),\s*(\d+)', val)
        if m:
            r, g, b = int(m.group(1)), int(m.group(2)), int(m.group(3))
            return f"#{r:02x}{g:02x}{b:02x}"
    return val

def generate_svg(theme):
    primary = hex_from_var(theme["vars"]["--theme-primary"])
    primary_dark = hex_from_var(theme["vars"]["--theme-primary-dark"])
    bg_dark = hex_from_var(theme["vars"]["--theme-bg-dark"])
    bg_section = hex_from_var(theme["vars"]["--theme-bg-section"])
    text_on_primary = hex_from_var(theme["vars"]["--theme-text-on-primary"])

    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160" viewBox="0 0 120 160">
  <defs>
    <linearGradient id="hero_{theme['id']}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="{primary}"/>
      <stop offset="100%" stop-color="{primary_dark}"/>
    </linearGradient>
    <clipPath id="clip_{theme['id']}">
      <rect x="4" y="4" width="112" height="152" rx="8"/>
    </clipPath>
  </defs>
  <!-- Card outline -->
  <rect x="4" y="4" width="112" height="152" rx="8" fill="{bg_section}" stroke="#E0E0E0" stroke-width="1"/>
  <g clip-path="url(#clip_{theme['id']})">
    <!-- Hero area -->
    <rect x="4" y="4" width="112" height="50" fill="url(#hero_{theme['id']})"/>
    <!-- Hero text lines -->
    <rect x="16" y="18" width="48" height="5" rx="2" fill="{text_on_primary}" opacity="0.9"/>
    <rect x="16" y="28" width="36" height="4" rx="2" fill="{text_on_primary}" opacity="0.5"/>
    <!-- Content area -->
    <rect x="4" y="54" width="112" height="62" fill="#FFFFFF"/>
    <!-- Content blocks -->
    <rect x="14" y="62" width="92" height="6" rx="2" fill="#D0D0D0"/>
    <rect x="14" y="74" width="40" height="28" rx="4" fill="{bg_section}"/>
    <rect x="62" y="74" width="44" height="28" rx="4" fill="{bg_section}"/>
    <!-- Accent dots -->
    <circle cx="26" cy="82" r="3" fill="{primary}" opacity="0.7"/>
    <circle cx="74" cy="82" r="3" fill="{primary}" opacity="0.7"/>
    <rect x="14" y="108" width="60" height="4" rx="2" fill="#D0D0D0"/>
    <!-- CTA area -->
    <rect x="4" y="116" width="112" height="40" fill="{bg_dark}"/>
    <!-- CTA button -->
    <rect x="24" y="128" width="72" height="16" rx="8" fill="{primary}"/>
    <rect x="40" y="134" width="40" height="4" rx="2" fill="{text_on_primary}" opacity="0.9"/>
  </g>
</svg>'''
    return svg

def main():
    with open(THEMES_DIR / "themes.json", "r", encoding="utf-8") as f:
        data = json.load(f)

    for theme in data["themes"]:
        svg_content = generate_svg(theme)
        svg_path = THEMES_DIR / theme["thumbnail"]
        with open(svg_path, "w", encoding="utf-8") as f:
            f.write(svg_content)
        print(f"Generated: {svg_path.name}")

    print(f"\nDone! {len(data['themes'])} thumbnails generated.")

if __name__ == "__main__":
    main()
