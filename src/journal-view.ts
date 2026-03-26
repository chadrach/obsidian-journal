import {
	Component,
	MarkdownRenderer,
	MarkdownView,
	TAbstractFile,
	TFile,
	WorkspaceLeaf,
	moment,
} from "obsidian";
import { VIEW_TYPE_JOURNAL, JOURNAL_ICON } from "./constants";
import {
	createDailyNote,
	findExistingDailyNotes,
	getDailyNotesConfig,
	getDailyNotePath,
	type DailyNoteEntry,
	type DailyNotesConfig,
} from "./daily-notes-utils";
import type JournalPlugin from "./main";

/**
 * A single rendered past note in the journal view.
 * Manages its own DOM and MarkdownRenderer lifecycle.
 */
class PastNoteBlock extends Component {
	private containerEl: HTMLElement;
	private contentEl: HTMLElement;
	private app: MarkdownView["app"];
	private file: TFile;
	private date: ReturnType<typeof moment>;
	private settings: JournalPlugin["settings"];
	private onOpenFile: (file: TFile) => void;

	constructor(
		app: MarkdownView["app"],
		file: TFile,
		date: ReturnType<typeof moment>,
		parentEl: HTMLElement,
		settings: JournalPlugin["settings"],
		onOpenFile: (file: TFile) => void,
	) {
		super();
		this.app = app;
		this.file = file;
		this.date = date;
		this.settings = settings;
		this.onOpenFile = onOpenFile;

		this.containerEl = parentEl.createDiv({ cls: "journal-note-block" });
		if (this.settings.hideH1) {
			this.containerEl.addClass("hide-h1");
		}

		// Date header
		const headerEl = this.containerEl.createDiv({ cls: "journal-note-header" });
		if (this.settings.hideFilename) {
			headerEl.addClass("journal-note-header-hidden");
		}

		const dateLabel = this.date.calendar(null, {
			sameDay: "[Today] — dddd, MMMM D, YYYY",
			lastDay: "[Yesterday] — dddd, MMMM D, YYYY",
			lastWeek: "dddd, MMMM D, YYYY",
			sameElse: "dddd, MMMM D, YYYY",
		});

		headerEl.createEl("span", {
			text: dateLabel,
			cls: "journal-note-date",
		});

		const openBtn = headerEl.createEl("span", {
			cls: "journal-note-open-btn",
			attr: { "aria-label": "Open in new tab" },
		});
		openBtn.textContent = "↗";
		openBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.onOpenFile(this.file);
		});

		headerEl.addEventListener("click", () => {
			this.onOpenFile(this.file);
		});

		// Content area
		this.contentEl = this.containerEl.createDiv({
			cls: "journal-note-content journal-note-rendered",
		});

		// Click content to open in new tab
		this.contentEl.addEventListener("click", (e) => {
			// Don't intercept clicks on links, checkboxes, etc.
			const target = e.target as HTMLElement;
			if (target.closest("a, input, button, .internal-link, .external-link")) {
				return;
			}
			this.onOpenFile(this.file);
		});

		void this.renderContent();
	}

	private async renderContent(): Promise<void> {
		this.contentEl.empty();

		let content = await this.app.vault.read(this.file);

		if (this.settings.hideH1) {
			content = this.stripFirstH1(content);
		}

		const renderContainer = this.contentEl.createDiv({ cls: "markdown-rendered" });
		await MarkdownRenderer.render(
			this.app,
			content,
			renderContainer,
			this.file.path,
			this,
		);
	}

	private stripFirstH1(content: string): string {
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i]!.trim();
			if (trimmed === "") continue;
			if (trimmed.startsWith("# ")) {
				lines.splice(i, 1);
				break;
			}
			break;
		}
		return lines.join("\n");
	}

	async refresh(): Promise<void> {
		await this.renderContent();
	}

	getFile(): TFile {
		return this.file;
	}

	getContainerEl(): HTMLElement {
		return this.containerEl;
	}

	onunload(): void {
		this.containerEl.remove();
	}
}

/**
 * The main journal view. Extends MarkdownView so today's note gets
 * Obsidian's native Live Preview editor. Past notes are rendered
 * below the editor using MarkdownRenderer.
 */
export class JournalView extends MarkdownView {
	private plugin: JournalPlugin;
	private pastNotesContainer: HTMLElement | null = null;
	private pastNoteBlocks: PastNoteBlock[] = [];
	private pastEntries: DailyNoteEntry[] = [];
	private loadedPastCount = 0;
	private sentinelEl: HTMLElement | null = null;
	private observer: IntersectionObserver | null = null;
	private config: DailyNotesConfig | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: JournalPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_JOURNAL;
	}

	getDisplayText(): string {
		return "Journal";
	}

	getIcon(): string {
		return JOURNAL_ICON;
	}

	async onOpen(): Promise<void> {
		await super.onOpen();
		this.containerEl.addClass("journal-view");

		this.config = getDailyNotesConfig(this.app, this.plugin.settings);

		// Auto-create today's note
		if (this.plugin.settings.autoCreateToday) {
			const todayPath = getDailyNotePath(moment(), this.config);
			if (!this.app.vault.getAbstractFileByPath(todayPath)) {
				await createDailyNote(this.app, moment(), this.config);
			}
		}

		// Load today's note into the editor
		const todayPath = getDailyNotePath(moment(), this.config);
		const todayFile = this.app.vault.getAbstractFileByPath(todayPath);
		if (todayFile instanceof TFile) {
			await this.leaf.openFile(todayFile, { state: { mode: "source" } });
		}
	}

	async onLoadFile(file: TFile): Promise<void> {
		await super.onLoadFile(file);
		this.buildPastNotesSection();
		this.registerVaultEvents();
	}

	async onUnloadFile(file: TFile): Promise<void> {
		this.cleanupPastNotes();
		await super.onUnloadFile(file);
	}

	private buildPastNotesSection(): void {
		this.cleanupPastNotes();

		if (!this.config) {
			this.config = getDailyNotesConfig(this.app, this.plugin.settings);
		}

		// Create the past notes container inside the view-content area
		this.pastNotesContainer = this.contentEl.createDiv({
			cls: "journal-past-notes",
		});

		// Add a date header for today's note above the editor
		this.addTodayHeader();

		// Find all daily notes except today
		const allEntries = findExistingDailyNotes(this.app, this.config);
		this.pastEntries = allEntries.filter(
			(e) => !e.date.isSame(moment(), "day"),
		);

		this.loadedPastCount = 0;
		void this.loadNextBatch();
		this.setupInfiniteScroll();
	}

	private addTodayHeader(): void {
		// Insert a date header before the editor
		const existingHeader = this.contentEl.querySelector(".journal-today-header");
		if (existingHeader) existingHeader.remove();

		const headerEl = document.createElement("div");
		headerEl.className = "journal-today-header journal-note-header";
		if (this.plugin.settings.hideFilename) {
			headerEl.addClass("journal-note-header-hidden");
		}

		const dateLabel = moment().calendar(null, {
			sameDay: "[Today] — dddd, MMMM D, YYYY",
			lastDay: "[Yesterday] — dddd, MMMM D, YYYY",
			lastWeek: "dddd, MMMM D, YYYY",
			sameElse: "dddd, MMMM D, YYYY",
		});

		headerEl.createEl("span", {
			text: dateLabel,
			cls: "journal-note-date",
		});

		// Insert before the first child of contentEl (before the editor)
		this.contentEl.insertBefore(headerEl, this.contentEl.firstChild);
	}

	private async loadNextBatch(): Promise<void> {
		if (!this.pastNotesContainer) return;

		const batchSize = this.plugin.settings.notesPerBatch;
		const end = Math.min(
			this.loadedPastCount + batchSize,
			this.pastEntries.length,
		);

		// Remove sentinel before adding new notes
		if (this.sentinelEl) {
			this.sentinelEl.remove();
			this.sentinelEl = null;
		}

		for (let i = this.loadedPastCount; i < end; i++) {
			const entry = this.pastEntries[i]!;

			const block = new PastNoteBlock(
				this.app,
				entry.file,
				entry.date,
				this.pastNotesContainer,
				this.plugin.settings,
				(file) => this.openInNewTab(file),
			);
			block.load();
			this.pastNoteBlocks.push(block);
		}

		this.loadedPastCount = end;

		// Re-add sentinel if there are more notes to load
		if (this.loadedPastCount < this.pastEntries.length) {
			this.sentinelEl = this.pastNotesContainer.createDiv({
				cls: "journal-sentinel",
			});
			if (this.observer) {
				this.observer.observe(this.sentinelEl);
			}
		}
	}

	private setupInfiniteScroll(): void {
		// The scroll container is .view-content (this.contentEl)
		this.observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (
						entry.isIntersecting &&
						this.loadedPastCount < this.pastEntries.length
					) {
						void this.loadNextBatch();
					}
				}
			},
			{
				root: this.contentEl,
				rootMargin: "200px",
			},
		);

		if (this.sentinelEl) {
			this.observer.observe(this.sentinelEl);
		}
	}

	private registerVaultEvents(): void {
		this.registerEvent(
			this.app.vault.on("modify", (file) => this.onFileModified(file)),
		);
		this.registerEvent(
			this.app.vault.on("create", (file) => this.onFileCreated(file)),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => this.onFileDeleted(file)),
		);
		this.registerEvent(
			this.app.vault.on("rename", () => this.onFileRenamed()),
		);
	}

	private isRelevantFile(file: TAbstractFile): boolean {
		if (!(file instanceof TFile) || file.extension !== "md" || !this.config) {
			return false;
		}
		const expectedFolder = this.config.folder
			? this.config.folder + "/"
			: "";
		return file.path.startsWith(expectedFolder);
	}

	private onFileModified(file: TAbstractFile): void {
		if (!this.isRelevantFile(file)) return;
		// Today's note is handled by the MarkdownView editor automatically.
		// Only refresh past notes.
		const block = this.pastNoteBlocks.find(
			(b) => b.getFile().path === file.path,
		);
		if (block) {
			void block.refresh();
		}
	}

	private onFileCreated(file: TAbstractFile): void {
		if (!this.isRelevantFile(file) || !this.config) return;
		if (!(file instanceof TFile)) return;

		const date = moment(file.basename, this.config.format, true);
		if (!date.isValid()) return;

		// Rebuild past notes to maintain sort order
		this.buildPastNotesSection();
	}

	private onFileDeleted(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;
		const blockIndex = this.pastNoteBlocks.findIndex(
			(b) => b.getFile().path === file.path,
		);
		if (blockIndex !== -1) {
			const block = this.pastNoteBlocks[blockIndex]!;
			block.unload();
			this.pastNoteBlocks.splice(blockIndex, 1);
			this.pastEntries = this.pastEntries.filter(
				(e) => e.file.path !== file.path,
			);
			this.loadedPastCount = Math.max(0, this.loadedPastCount - 1);
		}
	}

	private onFileRenamed(): void {
		// Rebuild to handle renamed files
		if (this.config) {
			this.buildPastNotesSection();
		}
	}

	private openInNewTab(file: TFile): void {
		const leaf = this.app.workspace.getLeaf("tab");
		void leaf.openFile(file);
	}

	private cleanupPastNotes(): void {
		if (this.observer) {
			this.observer.disconnect();
			this.observer = null;
		}
		for (const block of this.pastNoteBlocks) {
			block.unload();
		}
		this.pastNoteBlocks = [];
		this.loadedPastCount = 0;
		if (this.pastNotesContainer) {
			this.pastNotesContainer.remove();
			this.pastNotesContainer = null;
		}
		this.sentinelEl = null;
	}

	async onClose(): Promise<void> {
		this.cleanupPastNotes();
		await super.onClose();
	}
}
