import { App, TFile, TFolder, moment, normalizePath } from "obsidian";
import type { JournalSettings } from "./settings";

export interface DailyNotesConfig {
	folder: string;
	format: string;
	templatePath: string;
}

export interface DailyNoteEntry {
	date: ReturnType<typeof moment>;
	file: TFile;
}

export function getDailyNotesConfig(app: App, settings: JournalSettings): DailyNotesConfig {
	// Try to read from the core Daily Notes plugin (uses undocumented but stable internal API)
	const internalPlugins = (app as unknown as Record<string, unknown>).internalPlugins as
		| { getPluginById?: (id: string) => { enabled?: boolean; instance?: { options?: Record<string, string> } } | undefined }
		| undefined;
	if (internalPlugins) {
		const dailyNotesPlugin = internalPlugins.getPluginById?.("daily-notes");
		if (dailyNotesPlugin?.enabled && dailyNotesPlugin?.instance?.options) {
			const opts = dailyNotesPlugin.instance.options;
			return {
				folder: opts["folder"] || "",
				format: opts["format"] || "YYYY-MM-DD",
				templatePath: opts["template"] || "",
			};
		}
	}

	return {
		folder: settings.dailyNotesFolder,
		format: settings.dateFormat,
		templatePath: settings.templatePath,
	};
}

export function getDailyNotePath(date: ReturnType<typeof moment>, config: DailyNotesConfig): string {
	const filename = date.format(config.format);
	if (config.folder) {
		return normalizePath(`${config.folder}/${filename}.md`);
	}
	return normalizePath(`${filename}.md`);
}

export function findExistingDailyNotes(app: App, config: DailyNotesConfig): DailyNoteEntry[] {
	const folder = config.folder
		? app.vault.getAbstractFileByPath(normalizePath(config.folder))
		: app.vault.getRoot();

	if (!folder || !(folder instanceof TFolder)) {
		return [];
	}

	const entries: DailyNoteEntry[] = [];

	for (const file of folder.children) {
		if (!(file instanceof TFile) || file.extension !== "md") {
			continue;
		}
		const basename = file.basename;
		const date = moment(basename, config.format, true);
		if (date.isValid()) {
			entries.push({ date, file });
		}
	}

	entries.sort((a, b) => b.date.valueOf() - a.date.valueOf());
	return entries;
}

export async function createDailyNote(
	app: App,
	date: ReturnType<typeof moment>,
	config: DailyNotesConfig,
): Promise<TFile> {
	const path = getDailyNotePath(date, config);

	// Check if file already exists
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		return existing;
	}

	// Ensure parent folder exists
	if (config.folder) {
		const folderPath = normalizePath(config.folder);
		const folderExists = app.vault.getAbstractFileByPath(folderPath);
		if (!folderExists) {
			await app.vault.createFolder(folderPath);
		}
	}

	// Load template content if configured
	let content = "";
	if (config.templatePath) {
		const templatePath = normalizePath(
			config.templatePath.endsWith(".md")
				? config.templatePath
				: `${config.templatePath}.md`
		);
		const templateFile = app.vault.getAbstractFileByPath(templatePath);
		if (templateFile instanceof TFile) {
			content = await app.vault.read(templateFile);
			// Replace common template variables
			content = content
				.replace(/\{\{date\}\}/g, date.format(config.format))
				.replace(/\{\{title\}\}/g, date.format(config.format))
				.replace(/\{\{time\}\}/g, date.format("HH:mm"));
		}
	}

	return app.vault.create(path, content);
}
