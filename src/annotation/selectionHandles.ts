import type { ResizeHandle } from "../types";

export interface SelectionHandleBounds {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

export interface SelectionHandlePoint {
	handle: ResizeHandle;
	x: number;
	y: number;
}

export interface SelectionHandleHitOptions {
	/** Rendered page size in CSS pixels; bounds and points are normalized to it. */
	pageWidth: number;
	pageHeight: number;
	/**
	 * Hit radius around the drawn handle bubble, in CSS pixels. Used when the
	 * pointer is inside the selection, where anything off a bubble is a drag.
	 */
	bubbleHitRadiusPx: number;
	/**
	 * Larger hit radius, in CSS pixels, used when the pointer is outside the
	 * selection, so handles stay easy to grab from beyond the box.
	 */
	outsideHitRadiusPx: number;
}

export function getSelectionHandlePoints(bounds: SelectionHandleBounds): SelectionHandlePoint[] {
	const midX = (bounds.left + bounds.right) / 2;
	const midY = (bounds.top + bounds.bottom) / 2;
	return [
		{ handle: "nw", x: bounds.left, y: bounds.top },
		{ handle: "n", x: midX, y: bounds.top },
		{ handle: "ne", x: bounds.right, y: bounds.top },
		{ handle: "e", x: bounds.right, y: midY },
		{ handle: "se", x: bounds.right, y: bounds.bottom },
		{ handle: "s", x: midX, y: bounds.bottom },
		{ handle: "sw", x: bounds.left, y: bounds.bottom },
		{ handle: "w", x: bounds.left, y: midY }
	];
}

/**
 * Decides whether a press on a selection starts a resize, and on which handle.
 *
 * Inside the selection box a press resizes only when it lands on a handle
 * bubble; everywhere else inside is a drag. A single generous radius used to
 * apply everywhere, and on a small selection (a word or a short line of
 * handwriting) it covered the whole box, so the selection could not be moved.
 * Outside the box the generous radius still applies. Distances are measured
 * in CSS pixels, and the nearest handle wins when bubbles overlap.
 */
export function resolveSelectionHandleHit(
	bounds: SelectionHandleBounds,
	point: { x: number; y: number },
	options: SelectionHandleHitOptions
): ResizeHandle | null {
	const width = Math.max(options.pageWidth, 1);
	const height = Math.max(options.pageHeight, 1);
	let nearest: { handle: ResizeHandle; distance: number } | null = null;
	for (const handlePoint of getSelectionHandlePoints(bounds)) {
		const distance = Math.hypot((point.x - handlePoint.x) * width, (point.y - handlePoint.y) * height);
		if (!nearest || distance < nearest.distance) {
			nearest = { handle: handlePoint.handle, distance };
		}
	}
	if (!nearest) {
		return null;
	}
	const insideSelection =
		point.x > bounds.left && point.x < bounds.right &&
		point.y > bounds.top && point.y < bounds.bottom;
	const radius = insideSelection ? options.bubbleHitRadiusPx : options.outsideHitRadiusPx;
	return nearest.distance <= radius ? nearest.handle : null;
}
