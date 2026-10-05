import { hasEditableNativePageTemplates } from "./pageModel";
import type { AnnotationDocument } from "../types";

/**
 * Page order for a session's visible pages ("mixed" order: original PDF pages
 * interleaved with pages added by the plugin).
 *
 * Added pages live in `appendedPages`; their page numbers are
 * `realPdfPageCount + index + 1` and each one is shown after the PDF page
 * named by `insertAfterPdfPage` (0 = before the first page). Moving an added
 * page therefore means reordering `appendedPages`, updating anchors, and
 * renumbering every annotation on the pages whose numbers change.
 *
 * Original PDF pages are drawn by Obsidian's viewer in file order, so they
 * keep their positions. The exception is a notebook created by this plugin:
 * its PDF pages are identical blank sheets of one size whose paper style and
 * ink all live in the annotation data, so reordering them is done by moving
 * each page's annotations and paper template to its new slot. The PDF file is
 * never rewritten.
 */

export type PageMove = "top" | "up" | "down" | "bottom";

export interface PageOrderResult {
	/** Old page number -> new page number, for every page whose number changed. */
	pageMap: Map<number, number>;
}

/** Whether this document's original PDF pages can be reordered (uniform plugin-created notebook). */
export function canReorderPdfPages(document: AnnotationDocument, realPdfPageCount: number): boolean {
	if (realPdfPageCount < 1 || !hasEditableNativePageTemplates(document, realPdfPageCount)) {
		return false;
	}
	const templates = document.pdfPageTemplates ?? [];
	if (templates.length !== realPdfPageCount) {
		return false;
	}
	const sizes = new Set(templates.map((template) => template.pageSize));
	return sizes.size === 1;
}

/** Applies a move to an order of page numbers and returns the new order (unchanged when the move is impossible). */
export function movePageInOrder(order: readonly number[], pageNumber: number, move: PageMove): number[] {
	const index = order.indexOf(pageNumber);
	if (index < 0) {
		return [...order];
	}
	const next = [...order];
	next.splice(index, 1);
	const targetIndex = move === "top" ? 0
		: move === "bottom" ? next.length
		: move === "up" ? Math.max(0, index - 1)
		: Math.min(next.length, index + 1);
	next.splice(targetIndex, 0, pageNumber);
	return next;
}

function samePdfSequence(previousOrder: readonly number[], nextOrder: readonly number[], realPdfPageCount: number): boolean {
	const previousPdf = previousOrder.filter((page) => page <= realPdfPageCount);
	const nextPdf = nextOrder.filter((page) => page <= realPdfPageCount);
	return previousPdf.length === nextPdf.length && previousPdf.every((page, index) => page === nextPdf[index]);
}

/**
 * Whether `nextOrder` can be applied: same pages as `currentOrder`, and the
 * original PDF pages keep their relative order unless they can be reordered.
 */
export function isPageOrderAllowed(
	document: AnnotationDocument,
	realPdfPageCount: number,
	currentOrder: readonly number[],
	nextOrder: readonly number[]
): boolean {
	if (currentOrder.length !== nextOrder.length) {
		return false;
	}
	const currentSet = new Set(currentOrder);
	if (
		currentSet.size !== currentOrder.length
		|| new Set(nextOrder).size !== nextOrder.length
		|| !nextOrder.every((page) => currentSet.has(page))
	) {
		return false;
	}
	return samePdfSequence(currentOrder, nextOrder, realPdfPageCount) || canReorderPdfPages(document, realPdfPageCount);
}

function remapPages<T extends { page: number }>(items: T[] | undefined, pageMap: Map<number, number>): T[] {
	return (items ?? []).map((item) => {
		const page = pageMap.get(item.page);
		return page === undefined ? item : { ...item, page };
	});
}

/**
 * Reorders the document's visible pages to `nextOrder` (page numbers in their
 * current numbering, in the desired display order). `currentOrder` is the
 * present display order of the same visible pages. Removed pages are not part
 * of either order and keep their positions. Returns null when the order is not
 * allowed; the document is then left unchanged.
 */
export function applyPageOrder(
	document: AnnotationDocument,
	realPdfPageCount: number,
	currentOrder: readonly number[],
	nextOrder: readonly number[]
): PageOrderResult | null {
	if (!isPageOrderAllowed(document, realPdfPageCount, currentOrder, nextOrder)) {
		return null;
	}
	const appendedPages = document.appendedPages ?? [];
	const pageMap = new Map<number, number>();

	// Original PDF pages: visible slots stay where they are; contents move into
	// the slots in their new order (an identity mapping unless reordering is allowed).
	const pdfSlots = currentOrder.filter((page) => page <= realPdfPageCount);
	const pdfContentsInNewOrder = nextOrder.filter((page) => page <= realPdfPageCount);
	pdfContentsInNewOrder.forEach((page, index) => {
		const slot = pdfSlots[index];
		if (slot !== page) {
			pageMap.set(page, slot);
		}
	});

	// Added pages: new array order follows the display order; each is anchored
	// after the PDF slot that now precedes it (0 = before every PDF page).
	const nextAppendedPages = [];
	let pdfItemsSeen = 0;
	for (const page of nextOrder) {
		if (page <= realPdfPageCount) {
			pdfItemsSeen += 1;
			continue;
		}
		const oldIndex = page - realPdfPageCount - 1;
		const addedPage = appendedPages[oldIndex];
		if (!addedPage) {
			return null;
		}
		const newPageNumber = realPdfPageCount + nextAppendedPages.length + 1;
		nextAppendedPages.push({ ...addedPage, insertAfterPdfPage: pdfItemsSeen > 0 ? pdfSlots[pdfItemsSeen - 1] : 0 });
		if (newPageNumber !== page) {
			pageMap.set(page, newPageNumber);
		}
	}
	if (nextAppendedPages.length !== appendedPages.length) {
		// Every added page is visible; anything else means the order was built from stale state.
		return null;
	}

	document.appendedPages = nextAppendedPages;
	if (pageMap.size > 0) {
		document.strokes = remapPages(document.strokes, pageMap);
		document.eraserPaths = remapPages(document.eraserPaths, pageMap);
		document.textItems = remapPages(document.textItems, pageMap);
		document.shapes = remapPages(document.shapes, pageMap);
		document.imageItems = remapPages(document.imageItems, pageMap);
		if (document.pdfPageTemplates) {
			document.pdfPageTemplates = remapPages(document.pdfPageTemplates, pageMap)
				.sort((left, right) => left.page - right.page);
		}
	}
	return { pageMap };
}
