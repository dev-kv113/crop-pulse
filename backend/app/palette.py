"""Legend colours and labels for analysis classes.

Canopy density is a *sequential* quantity -- one number, low to high -- so the
ramp runs light to dark without a break. Reading "more" as "darker" needs no
legend lookup, and the eight steps stay distinguishable because each one is a
different hue as well as a different lightness.

The ramp is anchored to the GEOtrans brand: it starts at the wordmark's amber
and ends at its navy, travelling through orange, coral and magenta so that no
step washes out to grey. Lightness falls strictly from OKLCH 0.874 to 0.236,
which is what makes the order readable at a glance.

Amber-to-navy also keeps the layer legible over satellite imagery, where a green
ramp would disappear into the fields it is describing.
"""

import re

# Category 1 (lowest density) -> Category 8 (highest density).
GEOTRANS_DENSITY_8 = [
    "#ffce60",
    "#ff9a42",
    "#ff6652",
    "#e23b6e",
    "#b02282",
    "#781b85",
    "#431872",
    "#16124e",
]

# The brand colours themselves, for anything that needs them directly.
BRAND_AMBER = "#f5a81b"
BRAND_NAVY = "#1e1a5f"


def colors_for(class_count: int) -> list[str]:
    """`class_count` evenly spaced colours from the ramp.

    Uploads are expected to have eight classes, but a future file might not, so
    we sample the ramp rather than assume its length.
    """
    if class_count <= 0:
        return []
    if class_count == 1:
        return [GEOTRANS_DENSITY_8[-1]]
    last = len(GEOTRANS_DENSITY_8) - 1
    return [
        GEOTRANS_DENSITY_8[round(i * last / (class_count - 1))]
        for i in range(class_count)
    ]


def short_label(position: int) -> str:
    """The name shown in the legend.

    Deliberately neutral. The source data gives a density range per class but no
    agronomic interpretation, so the app numbers the bands rather than claiming
    that a given range means "good" or "poor". Swap these for real condition
    names once the density bands have been ground-truthed.
    """
    return f"Category {position + 1}"


def range_detail(class_name: str) -> str | None:
    """Pull the numeric band out of a source class name, for the legend's second line.

    Source names look like "Density slice range 0.3346 to 0.4183". Showing
    "0.33 - 0.42" beside "Category 5" keeps the underlying number visible
    without putting a full sentence on a phone screen.
    """
    numbers = re.findall(r"\d+\.\d+", class_name or "")
    if len(numbers) < 2:
        return None
    return f"{float(numbers[0]):.2f} – {float(numbers[1]):.2f}"
