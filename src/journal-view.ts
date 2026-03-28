import {
	HoverPopover,
	ItemView,
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
 * The main journal view — a scrollable, reverse-chronological list of daily
 * notes, each with its own embedded editor via Page Preview's HoverPopover.
 */
export class JournalView extends ItemView {
	private plugin: JournalPlugin;
	private scrollContainer: HTMLElement | null = null;
	private allEntries: DailyNoteEntry[] = [];
	private config: DailyNotesConfig | null = null;
	private popovers: HoverPopover[] = [];

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

		// Scrollable container
		this.scrollContainer = contentEl.createDiv({ cls: "journal-container" });

		// Load entries
		this.allEntries = findExistingDailyNotes(this.app, this.config);

		// For each daily note, create a section and try to trigger a Page Preview popover
		const maxEntries = Math.min(this.allEntries.length, 5); // limit for diagnostic
		for (let i = 0; i < maxEntries; i++) {
			const entry = this.allEntries[i]!;
			await this.createNoteSection(entry);
		}

		// Vault events
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

	private async createNoteSection(entry: DailyNoteEntry): Promise<void> {
		if (!this.scrollContainer) return;

		const block = this.scrollContainer.createDiv({ cls: "journal-note-block" });

		// Date header
		const headerEl = block.createDiv({ cls: "journal-note-header" });
		const dateLabel = entry.date.calendar(null, {
			sameDay: "[Today] — dddd, MMMM D, YYYY",
			lastDay: "[Yesterday] — dddd, MMMM D, YYYY",
			lastWeek: "dddd, MMMM D, YYYY",
			sameElse: "dddd, MMMM D, YYYY",
		});
		headerEl.createEl("span", { text: dateLabel, cls: "journal-note-date" });

		headerEl.addEventListener("click", () => {
			const leaf = this.app.workspace.getLeaf("tab");
			void leaf.openFile(entry.file);
		});

		// Editor area — this is where we'll try to embed a Page Preview popover
		const editorEl = block.createDiv({ cls: "journal-note-editor" });

		// Create a fake link target that Page Preview can latch onto
		const targetEl = editorEl.createEl("span", {
			cls: "journal-hover-target",
			text: entry.file.basename,
		});

		// Create a HoverParent that Page Preview expects
		const hoverParent = {
			hoverPopover: null as HoverPopover | null,
		};

		// Trigger the hover-link event that Page Preview listens for
		this.app.workspace.trigger("hover-link", {
			event: new MouseEvent("mouseover", {
				clientX: 100,
				clientY: 100,
			}),
			source: "daily-journal",
			hoverParent: hoverParent,
			targetEl: targetEl,
			linktext: entry.file.path,
			sourcePath: "",
		});

		// Wait for Page Preview to create the popover
		await new Promise<void>((resolve) => {
			let checks = 0;
			const interval = setInterval(() => {
				checks++;
				if (hoverParent.hoverPopover || checks > 20) {
					clearInterval(interval);
					resolve();
				}
			}, 100);
		});

		if (hoverParent.hoverPopover) {
			const popover = hoverParent.hoverPopover;
			this.popovers.push(popover);

			// eslint-disable-next-line no-console
			console.log(
				"Journal: Page Preview popover created for", entry.file.path,
				"\n  popover type:", popover.constructor.name,
				"\n  hoverEl classes:", popover.hoverEl?.className,
				"\n  hoverEl size:", popover.hoverEl?.offsetWidth, "x", popover.hoverEl?.offsetHeight,
				"\n  state:", popover.state,
				"\n  hoverEl children:", popover.hoverEl?.childElementCount,
				"\n  hoverEl innerHTML (2000):", popover.hoverEl?.innerHTML?.slice(0, 2000),
				"\n  all popover properties:", Object.getOwnPropertyNames(popover),
				"\n  popover prototype methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(popover)),
			);

			// Try to reparent the popover's hoverEl into our container
			// instead of it floating on document.body
			if (popover.hoverEl) {
				editorEl.appendChild(popover.hoverEl);
				editorEl.addClass("journal-has-popover");
			}
		} else {
			// eslint-disable-next-line no-console
			console.log("Journal: No popover created for", entry.file.path,
				"(Page Preview may be disabled or not responding to our event)");
			editorEl.createEl("em", {
				text: "No popover created",
				cls: "journal-no-popover",
			});
		}
	}

	private onFileCreated(file: TAbstractFile): void {
		if (!(file instanceof TFile) || !this.config) return;
		const date = moment(file.basename, this.config.format, true);
		if (!date.isValid()) return;
		this.allEntries = findExistingDailyNotes(this.app, this.config);
	}

	private onFileDeleted(_file: TAbstractFile): void {
		if (this.config) {
			this.allEntries = findExistingDailyNotes(this.app, this.config);
		}
	}

	private onFileRenamed(): void {
		if (this.config) {
			this.allEntries = findExistingDailyNotes(this.app, this.config);
		}
	}

	async onClose(): Promise<void> {
		for (const popover of this.popovers) {
			popover.unload();
		}
		this.popovers = [];
	}
}
