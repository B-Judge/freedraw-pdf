import { generateId } from "../utils/general";
import type { AnnotationDocument } from "../types";

/**
 * Stable identities for a session's pages, used to tell when page numbers
 * change so that links and embeds in notes can follow their page.
 *
 * - An added page is identified by its id; its number is
 *   `realPdfPageCount + index + 1` and changes when pages are added, removed,
 *   restored, moved, or an undo/redo restores an earlier layout.
 * - A page of a notebook made by this plugin is identified by its paper
 *   template's id, because reordering moves the template (with the page's
 *   annotations) to another PDF page.
 * - Any other PDF page is identified by its position in the file, which never
 *   changes.
 */

/** Gives each PDF page template an id, so notebook pages keep their identity when reordered. Returns true if any id was added. */
export function ensurePdfPageTemplateIds(document: AnnotationDocument): boolean {
	let changed = false;
	for (const template of document.pdfPageTemplates ?? []) {
		if (typeof template.id !== "string" || template.id.length === 0) {
			template.id = generateId("pdfpage");
			changed = true;
		}
	}
	return changed;
}

/** Identity of every page, indexed by page number - 1 (PDF pages first, then added pages). */
export function getPageIdentities(document: AnnotationDocument, realPdfPageCount: number): string[] {
	const identities: string[] = [];
	const templateIds = new Map<number, string>();
	for (const template of document.pdfPageTemplates ?? []) {
		if (template.id) {
			templateIds.set(template.page, template.id);
		}
	}
	for (let pageNumber = 1; pageNumber <= realPdfPageCount; pageNumber += 1) {
		const templateId = templateIds.get(pageNumber);
		identities.push(templateId ? `template:${templateId}` : `pdf:${pageNumber}`);
	}
	for (const page of document.appendedPages ?? []) {
		identities.push(`added:${page.id}`);
	}
	return identities;
}

export interface PageNumberChanges {
	/** Old page number -> new page number for every page that still exists but was renumbered. */
	pageMap: Map<number, number>;
	/** Old page numbers of pages that no longer exist (removed added pages). */
	removedPages: number[];
}

export function diffPageIdentities(before: readonly string[], after: readonly string[]): PageNumberChanges {
	const newNumberByIdentity = new Map<string, number>();
	after.forEach((identity, index) => newNumberByIdentity.set(identity, index + 1));
	const pageMap = new Map<number, number>();
	const removedPages: number[] = [];
	before.forEach((identity, index) => {
		const oldNumber = index + 1;
		const newNumber = newNumberByIdentity.get(identity);
		if (newNumber === undefined) {
			removedPages.push(oldNumber);
		} else if (newNumber !== oldNumber) {
			pageMap.set(oldNumber, newNumber);
		}
	});
	return { pageMap, removedPages };
}
