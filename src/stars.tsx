import { settings } from "./app";
import type { Settings as SettingsType } from "./settings";

/**
 * Format a rating number as a canonical string key.
 * Multiples of 0.5 use one decimal place  → "0.5", "1.0", "2.5"
 * Quarter-step values use two decimal places → "0.25", "1.75", "3.75"
 */
export function toRatingString(rating: number): string {
    if ((rating * 100) % 50 === 0) return rating.toFixed(1);
    return rating.toFixed(2);
}

export type StarData = [HTMLSpanElement, (SVGSVGElement | SVGPathElement)[][], HTMLSpanElement | undefined];

export function getStarDataFromElement(stars: HTMLSpanElement): StarData | null {
    const starElements: (SVGSVGElement | SVGPathElement)[][] = [];
    for (const star of Array.from(stars.querySelectorAll<SVGSVGElement>("svg"))) {
        const tl = star.querySelector<SVGPathElement>('path[id$="-tl"]');
        const bl = star.querySelector<SVGPathElement>('path[id$="-bl"]');
        const tr = star.querySelector<SVGPathElement>('path[id$="-tr"]');
        const br = star.querySelector<SVGPathElement>('path[id$="-br"]');
        if (!tl || !bl || !tr || !br) return null;
        starElements.push([star, tl, bl, tr, br]);
    }
    if (starElements.length !== 5) return null;

    const label = stars.querySelector(".stars-rating-label") as HTMLSpanElement | null;
    return [stars, starElements, label ?? undefined];
}

export function findStars(idSuffix: string): StarData | null {
    const stars = document.getElementById(`stars-${idSuffix}`) as HTMLSpanElement | null;
    return stars ? getStarDataFromElement(stars) : null;
}

function createStar(starsId: string, n: number, size: number) {
    const xmlns = "http://www.w3.org/2000/svg";
    const star = document.createElementNS(xmlns, "svg");
    const id = `${starsId}-${n}`;
    star.id = id;
    star.style.minHeight = `${size}px`;
    star.style.minWidth = `${size}px`;
    star.setAttributeNS(null, "width", `${size}px`);
    star.setAttributeNS(null, "height", `${size}px`);
    star.setAttributeNS(null, "viewBox", `0 0 32 32`);

    const defs = document.createElementNS(xmlns, "defs");
    star.append(defs);

    const starPathD =
        "M20.388,10.918L32,12.118l-8.735,7.749L25.914,31.4l-9.893-6.088L6.127,31.4l2.695-11.533L0,12.118l11.547-1.2L16.026,0.6L20.388,10.918z";

    // Split vertically at x=16 and horizontally at y=16 (in 32×32 viewBox space)
    const quadrants = [
        { name: "tl", x: 0, y: 0, w: 16, h: 16 },
        { name: "bl", x: 0, y: 16, w: 16, h: 16 },
        { name: "tr", x: 16, y: 0, w: 16, h: 16 },
        { name: "br", x: 16, y: 16, w: 16, h: 16 },
    ] as const;

    const paths: SVGPathElement[] = [];

    for (const q of quadrants) {
        const clipId = `${id}-clip-${q.name}`;

        const clipPath = document.createElementNS(xmlns, "clipPath");
        clipPath.id = clipId;

        const rect = document.createElementNS(xmlns, "rect");
        rect.setAttributeNS(null, "x", `${q.x}`);
        rect.setAttributeNS(null, "y", `${q.y}`);
        rect.setAttributeNS(null, "width", `${q.w}`);
        rect.setAttributeNS(null, "height", `${q.h}`);
        clipPath.append(rect);
        defs.append(clipPath);

        const path = document.createElementNS(xmlns, "path");
        path.id = `${id}-${q.name}`;
        path.setAttributeNS(null, "clip-path", `url(#${clipId})`);
        path.setAttributeNS(null, "fill", "var(--spice-button-disabled)");
        path.setAttributeNS(null, "d", starPathD);
        star.append(path);
        paths.push(path);
    }

    // paths order: [tl, bl, tr, br]
    return [star, paths[0], paths[1], paths[2], paths[3]] as const;
}

export function createStars(trackURI: string, size: number): StarData {
    const stars = document.createElement("span");
    const id = `stars-${trackURI}`;
    stars.className = "stars";
    stars.id = id;
    stars.style.whiteSpace = "nowrap";
    stars.style.alignItems = "center";
    stars.style.display = "flex";

    const starElements = [];
    for (let i = 0; i < 5; i++) {
        const [star, tl, bl, tr, br] = createStar(id, i + 1, size);
        stars.append(star);
        starElements.push([star, tl, bl, tr, br]);
    }

    let label: HTMLSpanElement | undefined = undefined;
    if (settings?.showExactRating) {
        label = document.createElement("span");
        label.className = "stars-rating-label";
        label.style.marginLeft = "6px";
        label.style.fontSize = "0.9em";
        label.style.opacity = "0.9";
        stars.append(label);
    }

    return [stars, starElements, label];
}

type StarDisplayOptions = {
    // Album averages are calculated to quarter-star precision even when song
    // rating input is configured for whole or half stars.
    forceQuarterStars?: boolean;
};

export function setRating(
    starElements: (SVGSVGElement | SVGPathElement)[][],
    rating: number | null,
    label?: HTMLElement,
    options: StarDisplayOptions = {},
) {
    const normalizedRating = typeof rating === "number" && Number.isFinite(rating) ? rating : 0;
    if (settings?.showExactRating && label) label.textContent = rating !== null && Number.isFinite(rating) ? rating.toFixed(2) : "";

    const totalQUnits = Math.round(normalizedRating * 4);

    const on = "var(--spice-button)";
    const off = "var(--spice-button-disabled)";

    for (let i = 0; i < 5; i++) {
        const [, tlPath, blPath, trPath, brPath] = starElements[i];
        const starBase = i * 4;

        // Quarter-units filled within this individual star (0–4)
        const filled = Math.max(0, Math.min(4, totalQUnits - starBase));

        if (options.forceQuarterStars || settings?.quarterStarRatings) {
            // Fill order: BL → TL → TR → BR
            (blPath as SVGPathElement).setAttributeNS(null, "fill", filled >= 1 ? on : off);
            (tlPath as SVGPathElement).setAttributeNS(null, "fill", filled >= 2 ? on : off);
            (trPath as SVGPathElement).setAttributeNS(null, "fill", filled >= 3 ? on : off);
            (brPath as SVGPathElement).setAttributeNS(null, "fill", filled >= 4 ? on : off);
        } else if (settings?.halfStarRatings) {
            // Left half = TL+BL, right half = TR+BR
            // Snap filled to nearest even count (i.e. nearest half-star boundary)
            const halfFilled = Math.round(filled / 2);
            (tlPath as SVGPathElement).setAttributeNS(null, "fill", halfFilled >= 1 ? on : off);
            (blPath as SVGPathElement).setAttributeNS(null, "fill", halfFilled >= 1 ? on : off);
            (trPath as SVGPathElement).setAttributeNS(null, "fill", halfFilled >= 2 ? on : off);
            (brPath as SVGPathElement).setAttributeNS(null, "fill", halfFilled >= 2 ? on : off);
        } else {
            // Whole stars
            const isLit = i < Math.round(normalizedRating);
            (tlPath as SVGPathElement).setAttributeNS(null, "fill", isLit ? on : off);
            (blPath as SVGPathElement).setAttributeNS(null, "fill", isLit ? on : off);
            (trPath as SVGPathElement).setAttributeNS(null, "fill", isLit ? on : off);
            (brPath as SVGPathElement).setAttributeNS(null, "fill", isLit ? on : off);
        }
    }
}

export function getMouseoverRating(
    settings: Pick<SettingsType, "quarterStarRatings" | "halfStarRatings">,
    star: Element,
    i: number,
    mouseEvent: MouseEvent,
): number {
    const rect = star.getBoundingClientRect();
    const offsetX = mouseEvent.clientX - rect.left;
    const offsetY = mouseEvent.clientY - rect.top;

    const isRight = offsetX > rect.width / 2;
    const isTop = offsetY < rect.height / 2;

    if (settings.quarterStarRatings) {
        // Very left edge of the first star → 0 stars
        if (i === 0 && offsetX < 3) return 0;

        // Quadrant → rating offset within star
        // BL = +0.25, TL = +0.50, TR = +0.75, BR = +1.00
        if (!isRight && !isTop) return i + 0.25; // BL
        if (!isRight && isTop) return i + 0.5; // TL
        if (isRight && isTop) return i + 0.75; // TR
        return i + 1.0; // BR
    } else {
        const half = isRight || !settings.halfStarRatings;
        const zeroStars = i === 0 && offsetX < 3;
        let rating = i + 1;
        if (!half) rating -= 0.5;
        if (zeroStars) {
            rating -= settings.halfStarRatings ? 0.5 : 1.0;
        }
        return rating;
    }
}
