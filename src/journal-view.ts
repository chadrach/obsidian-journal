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
 * Creates a Page Preview popover for a file and embeds it inline.
 *
 * The flow:
 * 1. Trigger hover-link → Page Preview creates a HoverPopover on hoverParent
 * 2. The popover is created synchronously but show() fires on a timer
 * 3. We intercept the popover immediately and override show() to embed
 *    the hoverEl in our container instead of floating on document.body
 * 4. Override hide/position/onMouseOut to prevent auto-dismiss
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

	// The popover is assigned to hoverParent synchronously during the event.
	// Intercept it NOW, before the timer fires show().
	const popover = hoverParent.hoverPopover;
	if (!popover || !popover.hoverEl) {
		targetEl.remove();
		return null;
	}

	const popoverAny = popover as unknown as Record<string, unknown>;

	// Save the original show method — it loads the file content
	const originalShow = popoverAny.show as (() => void) | undefined;

	// Override show() to embed inline instead of floating on document.body
	popoverAny.show = function () {
		// Call the original show to trigger content loading (showPreview, etc.)
		if (originalShow) {
			originalShow.call(popover);
		}

		// Immediately reparent into our container (show() appends to document.body)
		if (popover.hoverEl.parentElement !== containerEl) {
			containerEl.appendChild(popover.hoverEl);
		}
	};

	// Prevent auto-dismiss behavior
	popoverAny.hide = () => {};
	popoverAny.onMouseOut = () => {};
	popoverAny.shouldShowSelf = () => true;

	// Override position() to no-op — we don't want floating positioning
	popoverAny.position = () => {};

	// Wait for the show timer to fire and content to render
	await new Promise<void>((resolve) => {
		// Page Preview's default waitTime is ~300ms, give it plenty of time
		setTimeout(() => {
			requestAnimationFrame(() => {
				// Ensure it's in our container after all async work
				if (popover.hoverEl.parentElement !== containerEl) {
					containerEl.appendChild(popover.hoverEl);
				}
				resolve();
			});
		}, 500);
	});

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
