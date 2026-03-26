import { ItemView, TAbstractFile, TFile, WorkspaceLeaf, moment } from "obsidian";
import { VIEW_TYPE_JOURNAL, JOURNAL_ICON } from "./constants";
import { NoteBlock } from "./note-block";
import {
	createDailyNote,
	findExistingDailyNotes,
	getDailyNotesConfig,
	getDailyNotePath,
	type DailyNoteEntry,
	type DailyNotesConfig,
} from "./daily-notes-utils";
import type JournalPlugin from "./main";

export class JournalView extends ItemView {
	private plugin: JournalPlugin;
	private noteBlocks: NoteBlock[] = [];
	private allEntries: DailyNoteEntry[] = [];
	private loadedCount = 0;
	private scrollContainer: HTMLElement | null = null;
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
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("journal-view");

		this.config = getDailyNotesConfig(this.app, this.plugin.settings);

		// Auto-create today's note if enabled
		if (this.plugin.settings.autoCreateToday) {
			const todayPath = getDailyNotePath(moment(), this.config);
			const existing = this.app.vault.getAbstractFileByPath(todayPath);
			if (!existing) {
				await createDailyNote(this.app, moment(), this.config);
			}
		}

		// Create scrollable container
		this.scrollContainer = contentEl.createDiv({ cls: "journal-container" });

		// Load daily notes
		await this.loadNotes();

		// Set up infinite scroll
		this.setupInfiniteScroll();

		// Watch for file changes
		this.registerEvent(
			this.app.vault.on("modify", (file) => this.onFileModified(file))
		);
		this.registerEvent(
			this.app.vault.on("create", (file) => this.onFileCreated(file))
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => this.onFileDeleted(file))
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => this.onFileRenamed(file, oldPath))
		);
	}

	private async loadNotes(): Promise<void> {
		if (!this.config) return;

		this.allEntries = findExistingDailyNotes(this.app, this.config);
		this.loadedCount = 0;
		this.clearNoteBlocks();
		await this.loadNextBatch();
	}

	private async loadNextBatch(): Promise<void> {
		if (!this.scrollContainer || !this.config) return;

		const batchSize = this.plugin.settings.notesPerBatch;
		const end = Math.min(this.loadedCount + batchSize, this.allEntries.length);

		// Remove sentinel before adding new notes
		if (this.sentinelEl) {
			this.sentinelEl.remove();
			this.sentinelEl = null;
		}

		for (let i = this.loadedCount; i < end; i++) {
			const entry = this.allEntries[i]!;
			const isToday = entry.date.isSame(moment(), "day");

			const block = new NoteBlock(
				this.app,
				entry.file,
				entry.date,
				this.scrollContainer,
				this.plugin.settings,
				this.config,
				isToday, // Today's note starts in edit mode
				(file) => this.openInNewTab(file),
			);
			this.addChild(block);
			this.noteBlocks.push(block);
		}

		this.loadedCount = end;

		// Re-add sentinel if there are more notes to load
		if (this.loadedCount < this.allEntries.length) {
			this.sentinelEl = this.scrollContainer.createDiv({ cls: "journal-sentinel" });
			// Re-observe the new sentinel
			if (this.observer) {
				this.observer.observe(this.sentinelEl);
			}
		}
	}

	private setupInfiniteScroll(): void {
		if (!this.scrollContainer) return;

		this.observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting && this.loadedCount < this.allEntries.length) {
						void this.loadNextBatch();
					}
				}
			},
			{
				root: this.scrollContainer,
				rootMargin: "200px",
			}
		);

		if (this.sentinelEl) {
			this.observer.observe(this.sentinelEl);
		}
	}

	private clearNoteBlocks(): void {
		for (const block of this.noteBlocks) {
			this.removeChild(block);
		}
		this.noteBlocks = [];
		if (this.scrollContainer) {
			this.scrollContainer.empty();
		}
	}

	private openInNewTab(file: TFile): void {
		const leaf = this.app.workspace.getLeaf("tab");
		void leaf.openFile(file);
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
		const block = this.noteBlocks.find(b => b.getFile().path === file.path);
		if (block) {
			void block.refreshContent();
		}
	}

	private onFileCreated(file: TAbstractFile): void {
		if (!this.isRelevantFile(file) || !this.config) return;
		if (!(file instanceof TFile)) return;

		// Check if this file matches the daily note format
		const date = moment(file.basename, this.config.format, true);
		if (!date.isValid()) return;

		// Reload all notes to maintain sort order
		void this.loadNotes();
	}

	private onFileDeleted(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;
		const blockIndex = this.noteBlocks.findIndex(b => b.getFile().path === file.path);
		if (blockIndex !== -1) {
			const block = this.noteBlocks[blockIndex]!;
			this.removeChild(block);
			this.noteBlocks.splice(blockIndex, 1);
			// Also remove from allEntries
			this.allEntries = this.allEntries.filter(e => e.file.path !== file.path);
			this.loadedCount = Math.max(0, this.loadedCount - 1);
		}
	}

	private onFileRenamed(file: TAbstractFile, _oldPath: string): void {
		if (!this.isRelevantFile(file)) return;
		// Easiest to just reload
		void this.loadNotes();
	}

	async onClose(): Promise<void> {
		if (this.observer) {
			this.observer.disconnect();
			this.observer = null;
		}
		this.clearNoteBlocks();
	}
}
