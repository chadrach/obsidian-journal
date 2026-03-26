import { App, Component, MarkdownRenderer, TFile, moment } from "obsidian";
import { NoteEditor } from "./note-editor";
import type { JournalSettings } from "./settings";
import type { DailyNotesConfig } from "./daily-notes-utils";

export class NoteBlock extends Component {
	private app: App;
	private file: TFile;
	private date: ReturnType<typeof moment>;
	private settings: JournalSettings;
	private config: DailyNotesConfig;
	private containerEl: HTMLElement;
	private contentEl: HTMLElement;
	private editor: NoteEditor | null = null;
	private isEditing = false;
	private onOpenInTab: (file: TFile) => void;

	constructor(
		app: App,
		file: TFile,
		date: ReturnType<typeof moment>,
		parentEl: HTMLElement,
		settings: JournalSettings,
		config: DailyNotesConfig,
		editMode: boolean,
		onOpenInTab: (file: TFile) => void,
	) {
		super();
		this.app = app;
		this.file = file;
		this.date = date;
		this.settings = settings;
		this.config = config;
		this.onOpenInTab = onOpenInTab;

		this.containerEl = parentEl.createDiv({ cls: "journal-note-block" });
		if (this.settings.hideH1) {
			this.containerEl.addClass("hide-h1");
		}

		// Date header
		const headerEl = this.containerEl.createDiv({ cls: "journal-note-header" });
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
		if (this.settings.hideFilename) {
			headerEl.addClass("journal-note-header-hidden");
		}

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

		// Content area
		this.contentEl = this.containerEl.createDiv({ cls: "journal-note-content" });

		if (editMode) {
			void this.enterEditMode();
		} else {
			void this.renderReadOnly();
		}
	}

	private async renderReadOnly(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.classList.remove("journal-note-editing");
		this.contentEl.classList.add("journal-note-rendered");
		this.isEditing = false;

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

		// Click to edit
		this.contentEl.addEventListener("click", () => {
			if (!this.isEditing) {
				void this.enterEditMode();
			}
		});
	}

	private async enterEditMode(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.classList.remove("journal-note-rendered");
		this.contentEl.classList.add("journal-note-editing");
		this.isEditing = true;

		this.editor = new NoteEditor(this.app, this.file, {
			onSave: () => {
				// Could trigger a re-render notification
			},
		});
		await this.editor.mount(this.contentEl);
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
			// First non-empty line isn't H1, stop looking
			break;
		}
		return lines.join("\n");
	}

	async refreshContent(): Promise<void> {
		if (this.isEditing && this.editor) {
			// If we're editing, update the editor content only if the file
			// was modified externally (not by our own editor)
			const fileContent = await this.app.vault.read(this.file);
			const editorContent = this.editor.getContent();
			if (fileContent !== editorContent) {
				this.editor.updateContent(fileContent);
			}
		} else {
			void this.renderReadOnly();
		}
	}

	getFile(): TFile {
		return this.file;
	}

	getContainerEl(): HTMLElement {
		return this.containerEl;
	}

	onunload(): void {
		if (this.editor) {
			this.editor.destroy();
			this.editor = null;
		}
		this.containerEl.remove();
	}
}
