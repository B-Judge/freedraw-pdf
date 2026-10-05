const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");
const assert = require("assert/strict");

const root = path.resolve(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.ts"), "utf8");
const tree = ts.createSourceFile("main.ts", mainSource, ts.ScriptTarget.Latest, true);

// Load src modules (CommonJS transpile) with relative imports resolved between them.
const moduleCache = new Map();
function loadModule(relativePath) {
	const filePath = path.join(root, relativePath.endsWith(".ts") ? relativePath : `${relativePath}.ts`);
	if (moduleCache.has(filePath)) {
		return moduleCache.get(filePath).exports;
	}
	const moduleShim = { exports: {} };
	moduleCache.set(filePath, moduleShim);
	const output = ts.transpileModule(fs.readFileSync(filePath, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
	}).outputText;
	const localRequire = (specifier) => {
		if (specifier.startsWith(".")) {
			return loadModule(path.relative(root, path.resolve(path.dirname(filePath), specifier)));
		}
		return require(specifier);
	};
	vm.runInNewContext(output, { module: moduleShim, exports: moduleShim.exports, require: localRequire, Math, Date, JSON, crypto: globalThis.crypto });
	return moduleShim.exports;
}

function sessionClass(names, globals = {}, className = "NativePdfAnnotatorSession") {
	const node = tree.statements.find((statement) => ts.isClassDeclaration(statement) && statement.name?.text === className);
	const methods = names.map((name) => {
		const member = node.members.find((candidate) => candidate.name?.getText(tree) === name);
		assert.ok(member, `missing session method ${name}`);
		return member.getText(tree);
	}).join("\n");
	const context = { console, ...globals };
	vm.runInNewContext(ts.transpileModule(`class Session {${methods}} globalThis.Session = Session;`, {
		compilerOptions: { target: ts.ScriptTarget.ES2020 }
	}).outputText, context);
	return new context.Session();
}

const pageModel = loadModule("src/notebook/pageModel");
const pageLifecycle = loadModule("src/notebook/pageLifecycle");
const pageOrder = loadModule("src/notebook/pageOrder");
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const PAPER_COLOR_PRESETS = [{ label: "Cream", color: "#fffdf7" }, { label: "White", color: "#ffffff" }];
class Notice { constructor(message) { notices.push(message); } }
const notices = [];

// A session built from the real page-management methods, with rendering stubbed out.
function createSession(document, realPdfPageCount, newPageFormat = { mode: "match", template: "ruled", pageSize: "a4", paperColor: "#fffdf7" }) {
	const session = sessionClass([
		"getMixedPageEntries", "getSyntheticPageInsertAfterPdfPage", "isPdfPageDeleted", "getAnnotationCountForPage", "getAnnotationBreakdownForPage",
		"findSyntheticInsertIndexAfterPdfPage", "findFirstSyntheticInsertIndexAfterPdfPage", "getSyntheticPageIndex", "getAppendedPages",
		"getPdfPageTemplate", "canEditPdfPageTemplate", "resolveNewPageFormat", "describePageFormat",
		"getVisiblePageOrder", "canMovePage", "movePage", "getInsertLocationNextToPage", "quickAddPageAt",
		"insertTemplatePageAtLocation", "insertTemplatePageAtIndex"
	], {
		clamp, Notice, PAPER_COLOR_PRESETS,
		hasEditableNativePageTemplates: pageModel.hasEditableNativePageTemplates,
		createTemplateNotebookPage: pageModel.createTemplateNotebookPage,
		getNotebookTemplateLabel: pageModel.getNotebookTemplateLabel,
		getNotebookPageSizeLabel: pageModel.getNotebookPageSizeLabel,
		insertSyntheticPage: pageLifecycle.insertSyntheticPage,
		applyPageOrder: pageOrder.applyPageOrder,
		isPageOrderAllowed: pageOrder.isPageOrderAllowed,
		movePageInOrder: pageOrder.movePageInOrder
	});
	Object.assign(session, {
		annotationDocument: document,
		realPdfPageCount,
		currentPage: 1,
		selectedTargets: [],
		selectedTarget: null,
		lastSelectionRegion: null,
		undoStack: [],
		nextPageZIndexCache: new Map(),
		annotationMode: false,
		plugin: { getNewPageFormat: () => ({ ...newPageFormat }) },
		finishSessionInlineTextEditor() {},
		pushHistory() { this.undoStack.push(JSON.stringify(this.annotationDocument)); },
		markDirtyAndRedraw(message) { this.lastMessage = message; },
		refreshSyntheticPages(pageNumber) { if (pageNumber) this.currentPage = pageNumber; }
	});
	return session;
}

const added = (id, anchor, format = {}) => ({
	id, title: id, kind: "template", template: format.template ?? "ruled", pageSize: format.pageSize ?? "a4",
	paperColor: format.paperColor ?? "#fffdf7", insertAfterPdfPage: anchor, strokes: [], textItems: [], shapes: []
});
const ink = (page, id) => ({ id, page });
const emptyDocument = (extra) => ({ strokes: [], eraserPaths: [], textItems: [], shapes: [], imageItems: [], appendedPages: [], deletedPdfPages: [], permanentlyDeletedPdfPages: [], removedPages: [], ...extra });
// Display order as page contents (each page carries one stroke naming it).
// Values created inside the sandbox are copied before deep comparison.
const plain = (value) => JSON.parse(JSON.stringify(value));
const contents = (session) => plain(session.getMixedPageEntries()).map((entry) => session.annotationDocument.strokes.find((stroke) => stroke.page === entry.pageNumber)?.id ?? `new@${entry.pageNumber}`);
const pageOf = (session, id) => session.annotationDocument.strokes.find((stroke) => stroke.id === id).page;

// 1. Ordinary PDF: added pages move anywhere, PDF pages keep their order.
{
	const document = emptyDocument({
		strokes: [ink(1, "p1"), ink(2, "p2"), ink(3, "p3"), ink(4, "A"), ink(5, "B")],
		eraserPaths: [ink(5, "eraseB")], textItems: [ink(4, "textA")], imageItems: [ink(5, "imageB")],
		appendedPages: [added("A", 1), added("B", 3)]
	});
	const session = createSession(document, 3);
	assert.deepEqual(contents(session), ["p1", "A", "p2", "p3", "B"]);
	assert.equal(session.canMovePage(3, "up"), false, "an original PDF page cannot pass another original PDF page");
	assert.equal(session.canMovePage(2, "up"), true, "an original PDF page can pass an added page (the added page moves instead)");
	assert.equal(session.canMovePage(1, "up"), false, "the first page cannot move up");
	assert.equal(session.canMovePage(5, "top"), true, "an added page can move to the start");

	session.movePage(pageOf(session, "B"), "top");
	assert.deepEqual(contents(session), ["B", "p1", "A", "p2", "p3"], "added page moved to the start");
	assert.equal(document.eraserPaths[0].page, pageOf(session, "B"), "eraser marks move with their page");
	assert.equal(document.imageItems[0].page, pageOf(session, "B"), "images move with their page");
	assert.equal(document.textItems[0].page, pageOf(session, "A"), "text moves with its page");
	assert.equal(session.currentPage, pageOf(session, "B"), "the moved page becomes the current page");

	session.movePage(pageOf(session, "A"), "down");
	assert.deepEqual(contents(session), ["B", "p1", "p2", "A", "p3"]);
	session.movePage(2, "up");
	assert.deepEqual(contents(session), ["B", "p1", "p2", "A", "p3"], "PDF page 2 cannot jump PDF page 1");
	assert.ok(notices.at(-1).includes("original PDF stay in their order"), "a refused move explains why");
	session.movePage(3, "up");
	assert.deepEqual(contents(session), ["B", "p1", "p2", "p3", "A"], "moving PDF page 3 up past an added page moves the added page down");
	assert.equal(session.undoStack.length, 3, "every applied move can be undone");
}

// 2. Plugin notebook: every page can move, paper templates move with their page.
{
	const document = emptyDocument({
		nativePageTemplatesEditable: true,
		pdfPageTemplates: [1, 2, 3].map((page, index) => ({ page, template: ["ruled", "grid", "dot"][index], paperColor: "#ffffff", pageSize: "a4" })),
		strokes: [ink(1, "n1"), ink(2, "n2"), ink(3, "n3")]
	});
	const session = createSession(document, 3);
	assert.equal(session.canMovePage(3, "top"), true);
	session.movePage(3, "top");
	assert.deepEqual(contents(session), ["n3", "n1", "n2"]);
	assert.deepEqual(plain(document.pdfPageTemplates.map((template) => template.template)), ["dot", "ruled", "grid"], "paper templates follow their page");
}

// 3. Adding pages at the start, the end, and before/after any page.
{
	const document = emptyDocument({ strokes: [ink(1, "p1"), ink(2, "p2"), ink(3, "A")], appendedPages: [added("A", 1)] });
	const session = createSession(document, 2);
	assert.deepEqual(contents(session), ["p1", "A", "p2"]);
	const startPage = session.quickAddPageAt("start");
	assert.equal(session.getMixedPageEntries()[0].pageNumber, startPage, "Add at start puts the page before every page");
	const endPage = session.quickAddPageAt("end");
	assert.equal(session.getMixedPageEntries().at(-1).pageNumber, endPage, "Add at end puts the page after every page");
	const beforePdf = session.quickAddPageAt({ pageNumber: 2, position: "before" });
	let order = session.getMixedPageEntries().map((entry) => entry.pageNumber);
	assert.equal(order[order.indexOf(2) - 1], beforePdf, "Add before a PDF page puts it immediately before");
	const afterPdf = session.quickAddPageAt({ pageNumber: 1, position: "after" });
	order = session.getMixedPageEntries().map((entry) => entry.pageNumber);
	assert.equal(order[order.indexOf(1) + 1], afterPdf, "Add after a PDF page puts it immediately after");
	const addedA = pageOf(session, "A");
	const beforeAdded = session.quickAddPageAt({ pageNumber: addedA, position: "before" });
	order = session.getMixedPageEntries().map((entry) => entry.pageNumber);
	assert.equal(order[order.indexOf(pageOf(session, "A")) - 1], beforeAdded, "Add before an added page puts it immediately before");
	const afterAdded = session.quickAddPageAt({ pageNumber: pageOf(session, "A"), position: "after" });
	order = session.getMixedPageEntries().map((entry) => entry.pageNumber);
	assert.equal(order[order.indexOf(pageOf(session, "A")) + 1], afterAdded, "Add after an added page puts it immediately after");
	assert.deepEqual(contents(session).filter((id) => !id.startsWith("new@")), ["p1", "A", "p2"], "existing pages keep their order and ink");
	assert.equal(session.getMixedPageEntries().length, 9);
}

// 4. New page format: match the current page, or use the configured format.
{
	const notebook = emptyDocument({
		nativePageTemplatesEditable: true,
		pdfPageTemplates: [{ page: 1, template: "dot", paperColor: "#ffffff", pageSize: "letter" }],
		appendedPages: [added("G", 1, { template: "grid", pageSize: "compact", paperColor: "#eef6ff" })]
	});
	const matching = createSession(notebook, 1);
	assert.deepEqual(plain(matching.resolveNewPageFormat(1)), { template: "dot", pageSize: "letter", paperColor: "#ffffff", matchedCurrentPage: true }, "a notebook page lends its format");
	assert.deepEqual(plain(matching.resolveNewPageFormat(2)), { template: "grid", pageSize: "compact", paperColor: "#eef6ff", matchedCurrentPage: true }, "an added page lends its format");
	const ordinary = createSession(emptyDocument({}), 2, { mode: "match", template: "blank", pageSize: "letter", paperColor: "#ffffff" });
	assert.deepEqual(plain(ordinary.resolveNewPageFormat(1)), { template: "blank", pageSize: "letter", paperColor: "#ffffff", matchedCurrentPage: false }, "an ordinary PDF page uses the configured format");
	const fixed = createSession(notebook, 1, { mode: "fixed", template: "ruled", pageSize: "a4", paperColor: "#fffdf7" });
	assert.equal(fixed.resolveNewPageFormat(2).template, "ruled", "fixed mode ignores the current page");
	const newPageNumber = fixed.quickAddPageAt({ pageNumber: 1, position: "after" });
	const addedPage = notebook.appendedPages[newPageNumber - 2];
	assert.equal(addedPage.template, "ruled", "quick add uses the resolved format");
	assert.match(matching.describePageFormat({ template: "grid", pageSize: "a4", paperColor: "#fffdf7" }), /^Grid, A4 portrait, cream$/i);
}

// 5. Links and embeds in notes follow their page whenever page numbers change.
const linkChecks = (async () => {
	const pageIdentity = loadModule("src/notebook/pageIdentity");
	const rewriter = loadModule("src/markdown/pageReferenceRewriter");
	class TFile {
		constructor(path) { this.path = path; this.name = path.split("/").pop(); this.basename = this.name.replace(/\.[^.]+$/, ""); this.extension = this.name.split(".").pop(); }
	}
	const pdf = new TFile("Courses/Lecture 3.pdf");
	const notes = new Map([
		["Courses/Week 3.md", [
			"Slides: [[Lecture 3.pdf#page=2]]",
			"My worked example: [[Courses/Lecture 3.pdf#page=4|example]]",
			"Summary sheet: ![[Lecture 3#page=5]]",
			"Region: [[Courses/Lecture 3.pdf#page=5]] ::region[page=5;rect=0.1,0.1,0.5,0.5]",
			"Markdown link: [summary](Lecture%203.pdf#page=5)",
			"```freedraw-pdf",
			"path: Courses/Lecture 3.pdf",
			"page: 4",
			"width: 720",
			"```",
			"Other PDF: [[Lecture 4.pdf#page=4]]"
		].join("\n")],
		["Courses/Unrelated.md", "Nothing about that PDF, page 4."]
	]);
	const files = new Map([[pdf.path, pdf], ["Courses/Lecture 4.pdf", new TFile("Courses/Lecture 4.pdf")], ...[...notes.keys()].map((path) => [path, new TFile(path)])]);
	const linkTargets = { "Lecture 3.pdf": pdf.path, "Lecture 3": pdf.path, "Lecture 4.pdf": "Courses/Lecture 4.pdf" };
	const writes = [];
	const plugin = sessionClass(["updatePageReferences"], { TFile, Notice, rewritePageReferences: rewriter.rewritePageReferences }, "PDFAnnotatorPlugin");
	plugin.pageReferenceUpdates = Promise.resolve();
	plugin.app = {
		vault: {
			getMarkdownFiles: () => [...notes.keys()].map((path) => files.get(path)),
			getAbstractFileByPath: (path) => files.get(path) ?? null,
			cachedRead: async (file) => notes.get(file.path),
			process: async (file, update) => { const next = update(notes.get(file.path)); writes.push(file.path); notes.set(file.path, next); return next; }
		},
		metadataCache: { getFirstLinkpathDest: (linkPath) => { const target = linkTargets[linkPath]; return target ? files.get(target) : null; } }
	};

	// Ordinary PDF with 3 pages; added page A after page 1 (page 4) and B after page 3 (page 5).
	const document = emptyDocument({
		strokes: [ink(1, "p1"), ink(2, "p2"), ink(3, "p3"), ink(4, "A"), ink(5, "B")],
		appendedPages: [added("A", 1), added("B", 3)]
	});
	const session = createSession(document, 3);
	const reconciler = sessionClass(["reconcilePageNumbers"], { getPageIdentities: pageIdentity.getPageIdentities, diffPageIdentities: pageIdentity.diffPageIdentities });
	session.reconcilePageNumbers = reconciler.reconcilePageNumbers;
	session.file = pdf;
	session.plugin.updatePageReferences = (file, changes) => plugin.updatePageReferences(file, changes);
	// In the plugin every change goes through scheduleSave, which reconciles page numbers.
	session.markDirtyAndRedraw = function () { this.reconcilePageNumbers(); };
	session.reconcilePageNumbers();
	const week = () => notes.get("Courses/Week 3.md");
	const linkFor = (id) => `page=${pageOf(session, id)}`;
	const settle = () => plugin.pageReferenceUpdates;

	// Move B (page 5) to the start: B becomes page 4 and A becomes page 5.
	session.movePage(5, "top");
	await settle();
	assert.equal(pageOf(session, "B"), 4);
	assert.ok(week().includes("My worked example: [[Courses/Lecture 3.pdf#page=5|example]]"), "a link to A follows it to page 5");
	assert.ok(week().includes("Summary sheet: ![[Lecture 3#page=4]]"), "an embed of B follows it to page 4");
	assert.ok(week().includes("Region: [[Courses/Lecture 3.pdf#page=4]] ::region[page=4;"), "a region link follows its page");
	assert.ok(week().includes("[summary](Lecture%203.pdf#page=4)"), "a markdown link follows its page");
	assert.ok(week().includes("path: Courses/Lecture 3.pdf\npage: 5"), "an annotated embed block follows its page");
	assert.ok(week().includes("Slides: [[Lecture 3.pdf#page=2]]"), "links to original PDF pages are unchanged");
	assert.ok(week().includes("Other PDF: [[Lecture 4.pdf#page=4]]"), "links to other PDFs are unchanged");
	assert.ok(!writes.includes("Courses/Unrelated.md"), "notes without links to the PDF are not rewritten");

	// Insert a page at the start: every added page shifts by one.
	session.quickAddPageAt("start");
	await settle();
	assert.ok(week().includes(`My worked example: [[Courses/Lecture 3.pdf#${linkFor("A")}|example]]`), "links follow pages shifted by an insertion");
	assert.ok(week().includes(`Summary sheet: ![[Lecture 3#${linkFor("B")}]]`));

	// Undo both changes by restoring the original layout: links return to their original pages.
	const original = emptyDocument({
		strokes: [ink(1, "p1"), ink(2, "p2"), ink(3, "p3"), ink(4, "A"), ink(5, "B")],
		appendedPages: [added("A", 1), added("B", 3)]
	});
	session.annotationDocument = original;
	session.reconcilePageNumbers();
	await settle();
	assert.ok(week().includes("My worked example: [[Courses/Lecture 3.pdf#page=4|example]]"), "undo returns links to their original pages");
	assert.ok(week().includes("Summary sheet: ![[Lecture 3#page=5]]"));
	assert.ok(week().includes("path: Courses/Lecture 3.pdf\npage: 4"));

	// Notebook reordering: notebook pages keep their identity through their paper template.
	const notebook = emptyDocument({
		nativePageTemplatesEditable: true,
		pdfPageTemplates: [1, 2, 3].map((page, index) => ({ page, template: ["ruled", "grid", "dot"][index], paperColor: "#ffffff", pageSize: "a4" })),
		strokes: [ink(1, "n1"), ink(2, "n2"), ink(3, "n3")]
	});
	pageIdentity.ensurePdfPageTemplateIds(notebook);
	notes.set("Courses/Week 3.md", "Notebook page three: [[Lecture 3.pdf#page=3]] and one: [[Lecture 3.pdf#page=1]]");
	const notebookSession = createSession(notebook, 3);
	notebookSession.reconcilePageNumbers = reconciler.reconcilePageNumbers;
	notebookSession.file = pdf;
	notebookSession.plugin.updatePageReferences = (file, changes) => plugin.updatePageReferences(file, changes);
	notebookSession.markDirtyAndRedraw = function () { this.reconcilePageNumbers(); };
	notebookSession.reconcilePageNumbers();
	notebookSession.movePage(3, "top");
	await settle();
	assert.equal(week(), "Notebook page three: [[Lecture 3.pdf#page=1]] and one: [[Lecture 3.pdf#page=2]]", "notebook page links follow reordered pages");

	// Loading a sidecar keeps template ids.
	const storeSource = fs.readFileSync(path.join(root, "src/stores/annotationStore.ts"), "utf8");
	assert.ok(storeSource.includes("...(typeof pageTemplate.id === \"string\" && pageTemplate.id ? { id: pageTemplate.id } : {}),"), "page template ids must survive loading");
	assert.ok(mainSource.includes("	private scheduleSave(): void {\n		this.reconcilePageNumbers();"), "every document change must reconcile page numbers");
})();

// 6. UI wiring: the controls exist and use the shared paths.
const stylesCss = fs.readFileSync(path.join(root, "styles.css"), "utf8");
for (const [needle, message] of [
	["rightGroup.appendChild(this.createQuickAddPageButton());", "a visible add-page button must be on the toolbar"],
	["createPageAction(\"arrow-up-to-line\", \"Add at start\"", "the page manager must offer adding at the start"],
	["createPageAction(\"arrow-down-to-line\", \"Add at end\"", "the page manager must offer adding at the end"],
	["this.pageListReorderMode ? \"Done\" : \"Reorder\"", "the page manager must offer a reorder mode"],
	["{ move: \"top\", title: \"Move to start\", icon: \"arrow-up-to-line\" }", "page rows must offer moving to the start"],
	["{ id: \"quick-add-page-after-current\"", "quick add must be available as a command"],
	[".setTitle(this.plugin.getNewPageFormat().mode === \"match\" ? \"New page format: match current page...\" : \"New page format: fixed...\")", "the page menu must expose the new page format"]
]) {
	assert.ok(mainSource.includes(needle), `main.ts: ${message}\nMissing: ${needle}`);
}
assert.ok(stylesCss.includes(".pdf-native-annotator-page-list-page-action {"), "page manager actions must be styled");

linkChecks.then(() => {
	console.log("Page management verifier passed: moves, notebook reordering, add at start/end/before/after, new page format, links and embeds follow renumbered pages.");
}).catch((error) => {
	console.error(error);
	process.exit(1);
});
