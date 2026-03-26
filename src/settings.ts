import { App, PluginSettingTab, Setting } from "obsidian";
import type JournalPlugin from "./main";

export interface JournalSettings {
	autoCreateToday: boolean;
	openOnStartup: boolean;
	hideFilename: boolean;
	hideH1: boolean;
	notesPerBatch: number;
	dailyNotesFolder: string;
	dateFormat: string;
	templatePath: string;
}

export const DEFAULT_SETTINGS: JournalSettings = {
	autoCreateToday: true,
	openOnStartup: false,
	hideFilename: false,
	hideH1: false,
	notesPerBatch: 20,
	dailyNotesFolder: "",
	dateFormat: "YYYY-MM-DD",
	templatePath: "",
};

export class JournalSettingTab extends PluginSettingTab {
	plugin: JournalPlugin;

	constructor(app: App, plugin: JournalPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Journal").setHeading();

		new Setting(containerEl)
			.setName("Auto-create today's note")
			.setDesc("Automatically create today's daily note when the journal view is opened.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoCreateToday)
				.onChange(async (value) => {
					this.plugin.settings.autoCreateToday = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Open on startup")
			.setDesc("Automatically open the journal view when Obsidian starts.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.openOnStartup)
				.onChange(async (value) => {
					this.plugin.settings.openOnStartup = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Hide filename")
			.setDesc("Hide the date filename displayed above each note.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.hideFilename)
				.onChange(async (value) => {
					this.plugin.settings.hideFilename = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Hide first heading")
			.setDesc("Hide the first heading in each daily note.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.hideH1)
				.onChange(async (value) => {
					this.plugin.settings.hideH1 = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Daily notes")
			.setHeading()
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc("These settings are used only if the core Daily notes plugin is disabled.");

		new Setting(containerEl)
			.setName("Daily notes folder")
			.setDesc("Folder where daily notes are stored.")
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setPlaceholder("e.g. daily-notes")
				.setValue(this.plugin.settings.dailyNotesFolder)
				.onChange(async (value) => {
					this.plugin.settings.dailyNotesFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Date format")
			.setDesc("Format used for daily note filenames (moment.js format).")
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case
				.setPlaceholder("YYYY-MM-DD")
				.setValue(this.plugin.settings.dateFormat)
				.onChange(async (value) => {
					this.plugin.settings.dateFormat = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Template file")
			.setDesc("Path to a template file for new daily notes.")
			.addText(text => text
				.setPlaceholder("e.g. templates/daily")
				.setValue(this.plugin.settings.templatePath)
				.onChange(async (value) => {
					this.plugin.settings.templatePath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Notes per batch")
			.setDesc("Number of notes to load at a time when scrolling.")
			.addText(text => text
				.setPlaceholder("20")
				.setValue(String(this.plugin.settings.notesPerBatch))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num > 0) {
						this.plugin.settings.notesPerBatch = num;
						await this.plugin.saveSettings();
					}
				}));
	}
}
