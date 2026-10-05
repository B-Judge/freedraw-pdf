/**
 * Rewrites page numbers in a note's references to one PDF after that PDF's
 * pages were renumbered. Handles the forms the plugin writes and the usual
 * hand-written ones:
 *
 *   [[file.pdf#page=3]]  ![[file.pdf#page=3]]  [[file#page=3|Notes]]
 *   [Notes](file.pdf#page=3)  [Notes](<my file.pdf#page=3>)
 *   [[file.pdf#page=3]] ::region[page=3;rect=...]
 *   ```freedraw-pdf            (annotated embed)
 *   path: file.pdf
 *   page: 3
 *   ```
 *
 * Only references that resolve to the target PDF are changed, and every page
 * number is mapped from the old numbering in a single pass, so swaps (3 <-> 4)
 * come out right.
 */

export interface PageReferenceRewriteOptions {
	/** Vault path of the PDF whose pages were renumbered. */
	targetPath: string;
	/** Old page number -> new page number. Pages not in the map keep their number. */
	pageMap: ReadonlyMap<number, number>;
	/** Old numbers of pages that no longer exist; references to them are counted, not changed. */
	removedPages?: readonly number[];
	/** Resolves a link path as written in the note to a vault path, or null. */
	resolve: (linkPath: string) => string | null;
}

export interface PageReferenceRewriteResult {
	text: string;
	/** References whose page number was changed. */
	updated: number;
	/** References that point to a page that no longer exists. */
	orphaned: number;
}

const WIKILINK = /(!?\[\[)([^[\]|#]*)#page=(\d+)([^[\]]*?)\]\](\s*::region\[page=)?(\d+)?/g;
const MARKDOWN_LINK = /(\[[^\]]*\]\()(<?)([^)>#]*)#page=(\d+)([^)>]*)(>?)\)/g;
const EMBED_BLOCK = /(^|\n)([ \t]*)(`{3,}|~{3,})[ \t]*freedraw-pdf[^\n]*\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\n|$)/g;

function decodeLinkPath(raw: string): string {
	try {
		return decodeURIComponent(raw.trim());
	} catch {
		return raw.trim();
	}
}

function cleanEmbedPath(raw: string): string {
	return raw.trim().replace(/^['"]|['"]$/g, "").replace(/^!?\[\[/, "").replace(/\]\]$/, "").split("#")[0].split("|")[0].trim();
}

export function rewritePageReferences(text: string, options: PageReferenceRewriteOptions): PageReferenceRewriteResult {
	const removed = new Set(options.removedPages ?? []);
	let updated = 0;
	let orphaned = 0;
	const targets = (linkPath: string): boolean => {
		const path = linkPath.trim();
		return path.length > 0 && options.resolve(path) === options.targetPath;
	};
	const mapPage = (raw: string): string => {
		const page = Number(raw);
		const next = options.pageMap.get(page);
		if (next !== undefined && next !== page) {
			updated += 1;
			return String(next);
		}
		if (next === undefined && removed.has(page)) {
			orphaned += 1;
		}
		return raw;
	};
	// A region repeats its link's page; it follows the link without being counted again.
	const mapRepeatedPage = (raw: string): string => {
		const next = options.pageMap.get(Number(raw));
		return next === undefined ? raw : String(next);
	};

	let result = text.replace(WIKILINK, (match, open: string, linkPath: string, page: string, rest: string, region: string | undefined, regionPage: string | undefined) => {
		if (!targets(linkPath)) {
			return match;
		}
		const nextLink = `${open}${linkPath}#page=${mapPage(page)}${rest}]]`;
		if (region === undefined || regionPage === undefined) {
			return nextLink;
		}
		return `${nextLink}${region}${mapRepeatedPage(regionPage)}`;
	});

	result = result.replace(MARKDOWN_LINK, (match, open: string, angleOpen: string, linkPath: string, page: string, rest: string, angleClose: string) => {
		if (!targets(decodeLinkPath(linkPath))) {
			return match;
		}
		return `${open}${angleOpen}${linkPath}#page=${mapPage(page)}${rest}${angleClose})`;
	});

	result = result.replace(EMBED_BLOCK, (match, _lead: string, _indent: string, _fence: string, body: string) => {
		const pathLine = body.match(/^[ \t]*(?:path|file)[ \t]*:[ \t]*(.+)$/im);
		if (!pathLine || !targets(cleanEmbedPath(pathLine[1]))) {
			return match;
		}
		const nextBody = body.replace(/^([ \t]*page[ \t]*:[ \t]*)(\d+)/im, (_line, prefix: string, page: string) => `${prefix}${mapPage(page)}`);
		return match.replace(body, () => nextBody);
	});

	return { text: result, updated, orphaned };
}
