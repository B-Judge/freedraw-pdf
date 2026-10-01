/**
 * Placement of an annotation overlay image on an existing PDF page.
 *
 * Annotations are stored in normalized coordinates of the page as it is
 * displayed: the crop box, turned by the page's /Rotate value. The overlay is
 * rendered in that displayed orientation and must be drawn into the page's
 * unrotated user space so that, once a viewer applies /Rotate, it lines up
 * with the page again.
 */

export interface PdfBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface OverlayPlacement {
	/** Size of the overlay as displayed, in points (width/height swap for 90 and 270). */
	displayWidthPt: number;
	displayHeightPt: number;
	/** Arguments for drawing the overlay image in unrotated page space. */
	x: number;
	y: number;
	width: number;
	height: number;
	/** Counterclockwise rotation, in degrees, applied around (x, y). */
	rotateDegrees: number;
}

export function normalizePageRotation(angle: number): 0 | 90 | 180 | 270 {
	const normalized = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
	return normalized as 0 | 90 | 180 | 270;
}

export function getOverlayPlacement(cropBox: PdfBox, rotation: number): OverlayPlacement {
	const angle = normalizePageRotation(rotation);
	const { x, y, width, height } = cropBox;
	switch (angle) {
		case 90:
			// Displayed clockwise by 90: draw rotated counterclockwise by 90.
			return { displayWidthPt: height, displayHeightPt: width, x: x + width, y, width: height, height: width, rotateDegrees: 90 };
		case 180:
			return { displayWidthPt: width, displayHeightPt: height, x: x + width, y: y + height, width, height, rotateDegrees: 180 };
		case 270:
			return { displayWidthPt: height, displayHeightPt: width, x, y: y + height, width: height, height: width, rotateDegrees: 270 };
		case 0:
		default:
			return { displayWidthPt: width, displayHeightPt: height, x, y, width, height, rotateDegrees: 0 };
	}
}

/**
 * Pixel size for rendering an overlay so ink stays crisp when zoomed, while
 * bounding memory on very large pages.
 */
export function getOverlayPixelSize(displayWidthPt: number, displayHeightPt: number, pixelsPerPoint = 2.5, maxDimensionPx = 3200): { widthPx: number; heightPx: number } {
	const safeWidth = Math.max(displayWidthPt, 1);
	const safeHeight = Math.max(displayHeightPt, 1);
	const scale = Math.min(pixelsPerPoint, maxDimensionPx / Math.max(safeWidth, safeHeight));
	return {
		widthPx: Math.max(1, Math.round(safeWidth * scale)),
		heightPx: Math.max(1, Math.round(safeHeight * scale))
	};
}
