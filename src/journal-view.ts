import {
	HoverPopover,
	ItemView,
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
 * Creates a Page Preview popover for a file, prevents it from auto-dismissing,
 * and reparents it into the given container element.
 */
async function createInlinePopover(
	plugin: JournalPlugin,
	file: TFile,
	containerEl: HTMLElement,
): Promise<HoverPopover | null> {
	// Create a target element that Page Preview latches onto
	const targetEl = containerEl.createEl("span", { cls: "journal-hover-target" });

	// HoverParent interface — Page Preview assigns the popover here
	const hoverParent = {
		hoverPopover: null as HoverPopover | null,
	};

	// Trigger the hover-link event — Page Preview creates the popover
	const linktext = file.path.replace(/\.md$/, "");
	plugin.app.workspace.trigger("hover-link", {
		event: new MouseEvent("mouseover", { clientX: 0, clientY: 0 }),
		source: VIEW_TYPE_JOURNAL,
		hoverParent: hoverParent,
		targetEl: targetEl,
		linktext: linktext,
		sourcePath: "",
	});

	// Wait for Page Preview to create and show the popover
	await new Promise<void>((resolve) => {
		let elapsed = 0;
		const interval = setInterval(() => {
			elapsed += 50;
			if (hoverParent.hoverPopover || elapsed >= 5000) {
				clearInterval(interval);
				resolve();
			}
		}, 50);
	});

	const popover = hoverParent.hoverPopover;
	if (!popover || !popover.hoverEl) {
		targetEl.remove();
		return null;
	}

	// Prevent the popover from auto-dismissing.
	// These methods exist at runtime but aren't in the public type definitions.
	const popoverAny = popover as unknown as Record<string, unknown>;
	popoverAny.hide = () => {};
	popoverAny.onMouseOut = () => {};
	popoverAny.shouldShowSelf = () => true;

	// Wait for content to render (showPreview fires via requestAnimationFrame)
	await new Promise<void>((resolve) => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => resolve());
		});
	});

	// Reparent the hoverEl from document.body into our container
	containerEl.appendChild(popover.hoverEl);

	return popover;
}

/**
 * The main journal view — a scrollable, reverse-chronological list of daily
 * notes, each rendered via Page Preview's native editable popover.
 */
export class JournalView extends ItemView {
	private plugin: JournalPlugin;
	private scrollContainer: HTMLElement | null = null;
	private allEntries: DailyNoteEntry[] = [];
	private loadedCount = 0;
	private config: DailyNotesConfig | null = null;
	private popovers: HoverPopover[] = [];
	private sentinelEl: HTMLElement | null = null;
	private loadMoreObserver: IntersectionObserver | null = null;

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

		// Auto-create today's note
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

		this.scrollContainer = contentEl.createDiv({ cls: "journal-container" });
		this.allEntries = findExistingDailyNotes(this.app, this.config);
		this.loadedCount = 0;

		// Load first batch
		await this.loadNextBatch();

		// Infinite scroll
		this.setupInfiniteScroll();

		// Vault events
		this.registerEvent(
			this.app.vault.on("create", (f) => {
				if (f instanceof TFile && this.config) {
					this.allEntries = findExistingDailyNotes(this.app, this.config);
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", () => {
				if (this.config) {
					this.allEntries = findExistingDailyNotes(this.app, this.config);
				}
			}),
		);
	}

	private async loadNextBatch(): Promise<void> {
		if (!this.scrollContainer || !this.config) return;

		const batchSize = this.plugin.settings.notesPerBatch;
		const end = Math.min(this.loadedCount + batchSize, this.allEntries.length);

		// Remove sentinel
		if (this.sentinelEl) {
			this.sentinelEl.remove();
			this.sentinelEl = null;
		}

		for (let i = this.loadedCount; i < end; i++) {
			const entry = this.allEntries[i]!;
			await this.createNoteSection(entry);
		}

		this.loadedCount = end;

		// Sentinel for loading more
		if (this.loadedCount < this.allEntries.length && this.scrollContainer) {
			this.sentinelEl = this.scrollContainer.createDiv({ cls: "journal-sentinel" });
			if (this.loadMoreObserver) {
				this.loadMoreObserver.observe(this.sentinelEl);
			}
		}
	}

	private async createNoteSection(entry: DailyNoteEntry): Promise<void> {
		if (!this.scrollContainer) return;

		const block = this.scrollContainer.createDiv({ cls: "journal-note-block" });

		// Date header
		const headerEl = block.createDiv({ cls: "journal-note-header" });
		if (this.plugin.settings.hideFilename) {
			headerEl.addClass("journal-note-header-hidden");
		}

		const dateLabel = entry.date.calendar(null, {
			sameDay: "[Today] — dddd, MMMM D, YYYY",
			lastDay: "[Yesterday] — dddd, MMMM D, YYYY",
			lastWeek: "dddd, MMMM D, YYYY",
			sameElse: "dddd, MMMM D, YYYY",
		});

		headerEl.createEl("span", { text: dateLabel, cls: "journal-note-date" });

		const openBtn = headerEl.createEl("span", {
			cls: "journal-note-open-btn",
			attr: { "aria-label": "Open in new tab" },
		});
		openBtn.textContent = "↗";
		openBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			const leaf = this.app.workspace.getLeaf("tab");
			void leaf.openFile(entry.file);
		});

		headerEl.addEventListener("click", () => {
			const leaf = this.app.workspace.getLeaf("tab");
			void leaf.openFile(entry.file);
		});

		// Editor area — create Page Preview popover inline
		const editorEl = block.createDiv({ cls: "journal-note-editor" });

		const popover = await createInlinePopover(this.plugin, entry.file, editorEl);
		if (popover) {
			this.popovers.push(popover);
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

	async onClose(): Promise<void> {
		if (this.loadMoreObserver) {
			this.loadMoreObserver.disconnect();
			this.loadMoreObserver = null;
		}
		for (const popover of this.popovers) {
			popover.unload();
		}
		this.popovers = [];
	}
}
