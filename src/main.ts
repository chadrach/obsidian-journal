import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, JournalSettingTab, type JournalSettings } from "./settings";
import { VIEW_TYPE_JOURNAL, JOURNAL_ICON } from "./constants";
import { JournalView } from "./journal-view";

export default class JournalPlugin extends Plugin {
	settings: JournalSettings;

	async onload() {
		await this.loadSettings();

		this.registerView(
			VIEW_TYPE_JOURNAL,
			(leaf) => new JournalView(leaf, this),
		);

		this.addRibbonIcon(JOURNAL_ICON, "Open journal", () => {
			void this.activateJournalView();
		});

		this.addCommand({
			id: "open-journal",
			name: "Open journal",
			callback: () => {
				void this.activateJournalView();
			},
		});

		this.addSettingTab(new JournalSettingTab(this.app, this));

		if (this.settings.openOnStartup) {
			this.app.workspace.onLayoutReady(() => {
				void this.activateJournalView();
			});
		}
	}

	onunload() {
		// Views are automatically cleaned up by Obsidian
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<JournalSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private async activateJournalView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_JOURNAL);
		if (existing.length > 0) {
			await this.app.workspace.revealLeaf(existing[0]!);
			return;
		}

		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE_JOURNAL,
			active: true,
		});
		await this.app.workspace.revealLeaf(leaf);
	}
}
