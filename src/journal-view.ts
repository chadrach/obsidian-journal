/* eslint-disable obsidianmd/ui/sentence-case */
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
 * Diagnostic journal view — tests Page Preview HoverPopover embedding.
 * Tries multiple approaches to create editable popovers for daily notes.
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

		this.scrollContainer = contentEl.createDiv({ cls: "journal-container" });
		this.allEntries = findExistingDailyNotes(this.app, this.config);

		// Test with the first entry only
		if (this.allEntries.length > 0) {
			const entry = this.allEntries[0]!;
			await this.testApproaches(entry);
		}

		this.registerEvent(
			this.app.vault.on("create", (f) => {
				if (f instanceof TFile && this.config) {
					this.allEntries = findExistingDailyNotes(this.app, this.config);
				}
			}),
		);
	}

	private async testApproaches(entry: DailyNoteEntry): Promise<void> {
		if (!this.scrollContainer) return;

		// ── Approach A: Direct HoverPopover constructor ──
		const blockA = this.scrollContainer.createDiv({ cls: "journal-note-block" });
		blockA.createEl("h3", { text: "Approach A: direct HoverPopover constructor" });

		const targetA = blockA.createDiv({ cls: "journal-hover-target" });
		targetA.textContent = entry.file.basename;

		const parentA = { hoverPopover: null as HoverPopover | null };

		try {
			const popover = new HoverPopover(parentA, targetA, 0);
			parentA.hoverPopover = popover;
			this.popovers.push(popover);

			// Wait a frame for initialization
			await new Promise<void>((resolve) => {
				requestAnimationFrame(() => resolve());
			});

			// eslint-disable-next-line no-console
			console.log(
				"Journal [A] Direct constructor:",
				"\n  popover:", popover,
				"\n  hoverEl:", popover.hoverEl,
				"\n  hoverEl classes:", popover.hoverEl?.className,
				"\n  hoverEl parent:", popover.hoverEl?.parentElement?.tagName,
				"\n  state:", popover.state,
				"\n  all own props:", Object.keys(popover),
				"\n  prototype methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(popover)),
			);

			if (popover.hoverEl) {
				blockA.appendChild(popover.hoverEl);
				blockA.createEl("p", { text: `hoverEl found, classes: ${popover.hoverEl.className}` });
			} else {
				blockA.createEl("p", { text: "No hoverEl created" });
			}
		} catch (e) {
			console.error("Journal [A] Error:", e);
			blockA.createEl("p", { text: `Error: ${String(e)}` });
		}

		// ── Approach B: hover-link event with our registered source ──
		const blockB = this.scrollContainer.createDiv({ cls: "journal-note-block" });
		blockB.createEl("h3", { text: "Approach B: hover-link with registered source" });

		const targetB = blockB.createDiv({ cls: "journal-hover-target" });
		targetB.textContent = entry.file.basename;

		const parentB = { hoverPopover: null as HoverPopover | null };

		// linktext without .md extension (how internal links work)
		const linktext = entry.file.path.replace(/\.md$/, "");

		this.app.workspace.trigger("hover-link", {
			event: new MouseEvent("mouseover", { clientX: 200, clientY: 200 }),
			source: VIEW_TYPE_JOURNAL,
			hoverParent: parentB,
			targetEl: targetB,
			linktext: linktext,
			sourcePath: "",
		});

		await this.waitForPopover(parentB, 3000);

		// eslint-disable-next-line no-console
		console.log("Journal [B] hover-link (our source):", {
			popoverCreated: !!parentB.hoverPopover,
			popover: parentB.hoverPopover,
			hoverEl: parentB.hoverPopover?.hoverEl,
			state: parentB.hoverPopover?.state,
		});

		if (parentB.hoverPopover?.hoverEl) {
			blockB.appendChild(parentB.hoverPopover.hoverEl);
			this.popovers.push(parentB.hoverPopover);
			blockB.createEl("p", { text: "Popover created and reparented" });
		} else {
			blockB.createEl("p", { text: "No popover created" });
		}

		// ── Approach C: hover-link with "preview" source ──
		const blockC = this.scrollContainer.createDiv({ cls: "journal-note-block" });
		blockC.createEl("h3", { text: "Approach C: hover-link with 'preview' source" });

		const targetC = blockC.createDiv({ cls: "journal-hover-target" });
		targetC.textContent = entry.file.basename;

		const parentC = { hoverPopover: null as HoverPopover | null };

		this.app.workspace.trigger("hover-link", {
			event: new MouseEvent("mouseover", { clientX: 300, clientY: 300 }),
			source: "preview",
			hoverParent: parentC,
			targetEl: targetC,
			linktext: linktext,
			sourcePath: "",
		});

		await this.waitForPopover(parentC, 3000);

		// eslint-disable-next-line no-console
		console.log("Journal [C] hover-link (preview source):", {
			popoverCreated: !!parentC.hoverPopover,
			popover: parentC.hoverPopover,
			hoverEl: parentC.hoverPopover?.hoverEl,
			state: parentC.hoverPopover?.state,
		});

		if (parentC.hoverPopover?.hoverEl) {
			blockC.appendChild(parentC.hoverPopover.hoverEl);
			this.popovers.push(parentC.hoverPopover);
			blockC.createEl("p", { text: "Popover created and reparented" });
		} else {
			blockC.createEl("p", { text: "No popover created" });
		}

		// ── Approach D: hover-link with "editor" source ──
		const blockD = this.scrollContainer.createDiv({ cls: "journal-note-block" });
		blockD.createEl("h3", { text: "Approach D: hover-link with 'editor' source" });

		const targetD = blockD.createDiv({ cls: "journal-hover-target" });
		targetD.textContent = entry.file.basename;

		const parentD = { hoverPopover: null as HoverPopover | null };

		this.app.workspace.trigger("hover-link", {
			event: new MouseEvent("mouseover", { clientX: 400, clientY: 400 }),
			source: "editor",
			hoverParent: parentD,
			targetEl: targetD,
			linktext: linktext,
			sourcePath: "",
		});

		await this.waitForPopover(parentD, 3000);

		// eslint-disable-next-line no-console
		console.log("Journal [D] hover-link (editor source):", {
			popoverCreated: !!parentD.hoverPopover,
			popover: parentD.hoverPopover,
			hoverEl: parentD.hoverPopover?.hoverEl,
			state: parentD.hoverPopover?.state,
		});

		if (parentD.hoverPopover?.hoverEl) {
			blockD.appendChild(parentD.hoverPopover.hoverEl);
			this.popovers.push(parentD.hoverPopover);
			blockD.createEl("p", { text: "Popover created and reparented" });
		} else {
			blockD.createEl("p", { text: "No popover created" });
		}

		// ── Approach E: Inspect Page Preview plugin internals ──
		const blockE = this.scrollContainer.createDiv({ cls: "journal-note-block" });
		blockE.createEl("h3", { text: "Approach E: Page Preview plugin inspection" });

		const internalPlugins = (this.app as unknown as Record<string, unknown>)
			.internalPlugins as Record<string, unknown> | undefined;

		// eslint-disable-next-line no-console
		console.log("Journal [E] Internal plugins inspection:", {
			hasInternalPlugins: !!internalPlugins,
			internalPluginKeys: internalPlugins ? Object.keys(internalPlugins) : "N/A",
		});

		if (internalPlugins) {
			const getPlugin = (internalPlugins as { getPluginById?: (id: string) => unknown })
				.getPluginById;
			if (getPlugin) {
				const pagePreview = getPlugin.call(internalPlugins, "page-preview") as Record<string, unknown> | undefined;
				// eslint-disable-next-line no-console
				console.log("Journal [E] Page Preview plugin:", {
					exists: !!pagePreview,
					enabled: pagePreview?.enabled,
					instanceKeys: pagePreview?.instance ? Object.keys(pagePreview.instance as object) : "N/A",
					instanceProtoMethods: pagePreview?.instance
						? Object.getOwnPropertyNames(Object.getPrototypeOf(pagePreview.instance))
						: "N/A",
				});

				const preEl = blockE.createEl("pre");
				preEl.textContent = JSON.stringify({
					exists: !!pagePreview,
					enabled: pagePreview?.enabled,
					instanceKeys: pagePreview?.instance ? Object.keys(pagePreview.instance as object) : "N/A",
				}, null, 2);
			}
		}
	}

	private waitForPopover(
		parent: { hoverPopover: HoverPopover | null },
		timeoutMs: number,
	): Promise<void> {
		return new Promise<void>((resolve) => {
			let elapsed = 0;
			const interval = setInterval(() => {
				elapsed += 50;
				if (parent.hoverPopover || elapsed >= timeoutMs) {
					clearInterval(interval);
					resolve();
				}
			}, 50);
		});
	}

	async onClose(): Promise<void> {
		for (const popover of this.popovers) {
			popover.unload();
		}
		this.popovers = [];
	}
}
