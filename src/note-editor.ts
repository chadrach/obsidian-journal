import { App, TFile } from "obsidian";
// These packages are provided by Obsidian at runtime (marked external in esbuild config)
/* eslint-disable import/no-extraneous-dependencies */
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
/* eslint-enable import/no-extraneous-dependencies */
import { SAVE_DEBOUNCE_MS } from "./constants";

export interface NoteEditorCallbacks {
	onSave: () => void;
}

export class NoteEditor {
	private editorView: EditorView | null = null;
	private saveTimeout: number | null = null;
	private file: TFile;
	private app: App;
	private callbacks: NoteEditorCallbacks;

	constructor(app: App, file: TFile, callbacks: NoteEditorCallbacks) {
		this.app = app;
		this.file = file;
		this.callbacks = callbacks;
	}

	async mount(container: HTMLElement): Promise<void> {
		const content = await this.app.vault.read(this.file);

		const updateListener = EditorView.updateListener.of((update) => {
			if (update.docChanged) {
				this.scheduleSave();
			}
		});

		const state = EditorState.create({
			doc: content,
			extensions: [
				keymap.of([...defaultKeymap, ...historyKeymap]),
				history(),
				markdown(),
				EditorView.lineWrapping,
				placeholder("Start writing..."),
				updateListener,
				EditorView.theme({
					"&": {
						fontSize: "inherit",
						fontFamily: "inherit",
					},
					".cm-content": {
						padding: "0",
						caretColor: "var(--text-accent)",
					},
					".cm-line": {
						padding: "0",
					},
					"&.cm-focused .cm-cursor": {
						borderLeftColor: "var(--text-accent)",
					},
					"&.cm-focused .cm-selectionBackground, ::selection": {
						backgroundColor: "var(--text-selection)",
					},
					".cm-scroller": {
						overflow: "visible",
					},
				}),
			],
		});

		this.editorView = new EditorView({
			state,
			parent: container,
		});
	}

	private scheduleSave(): void {
		if (this.saveTimeout !== null) {
			window.clearTimeout(this.saveTimeout);
		}
		this.saveTimeout = window.setTimeout(() => {
			this.saveTimeout = null;
			void this.save();
		}, SAVE_DEBOUNCE_MS);
	}

	private async save(): Promise<void> {
		if (!this.editorView) return;
		const content = this.editorView.state.doc.toString();
		await this.app.vault.modify(this.file, content);
		this.callbacks.onSave();
	}

	updateContent(content: string): void {
		if (!this.editorView) return;
		const currentContent = this.editorView.state.doc.toString();
		if (currentContent === content) return;

		this.editorView.dispatch({
			changes: {
				from: 0,
				to: this.editorView.state.doc.length,
				insert: content,
			},
		});
	}

	getContent(): string {
		if (!this.editorView) return "";
		return this.editorView.state.doc.toString();
	}

	focus(): void {
		this.editorView?.focus();
	}

	destroy(): void {
		if (this.saveTimeout !== null) {
			window.clearTimeout(this.saveTimeout);
			// Flush any pending save synchronously
			if (this.editorView) {
				const content = this.editorView.state.doc.toString();
				void this.app.vault.modify(this.file, content);
			}
		}
		this.editorView?.destroy();
		this.editorView = null;
	}
}
