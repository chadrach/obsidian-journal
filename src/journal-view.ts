import {
	Component,
	ItemView,
	TAbstractFile,
	TFile,
	WorkspaceLeaf,
	WorkspaceSplit,
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

// WorkspaceSplit constructor is not typed but the class is public.
// At runtime it accepts (workspace, direction).
// containerEl exists at runtime but is not in the public typings.
type ConstructableWorkspaceSplit = new (
	workspace: unknown,
	direction: string,
) => WorkspaceSplit & { containerEl: HTMLElement };

/**
 * An embedded editor for a single daily note.
 *
 * Creates a detached WorkspaceSplit, spawns a real WorkspaceLeaf inside it,
 * and opens the file as a MarkdownView. The split's containerEl is inserted
 * inline in the journal scroll view, giving us a fully-functional Obsidian
 * editor (Live Preview, backlinks, commands, etc.) without a visible tab.
 *
 * This is the same fundamental technique used by the Hover Editor plugin
 * and Obsidian's own Page Preview editing feature.
 */
class EmbeddedNoteEditor extends Component {
	private plugin: JournalPlugin;
	private file: TFile;
	private date: ReturnType<typeof moment>;
	private containerEl: HTMLElement;
	private editorEl: HTMLElement;
	private split: (WorkspaceSplit & { containerEl: HTMLElement }) | null = null;
	private leaf: WorkspaceLeaf | null = null;
	private mounted = false;
	private cachedHeight: number | null = null;
	private onOpenInTab: (file: TFile) => void;

	constructor(
		plugin: JournalPlugin,
		file: TFile,
		date: ReturnType<typeof moment>,
		parentEl: HTMLElement,
		onOpenInTab: (file: TFile) => void,
	) {
		super();
		this.plugin = plugin;
		this.file = file;
		this.date = date;
		this.onOpenInTab = onOpenInTab;

		// Outer container
		this.containerEl = parentEl.createDiv({ cls: "journal-note-block" });

		// Date header
		const headerEl = this.containerEl.createDiv({ cls: "journal-note-header" });
		if (this.plugin.settings.hideFilename) {
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
			this.onOpenInTab(this.file);
		});

		headerEl.addEventListener("click", () => {
			this.onOpenInTab(this.file);
		});

		// Editor mount point
		this.editorEl = this.containerEl.createDiv({ cls: "journal-note-editor" });
	}

	/**
	 * Mount the embedded editor: create a detached WorkspaceSplit,
	 * spawn a leaf, and open the file.
	 */
	async mountEditor(): Promise<void> {
		if (this.mounted) return;
		this.mounted = true;

		try {
			const workspace = this.plugin.app.workspace;

			// Create a detached WorkspaceSplit
			this.split = new (WorkspaceSplit as unknown as ConstructableWorkspaceSplit)(
				workspace,
				"vertical",
			);

			// Override getRoot so Obsidian's layout engine can resolve the split
			this.split.getRoot = () =>
				workspace.rootSplit as unknown as ReturnType<WorkspaceSplit["getRoot"]>;

			// Insert the split's container element into our DOM
			this.editorEl.appendChild(this.split.containerEl);

			// Create a real leaf inside the split
			this.leaf = workspace.createLeafInParent(this.split, 0);

			// Open the file as a markdown view in source/live-preview mode
			await this.leaf.openFile(this.file, {
				state: { mode: "source" },
			});

			// Force flow-layout on all workspace elements via inline styles.
			// Obsidian's CSS uses high-specificity selectors or JS-set styles
			// that beat our stylesheet !important overrides.
			this.forceFlowLayout(this.split.containerEl);

			// Strip view header (title bar) — we have our own date header
			const viewHeader = this.split.containerEl.querySelector(".view-header");
			if (viewHeader instanceof HTMLElement) {
				viewHeader.addClass("journal-hidden");
			}

			// Hide inline title if present
			const inlineTitle = this.split.containerEl.querySelector(".inline-title");
			if (inlineTitle instanceof HTMLElement && this.plugin.settings.hideH1) {
				inlineTitle.addClass("journal-hidden");
			}

			// Debug: log computed styles + full DOM
			const cs = getComputedStyle(this.split.containerEl);
			// eslint-disable-next-line no-console
			console.log(
				"Journal: mounted editor for", this.file.path,
				"\n  split.containerEl computed:", {
					display: cs.display,
					position: cs.position,
					height: cs.height,
					overflow: cs.overflow,
					flex: cs.flex,
					inset: cs.inset,
				},
				"\n  split.containerEl size:", this.split.containerEl.offsetWidth, "x", this.split.containerEl.offsetHeight,
				"\n  editorEl size:", this.editorEl.offsetWidth, "x", this.editorEl.offsetHeight,
				"\n  leaf view type:", this.leaf.view?.getViewType(),
				"\n  full DOM:", this.editorEl.innerHTML.slice(0, 1500),
			);
		} catch (e) {
			console.error("Journal: failed to mount editor for", this.file.path, e);
			this.mounted = false;
		}
	}

	/**
	 * Unmount the editor to free resources when scrolled out of view.
	 * Preserves the height to prevent scroll jumps.
	 */
	unmountEditor(): void {
		if (!this.mounted) return;

		// Cache height before unmounting
		const rect = this.editorEl.getBoundingClientRect();
		if (rect.height > 0) {
			this.cachedHeight = rect.height;
		}

		// Detach the leaf (this destroys the MarkdownView)
		if (this.leaf) {
			this.leaf.detach();
			this.leaf = null;
		}

		this.split = null;
		this.editorEl.empty();

		// Set min-height to prevent scroll jump
		if (this.cachedHeight) {
			this.editorEl.setCssProps({ "--journal-cached-height": `${this.cachedHeight}px` });
		}

		this.mounted = false;
	}

	/**
	 * Force all workspace elements inside the embedded editor to use
	 * flow layout instead of Obsidian's default absolute positioning.
	 */
	private forceFlowLayout(root: HTMLElement): void {
		const selectors = [
			".workspace-split",
			".workspace-leaf",
			".workspace-leaf-content",
			".view-content",
			".markdown-source-view",
			".cm-editor",
		];

		// Also apply to root itself (it IS the workspace-split)
		const targets = [root];
		for (const sel of selectors) {
			const found = root.querySelectorAll(sel);
			found.forEach((el) => {
				if (el instanceof HTMLElement) targets.push(el);
			});
		}

		for (const el of targets) {
			el.addClass("journal-flow-layout");
		}

		// CM scroller needs special treatment
		const scroller = root.querySelector(".cm-scroller");
		if (scroller instanceof HTMLElement) {
			scroller.addClass("journal-flow-scroller");
		}
	}

	isMounted(): boolean {
		return this.mounted;
	}

	getFile(): TFile {
		return this.file;
	}

	getContainerEl(): HTMLElement {
		return this.containerEl;
	}

	onunload(): void {
		if (this.leaf) {
			this.leaf.detach();
			this.leaf = null;
		}
		this.split = null;
		this.containerEl.remove();
	}
}

/**
 * The main journal view — a scrollable, reverse-chronological list of daily
 * notes, each with its own embedded Live Preview editor.
 *
 * Every visible note gets a real Obsidian MarkdownView via an embedded
 * WorkspaceLeaf. Notes that scroll out of the viewport are unmounted to
 * save resources.
 */
export class JournalView extends ItemView {
	private plugin: JournalPlugin;
	private scrollContainer: HTMLElement | null = null;
	private noteEditors: EmbeddedNoteEditor[] = [];
	private allEntries: DailyNoteEntry[] = [];
	private loadedCount = 0;
	private sentinelEl: HTMLElement | null = null;
	private loadMoreObserver: IntersectionObserver | null = null;
	private visibilityObserver: IntersectionObserver | null = null;
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

		// Auto-create today's note (wrapped in try/catch so it never blocks the view)
		if (this.plugin.settings.autoCreateToday) {
			try {
				const todayPath = getDailyNotePath(moment(), this.config);
				if (!this.app.vault.getAbstractFileByPath(todayPath)) {
					await createDailyNote(this.app, moment(), this.config);
				}
			} catch (e) {
				console.warn("Journal: could not auto-create today's note", e);
			}
		}

		// Scrollable container
		this.scrollContainer = contentEl.createDiv({ cls: "journal-container" });

		// Set up observers before loading notes so editors can be observed immediately
		this.setupInfiniteScroll();
		this.setupVisibilityObserver();

		// Load notes (will observe + eagerly mount initial batch)
		await this.loadNotes();

		// Vault events
		this.registerEvent(
			this.app.vault.on("modify", (f) => this.onFileModified(f)),
		);
		this.registerEvent(
			this.app.vault.on("create", (f) => this.onFileCreated(f)),
		);
		this.registerEvent(
			this.app.vault.on("delete", (f) => this.onFileDeleted(f)),
		);
		this.registerEvent(
			this.app.vault.on("rename", () => this.onFileRenamed()),
		);
	}

	private async loadNotes(): Promise<void> {
		if (!this.config) return;

		this.allEntries = findExistingDailyNotes(this.app, this.config);
		this.loadedCount = 0;
		this.clearEditors();
		await this.loadNextBatch();
	}

	private async loadNextBatch(): Promise<void> {
		if (!this.scrollContainer || !this.config) return;

		const batchSize = this.plugin.settings.notesPerBatch;
		const end = Math.min(this.loadedCount + batchSize, this.allEntries.length);
		const isFirstBatch = this.loadedCount === 0;

		// Remove sentinel
		if (this.sentinelEl) {
			this.sentinelEl.remove();
			this.sentinelEl = null;
		}

		const newEditors: EmbeddedNoteEditor[] = [];

		for (let i = this.loadedCount; i < end; i++) {
			const entry = this.allEntries[i]!;

			const editor = new EmbeddedNoteEditor(
				this.plugin,
				entry.file,
				entry.date,
				this.scrollContainer,
				(file) => this.openInNewTab(file),
			);
			this.addChild(editor);
			this.noteEditors.push(editor);
			newEditors.push(editor);

			// Observe for viewport visibility (mount/unmount on scroll)
			if (this.visibilityObserver) {
				this.visibilityObserver.observe(editor.getContainerEl());
			}
		}

		this.loadedCount = end;

		// Eagerly mount editors in the first batch — IntersectionObserver
		// fires asynchronously so initial visible entries may not trigger
		// immediately. For subsequent batches the observer handles it.
		if (isFirstBatch) {
			for (const editor of newEditors) {
				try {
					await editor.mountEditor();
				} catch (e) {
					console.error("Journal: eager mount failed", e);
				}
			}
		}

		// Sentinel for loading more
		if (this.loadedCount < this.allEntries.length) {
			this.sentinelEl = this.scrollContainer.createDiv({
				cls: "journal-sentinel",
			});
			if (this.loadMoreObserver) {
				this.loadMoreObserver.observe(this.sentinelEl);
			}
		}
	}

	private setupInfiniteScroll(): void {
		if (!this.scrollContainer) return;

		this.loadMoreObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting && this.loadedCount < this.allEntries.length) {
						void this.loadNextBatch();
					}
				}
			},
			{
				root: this.scrollContainer,
				rootMargin: "300px",
			},
		);

		if (this.sentinelEl) {
			this.loadMoreObserver.observe(this.sentinelEl);
		}
	}

	/**
	 * Observe which note blocks are in/near the viewport.
	 * Mount editors when they enter; unmount when they leave.
	 */
	private setupVisibilityObserver(): void {
		if (!this.scrollContainer) return;

		this.visibilityObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const el = entry.target as HTMLElement;
					const editor = this.noteEditors.find(
						(e) => e.getContainerEl() === el,
					);
					if (!editor) continue;

					if (entry.isIntersecting) {
						if (!editor.isMounted()) {
							void editor.mountEditor();
						}
					} else {
						if (editor.isMounted()) {
							editor.unmountEditor();
						}
					}
				}
			},
			{
				root: this.scrollContainer,
				// Mount editors a full viewport before they scroll into view
				rootMargin: "100% 0px",
			},
		);

		for (const editor of this.noteEditors) {
			this.visibilityObserver.observe(editor.getContainerEl());
		}
	}

	private clearEditors(): void {
		for (const editor of this.noteEditors) {
			this.removeChild(editor);
		}
		this.noteEditors = [];
		if (this.scrollContainer) {
			this.scrollContainer.empty();
		}
	}

	private openInNewTab(file: TFile): void {
		const leaf = this.app.workspace.getLeaf("tab");
		void leaf.openFile(file);
	}

	// ── Vault event handlers ────────────────────────────────────────

	private isRelevantFile(file: TAbstractFile): boolean {
		if (!(file instanceof TFile) || file.extension !== "md" || !this.config) {
			return false;
		}
		const prefix = this.config.folder ? this.config.folder + "/" : "";
		return file.path.startsWith(prefix);
	}

	private onFileModified(_file: TAbstractFile): void {
		// Embedded MarkdownViews handle their own file-change syncing.
		// No action needed.
	}

	private onFileCreated(file: TAbstractFile): void {
		if (!this.isRelevantFile(file) || !this.config) return;
		if (!(file instanceof TFile)) return;
		const date = moment(file.basename, this.config.format, true);
		if (!date.isValid()) return;
		void this.loadNotes();
	}

	private onFileDeleted(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;
		const idx = this.noteEditors.findIndex((e) => e.getFile().path === file.path);
		if (idx !== -1) {
			const editor = this.noteEditors[idx]!;
			this.removeChild(editor);
			this.noteEditors.splice(idx, 1);
			this.allEntries = this.allEntries.filter((e) => e.file.path !== file.path);
			this.loadedCount = Math.max(0, this.loadedCount - 1);
		}
	}

	private onFileRenamed(): void {
		if (this.config) {
			void this.loadNotes();
		}
	}

	// ── Cleanup ─────────────────────────────────────────────────────

	async onClose(): Promise<void> {
		if (this.loadMoreObserver) {
			this.loadMoreObserver.disconnect();
			this.loadMoreObserver = null;
		}
		if (this.visibilityObserver) {
			this.visibilityObserver.disconnect();
			this.visibilityObserver = null;
		}
		this.clearEditors();
	}
}
