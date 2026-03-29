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
	const targetEl = containerEl.createEl("span", { cls: "journal-hover-target" });

	const hoverParent = {
		hoverPopover: null as HoverPopover | null,
	};

	const linktext = file.path.replace(/\.md$/, "");
	plugin.app.workspace.trigger("hover-link", {
		event: new MouseEvent("mouseover", { clientX: 0, clientY: 0 }),
		source: VIEW_TYPE_JOURNAL,
		hoverParent: hoverParent,
		targetEl: targetEl,
		linktext: linktext,
		sourcePath: "",
	});

	// Poll rapidly to catch the popover before its show() timer fires.
	// Page Preview creates the popover async within onLinkHover, then
	// show() runs after a ~300ms timer. We need to intercept in between.
	const popover = await new Promise<HoverPopover | null>((resolve) => {
		let elapsed = 0;
		const interval = setInterval(() => {
			elapsed += 10;
			const p = hoverParent.hoverPopover;
			if (p) {
				clearInterval(interval);
				resolve(p);
			} else if (elapsed >= 5000) {
				clearInterval(interval);
				resolve(null);
			}
		}, 10);
	});

	if (!popover || !popover.hoverEl) {
		targetEl.remove();
		return null;
	}

	const popoverAny = popover as unknown as Record<string, unknown>;

	// Immediately hide the hoverEl so it doesn't flash as a floating box.
	// We'll show it after reparenting into our container.
	popover.hoverEl.addClass("journal-popover-hidden");

	// Helper: move hoverEl into our container and clear inline sizing
	const reparent = () => {
		if (popover.hoverEl && popover.hoverEl.parentElement !== containerEl) {
			containerEl.appendChild(popover.hoverEl);
			// Clear inline width/height/top/left set by Obsidian's positioning
			popover.hoverEl.removeAttribute("style");
			// Reveal after reparenting
			popover.hoverEl.removeClass("journal-popover-hidden");
		}
	};

	// Save the original show method — it loads the file content via onShow/showPreview
	const originalShow = popoverAny.show as ((...args: unknown[]) => void) | undefined;

	// Override show() to redirect the hoverEl into our container
	popoverAny.show = function (...args: unknown[]) {
		// Call original to trigger content loading
		if (originalShow) {
			originalShow.apply(popover, args);
		}
		// Reparent from document.body into our container
		reparent();
	};

	// Prevent auto-dismiss and floating behavior
	popoverAny.hide = () => {};
	popoverAny.onMouseOut = () => {};
	popoverAny.shouldShowSelf = () => true;
	popoverAny.shouldShow = () => true;
	popoverAny.position = () => {};
	popoverAny.transition = () => {};
	popoverAny.watchResize = () => {};
	popoverAny.detect = () => {};

	// Watch for Obsidian moving the hoverEl back to document.body
	const observer = new MutationObserver(() => {
		if (popover.hoverEl && popover.hoverEl.parentElement !== containerEl) {
			reparent();
		}
	});
	observer.observe(document.body, { childList: true });

	// Wait for show() to fire and content to render, then finalize.
	// Page Preview's default wait is ~300ms, so 400ms should be enough.
	await new Promise<void>((resolve) => {
		setTimeout(() => {
			requestAnimationFrame(() => {
				reparent();
				observer.disconnect();
				resolve();
			});
		}, 400);
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
