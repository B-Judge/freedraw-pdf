import { App, TFile } from "obsidian";
import { PDFDocument, degrees } from "pdf-lib";
import { renderAnnotationDocumentPage, renderAnnotationDocumentPageImages } from "../markdown/embedRender";
import { hasEditableNativePageTemplates } from "../notebook/pageModel";
import { drawTemplatePageBackground } from "../notebook/templateCanvas";
import { dataUrlToArrayBuffer } from "../utils/general";
import { getSyntheticPagePointSize, renderMixedPagesToPdfBytes, renderSyntheticPageToCanvas } from "./mixedDocumentExport";
import { getOverlayPixelSize, getOverlayPlacement } from "./overlayPlacement";
import type { AnnotationDocument, MixedPageEntry } from "../types";

/** Suffix of the single annotated copy kept next to each annotated PDF. */
export const ANNOTATED_COPY_SUFFIX = " (annotated)";

const SYNTHETIC_PAGE_JPEG_QUALITY = 0.92;

export interface AnnotatedCopyRequest {
	sourceFile: TFile;
	document: AnnotationDocument;
	entries: MixedPageEntry[];
	realPdfPageCount: number;
	sidecarPath: string;
}

export interface AnnotatedCopyResult {
	file: TFile;
	/** False when the source PDF could not be edited and every page was rasterized instead. */
	preservedOriginalPages: boolean;
}

export function getAnnotatedCopyPath(sourceFile: TFile): string {
	const folderPrefix = sourceFile.parent?.path && sourceFile.parent.path !== "/" ? `${sourceFile.parent.path}/` : "";
	return `${folderPrefix}${sourceFile.basename}${ANNOTATED_COPY_SUFFIX}.pdf`;
}

/** Annotated copies are outputs; they are never used as the source of another copy. */
export function isAnnotatedCopyPath(path: string): boolean {
	return path.toLowerCase().endsWith(`${ANNOTATED_COPY_SUFFIX}.pdf`);
}

function pageHasAnnotations(document: AnnotationDocument, pageNumber: number): boolean {
	return document.strokes.some((stroke) => stroke.page === pageNumber)
		|| document.textItems.some((item) => item.page === pageNumber)
		|| document.shapes.some((shape) => shape.page === pageNumber)
		|| (document.imageItems ?? []).some((image) => image.page === pageNumber);
}

/** Whether the annotation data changes anything an exported copy would show. */
export function documentHasExportableContent(document: AnnotationDocument): boolean {
	return document.strokes.length > 0
		|| document.textItems.length > 0
		|| document.shapes.length > 0
		|| (document.imageItems ?? []).length > 0
		|| (document.appendedPages ?? []).length > 0
		|| (document.deletedPdfPages ?? []).length > 0
		|| (document.pdfPageTemplates ?? []).length > 0;
}

/**
 * Whether the annotated copy already reflects the saved annotations: it exists
 * and is newer than both the annotation sidecar and the source PDF.
 */
export async function isAnnotatedCopyCurrent(app: App, sourceFile: TFile, sidecarPath: string): Promise<boolean> {
	// Read times from disk: cached file metadata can lag right after a write.
	const [copyStat, sidecarStat, sourceStat] = await Promise.all([
		app.vault.adapter.stat(getAnnotatedCopyPath(sourceFile)),
		app.vault.adapter.stat(sidecarPath),
		app.vault.adapter.stat(sourceFile.path)
	]);
	if (!copyStat || copyStat.type !== "file") {
		return false;
	}
	return copyStat.mtime >= (sidecarStat?.mtime ?? 0) && copyStat.mtime >= (sourceStat?.mtime ?? sourceFile.stat.mtime);
}

async function canvasToBytes(canvas: HTMLCanvasElement, type: "image/png" | "image/jpeg", quality?: number): Promise<Uint8Array> {
	const blob = await new Promise<Blob | null>((resolve) => {
		try {
			canvas.toBlob(resolve, type, quality);
		} catch {
			resolve(null);
		}
	});
	if (blob) {
		return new Uint8Array(await blob.arrayBuffer());
	}
	return new Uint8Array(dataUrlToArrayBuffer(canvas.toDataURL(type, quality)));
}

async function renderPdfPageOverlay(
	document: AnnotationDocument,
	pageNumber: number,
	realPdfPageCount: number,
	widthPx: number,
	heightPx: number
): Promise<HTMLCanvasElement> {
	const canvas = createEl("canvas");
	canvas.width = widthPx;
	canvas.height = heightPx;
	const context = canvas.getContext("2d");
	if (!context) {
		throw new Error("Could not create export canvas.");
	}
	const pageTemplate = hasEditableNativePageTemplates(document, realPdfPageCount)
		? document.pdfPageTemplates?.find((template) => template.page === pageNumber)
		: null;
	if (pageTemplate) {
		// Plugin-created notebook PDFs draw their paper template over the page, as before.
		drawTemplatePageBackground(context, widthPx, heightPx, {
			id: `pdf-template-${pageNumber}`,
			title: `Page ${pageNumber}`,
			kind: "template",
			template: pageTemplate.template,
			paperColor: pageTemplate.paperColor,
			pageSize: pageTemplate.pageSize,
			strokes: [],
			textItems: [],
			shapes: []
		});
	}
	await renderAnnotationDocumentPageImages(context, document, pageNumber, widthPx, heightPx);
	renderAnnotationDocumentPage(context, document, pageNumber, widthPx, heightPx);
	return canvas;
}

function releaseCanvas(canvas: HTMLCanvasElement): void {
	canvas.width = 0;
	canvas.height = 0;
}

/**
 * Builds the annotated copy, keeping each original page as-is (text stays
 * selectable and searchable, vector content stays sharp) and drawing the
 * annotations over it as a transparent, high-resolution layer. Inserted
 * notebook pages become image pages and removed pages are left out, in the
 * same order as the annotation session. If the source PDF cannot be edited
 * (for example, it is encrypted), every page is rasterized instead.
 */
export async function buildAnnotatedCopyBytes(
	app: App,
	request: Omit<AnnotatedCopyRequest, "sidecarPath">
): Promise<{ bytes: Uint8Array; preservedOriginalPages: boolean }> {
	const { sourceFile, document, entries, realPdfPageCount } = request;
	if (entries.length === 0) {
		throw new Error("No pages available to export.");
	}
	const sourceBytes = new Uint8Array(await app.vault.adapter.readBinary(sourceFile.path));
	let pdf: PDFDocument;
	try {
		pdf = await PDFDocument.load(sourceBytes, { updateMetadata: false });
	} catch (error) {
		console.warn("freedraw-pdf: source PDF cannot be edited; exporting rasterized pages instead", error);
		const { pdfBytes } = await renderMixedPagesToPdfBytes(app, sourceFile, document, entries, realPdfPageCount, true);
		return { bytes: pdfBytes, preservedOriginalPages: false };
	}

	const sourcePageCount = pdf.getPageCount();
	const keptPdfPages = new Set(entries.filter((entry) => entry.pageNumber <= sourcePageCount).map((entry) => entry.pageNumber));
	for (let pageIndex = sourcePageCount - 1; pageIndex >= 0; pageIndex -= 1) {
		if (!keptPdfPages.has(pageIndex + 1)) {
			pdf.removePage(pageIndex);
		}
	}

	let outputIndex = 0;
	for (const entry of entries) {
		if (entry.pageNumber <= sourcePageCount) {
			const page = pdf.getPage(outputIndex);
			const hasTemplate = hasEditableNativePageTemplates(document, realPdfPageCount)
				&& (document.pdfPageTemplates ?? []).some((template) => template.page === entry.pageNumber);
			if (pageHasAnnotations(document, entry.pageNumber) || hasTemplate) {
				const placement = getOverlayPlacement(page.getCropBox(), page.getRotation().angle);
				const { widthPx, heightPx } = getOverlayPixelSize(placement.displayWidthPt, placement.displayHeightPt);
				const overlay = await renderPdfPageOverlay(document, entry.pageNumber, realPdfPageCount, widthPx, heightPx);
				const image = await pdf.embedPng(await canvasToBytes(overlay, "image/png"));
				releaseCanvas(overlay);
				page.drawImage(image, {
					x: placement.x,
					y: placement.y,
					width: placement.width,
					height: placement.height,
					rotate: degrees(placement.rotateDegrees)
				});
			}
		} else {
			const syntheticPage = document.appendedPages?.[entry.pageNumber - sourcePageCount - 1];
			const { widthPt, heightPt } = getSyntheticPagePointSize(syntheticPage?.pageSize ?? "a4");
			const { widthPx } = getOverlayPixelSize(widthPt, heightPt);
			const canvas = await renderSyntheticPageToCanvas(document, entry.pageNumber, sourcePageCount, true, widthPx);
			const image = await pdf.embedJpg(await canvasToBytes(canvas, "image/jpeg", SYNTHETIC_PAGE_JPEG_QUALITY));
			releaseCanvas(canvas);
			const page = pdf.insertPage(outputIndex, [widthPt, heightPt]);
			page.drawImage(image, { x: 0, y: 0, width: widthPt, height: heightPt });
		}
		outputIndex += 1;
	}
	pdf.setModificationDate(new Date());
	return { bytes: await pdf.save(), preservedOriginalPages: true };
}

/** Writes the annotated copy, replacing the previous one. The source PDF and its annotation data are never modified. */
export async function writeAnnotatedCopy(app: App, sourceFile: TFile, bytes: Uint8Array): Promise<TFile> {
	const path = getAnnotatedCopyPath(sourceFile);
	if (path === sourceFile.path) {
		throw new Error("The annotated copy cannot replace its source PDF.");
	}
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		await app.vault.modifyBinary(existing, buffer);
		return existing;
	}
	if (existing) {
		throw new Error(`${path} already exists and is not a file.`);
	}
	return app.vault.createBinary(path, buffer);
}

export async function exportAnnotatedCopy(app: App, request: AnnotatedCopyRequest): Promise<AnnotatedCopyResult> {
	const { bytes, preservedOriginalPages } = await buildAnnotatedCopyBytes(app, request);
	const file = await writeAnnotatedCopy(app, request.sourceFile, bytes);
	return { file, preservedOriginalPages };
}
