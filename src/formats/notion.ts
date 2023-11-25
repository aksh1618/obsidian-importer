import { normalizePath, Notice, Setting, DataWriteOptions } from 'obsidian';
import { PickedFile } from '../filesystem';
import { FormatImporter } from '../format-importer';
import { ImportContext } from '../main';
import { readZip, ZipEntryFile } from '../zip';
import { cleanDuplicates } from './notion/clean-duplicates';
import { readToMarkdown } from './notion/convert-to-md';
import { NotionResolverInfo } from './notion/notion-types';
import { getNotionId } from './notion/notion-utils';
import { parseFileInfo } from './notion/parse-info';

export class NotionImporter extends FormatImporter {
	
	
	parentsInSubfolders: boolean;
	singleLineBreaks: boolean;
	removeNotionToc: boolean;
	autoDetectedLanguages: string[];
	languageDetectionMinimumThreshold: number;
	preserveIconAsProperty: string;

	init() {
		this.parentsInSubfolders = true;
		this.removeNotionToc = true;
		this.languageDetectionMinimumThreshold = 25;
		this.autoDetectedLanguages = [
			'html',
			'typescript',
			'javascript',
			'python',
			'c',
			'c++',
			'rust',
			'kotlin',
			'sh',
			'sql',
			'plaintext',
		];
		this.preserveIconAsProperty = 'sticker';

		this.addFileChooserSetting('Exported Notion', ['zip']);
		this.addOutputLocationSetting('Notion');
		new Setting(this.modal.contentEl)
			.setName('Save parent pages in subfolders')
			.setDesc('Places the parent database pages in the same folder as the nested content.')
			.addToggle((toggle) => toggle
				.setValue(this.parentsInSubfolders)
				.onChange((value) => (this.parentsInSubfolders = value)));

		new Setting(this.modal.contentEl)
			.setName('Single line breaks')
			.setDesc('Separate Notion blocks with only one line break (default is 2).')
			.addToggle((toggle) => toggle
				.setValue(this.singleLineBreaks)
				.onChange((value) => {
					this.singleLineBreaks = value;
				}));
		new Setting(this.modal.contentEl)
			.setName('Remove TOC')
			.setDesc('Removes the Table of Contents. Currently it\'s converted to plain text, as there is no de-facto solution, so you can choose remove it')
			.addToggle((toggle) => toggle
				.setValue(this.removeNotionToc)
				.onChange((value) => (this.removeNotionToc = value)));
		new Setting(this.modal.contentEl)
			// .setName('Minimum code-block length to trigger language auto-detectection')
			.setName('Min length to auto detect codeblock language')
			.setDesc('Notion html export does not preserve codeblocks\' language. So we can auto-detect it when the length exceeds this value')
			.addText((text) => text
				.setValue(this.languageDetectionMinimumThreshold.toString())
				.onChange((value) => value ? this.languageDetectionMinimumThreshold = +value : this.languageDetectionMinimumThreshold));
		new Setting(this.modal.contentEl)
			.setName('Languages to auto detect')
			.setDesc('Specify each language in a new line. Uses highlight.js to auto-detect language. Notion html export does not preserve codeblocks\' language')
			.addTextArea((textArea) => textArea
				.setValue(this.autoDetectedLanguages.join('\n'))
				.onChange((value) => value ? this.autoDetectedLanguages = value.split('\n') : []));
		new Setting(this.modal.contentEl)
			.setName('Property name for icon')
			.setDesc('Icons can be preserved as a property with the given name. Leaving this empty will skip adding any such property.')
			.addText((text) => text
				.setValue(this.preserveIconAsProperty)
				.onChange((value) => value ? this.preserveIconAsProperty = value : ''));
	}

	async import(ctx: ImportContext): Promise<void> {
		const { 
			vault,
			parentsInSubfolders,
			removeNotionToc,
			autoDetectedLanguages,
			languageDetectionMinimumThreshold,
			preserveIconAsProperty,
			files,
		} = this;
		console.log('Auto detecting languages: ' + autoDetectedLanguages.join('\n'));
		if (files.length === 0) {
			new Notice('Please pick at least one file to import.');
			return;
		}

		const folder = await this.getOutputFolder();
		if (!folder) {
			new Notice('Please select a location to export to.');
			return;
		}

		let targetFolderPath = folder.path;
		targetFolderPath = normalizePath(targetFolderPath);
		// As a convention, all parent folders should end with "/" in this importer.
		if (!targetFolderPath?.endsWith('/')) targetFolderPath += '/';

		const info = new NotionResolverInfo(vault.getConfig('attachmentFolderPath') ?? '', this.singleLineBreaks);

		// loads in only path & title information to objects
		ctx.status('Looking for files to import');
		let total = 0;
		await processZips(ctx, files, async (file) => {
			try {
				await parseFileInfo(info, file);
				total = Object.keys(info.idsToFileInfo).length + Object.keys(info.pathsToAttachmentInfo).length;
				ctx.reportProgress(0, total);
			}
			catch (e) {
				ctx.reportSkipped(file.fullpath);
			}
		});
		if (ctx.isCancelled()) return;

		ctx.status('Resolving links and de-duplicating files');

		cleanDuplicates({
			vault,
			info,
			targetFolderPath,
			parentsInSubfolders,
		});

		const flatFolderPaths = new Set<string>([targetFolderPath]);
		const allFolderPaths = Object.values(info.idsToFileInfo)
			.map((fileInfo) => targetFolderPath + info.getPathForFile(fileInfo))
			.concat(Object.values(info.pathsToAttachmentInfo).map(
				(attachmentInfo) => attachmentInfo.targetParentFolder
			));
		for (let folderPath of allFolderPaths) {
			flatFolderPaths.add(folderPath);
		}
		for (let path of flatFolderPaths) {
			if (ctx.isCancelled()) return;
			await this.createFolders(path);
		}

		let current = 0;
		ctx.status('Starting import');
		await processZips(ctx, files, async (file) => {
			current++;
			ctx.reportProgress(current, total);

			try {
				if (file.extension === 'html') {
					const id = getNotionId(file.name);
					if (!id) {
						throw new Error('ids not found for ' + file.filepath);
					}
					const fileInfo = info.idsToFileInfo[id];
					if (!fileInfo) {
						throw new Error('file info not found for ' + file.filepath);
					}

					ctx.status(`Importing note ${fileInfo.title}`);

					const conversionOptions = {
						removeNotionToc,
						autoDetectedLanguages,
						languageDetectionMinimumThreshold,
						preserveIconAsProperty,
					};
					const markdownBody = await readToMarkdown(info, conversionOptions, file);
					let writeOptions: DataWriteOptions = {};

					if (fileInfo.ctime) {
						writeOptions.ctime = fileInfo.ctime.getTime();
						writeOptions.mtime = fileInfo.ctime.getTime();
					}

					if (fileInfo.mtime) {
						writeOptions.mtime = fileInfo.mtime.getTime();
					}

					const path = `${targetFolderPath}${info.getPathForFile(fileInfo)}${fileInfo.title}.md`;
					await vault.create(path, markdownBody, writeOptions);
					ctx.reportNoteSuccess(file.fullpath);
				}
				else {
					const attachmentInfo = info.pathsToAttachmentInfo[file.filepath];
					if (!attachmentInfo) {
						throw new Error('attachment info not found for ' + file.filepath);
					}

					ctx.status(`Importing attachment ${file.name}`);

					const data = await file.read();
					await vault.createBinary(`${attachmentInfo.targetParentFolder}${attachmentInfo.nameWithExtension}`, data);
					ctx.reportAttachmentSuccess(file.fullpath);
				}
			}
			catch (e) {
				ctx.reportFailed(file.fullpath, e);
			}
		});
	}
}

async function processZips(ctx: ImportContext, files: PickedFile[], callback: (file: ZipEntryFile) => Promise<void>) {
	for (let zipFile of files) {
		if (ctx.isCancelled()) return;
		try {
			await readZip(zipFile, async (zip, entries) => {
				for (let entry of entries) {
					if (ctx.isCancelled()) return;

					// throw an error for Notion Markdown exports
					if (entry.extension === 'md' && getNotionId(entry.name)) {
						new Notice('Notion Markdown export detected. Please export Notion data to HTML instead.');
						ctx.cancel();
						throw new Error('Notion importer uses only HTML exports. Please use the correct format.');
					}

					// Skip databses in CSV format
					if (entry.extension === 'csv' && getNotionId(entry.name)) continue;

					// Skip summary files
					if (entry.name === 'index.html') continue;

					// Only recurse into zip files if they are at the root of the parent zip
					// because users can attach zip files to Notion, and they should be considered
					// attachment files.
					if (entry.extension === 'zip' && entry.parent === '') {
						try {
							await processZips(ctx, [entry], callback);
						}
						catch (e) {
							ctx.reportFailed(entry.fullpath);
						}
					}
					else {
						await callback(entry);
					}
				}
			});
		}
		catch (e) {
			ctx.reportFailed(zipFile.fullpath);
		}
	}
}
