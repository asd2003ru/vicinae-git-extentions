/// <reference types="react" />

import {
	Action,
	ActionPanel,
	Alert,
	confirmAlert,
	Detail,
	Form,
	Icon,
	List,
	popToRoot,
	showToast,
	Toast,
} from "@vicinae/api";
import { useNavigation } from "@vicinae/api";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { JSX } from "react";
import { useEffect, useState } from "react";

const execFileAsync = promisify(execFile);

type RepoMetadata = {
	url: string;
	name: string;
	title: string;
	description: string;
	repositoryUrl?: string;
	iconPath?: string;
	iconDataUrl?: string;
};

type InstalledPlugin = {
	directoryName: string;
	directoryPath: string;
	title: string;
	description: string;
	packageName?: string;
	repoUrl: string;
	repositoryUrl?: string;
	icon?: string;
	localSha: string;
	remoteSha?: string;
	hasUpdate: boolean;
	updateError?: string;
};

type PackageManifest = {
	name?: string;
	title?: string;
	description?: string;
	repository?: string | { url?: string };
	icon?: string;
	scripts?: Record<string, string>;
	commands?: Array<{ name: string }>;
};

type VegSourceMetadata = {
	repoUrl: string;
	installedSha: string;
	installedAt: string;
};

const VEG_SOURCE_METADATA_FILE = ".veg-source.json";

async function runCommand(
	command: string,
	args: string[],
	cwd?: string,
): Promise<string> {
	try {
		const { stdout } = await execFileAsync(command, args, {
			cwd,
			maxBuffer: 8 * 1024 * 1024,
		});
		return stdout.trim();
	} catch (error) {
		const err = error as Error & {
			stderr?: string;
			stdout?: string;
			code?: string;
		};
		const message = [err.message, err.stderr, err.stdout]
			.filter(Boolean)
			.join("\n")
			.trim();
		throw new Error(message || `Failed to run ${command}`);
	}
}

function friendlyError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);

	if (message.includes("spawn git")) {
		return "Git CLI is required but was not found. Please install git and try again.";
	}

	if (message.includes("spawn npm")) {
		return "NPM CLI is required but was not found. Please install Node.js/npm and try again.";
	}

	if (message.includes("ENOENT")) {
		return "Required CLI tool was not found. Please check git/npm installation and try again.";
	}

	return message;
}

async function exists(targetPath: string): Promise<boolean> {
	try {
		await fs.access(targetPath);
		return true;
	} catch {
		return false;
	}
}

function guessMimeType(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".png") {
		return "image/png";
	}
	if (ext === ".jpg" || ext === ".jpeg") {
		return "image/jpeg";
	}
	if (ext === ".webp") {
		return "image/webp";
	}
	if (ext === ".gif") {
		return "image/gif";
	}
	if (ext === ".svg") {
		return "image/svg+xml";
	}
	return "application/octet-stream";
}

async function resolveIconPath(
	baseDir: string,
	rawIcon?: string,
): Promise<string | undefined> {
	const candidates: string[] = [];

	if (rawIcon && rawIcon.trim().length > 0) {
		const normalized = rawIcon.replace(/^\/+/, "");
		candidates.push(path.join(baseDir, normalized));
		candidates.push(path.join(baseDir, "assets", normalized));
		candidates.push(path.join(baseDir, "assets", path.basename(normalized)));
	}

	candidates.push(path.join(baseDir, "extension_icon.png"));
	candidates.push(path.join(baseDir, "assets", "extension_icon.png"));

	for (const candidate of candidates) {
		if (await exists(candidate)) {
			return candidate;
		}
	}

	return undefined;
}

async function readIconDataUrl(
	baseDir: string,
	rawIcon?: string,
): Promise<string | undefined> {
	const iconPath = await resolveIconPath(baseDir, rawIcon);
	if (!iconPath) {
		return undefined;
	}

	const iconBuffer = await fs.readFile(iconPath);
	const mime = guessMimeType(iconPath);
	return `data:${mime};base64,${iconBuffer.toString("base64")}`;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veg-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function normalizeExtensionsPath(dir: string): string {
	return path.resolve(dir);
}

const DEFAULT_EXTENSIONS_PATH = "/home/asd/.local/share/vicinae/extensions/";

function getExtensionsPath(): string {
	return normalizeExtensionsPath(DEFAULT_EXTENSIONS_PATH);
}

async function ensureGitInstalled(): Promise<void> {
	await runCommand("git", ["--version"]);
}

async function ensureNpmInstalled(): Promise<void> {
	await runCommand("npm", ["--version"]);
}

async function getRemoteHeadSha(repoUrl: string): Promise<string> {
	const output = await runCommand("git", ["ls-remote", repoUrl, "HEAD"]);
	const [sha] = output.split(/\s+/);

	if (!sha) {
		throw new Error("Cannot determine remote HEAD");
	}

	return sha;
}

async function readSourceMetadata(
	directoryPath: string,
): Promise<VegSourceMetadata | undefined> {
	const metadataPath = path.join(directoryPath, VEG_SOURCE_METADATA_FILE);
	if (!(await exists(metadataPath))) {
		return undefined;
	}

	try {
		const raw = await fs.readFile(metadataPath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) {
			return undefined;
		}

		const candidate = parsed as Partial<VegSourceMetadata>;
		if (
			!candidate.repoUrl ||
			!candidate.installedSha ||
			!candidate.installedAt
		) {
			return undefined;
		}

		return {
			repoUrl: candidate.repoUrl,
			installedSha: candidate.installedSha,
			installedAt: candidate.installedAt,
		};
	} catch {
		return undefined;
	}
}

async function writeSourceMetadata(
	directoryPath: string,
	metadata: VegSourceMetadata,
): Promise<void> {
	const metadataPath = path.join(directoryPath, VEG_SOURCE_METADATA_FILE);
	await fs.writeFile(
		metadataPath,
		`${JSON.stringify(metadata, null, 2)}\n`,
		"utf8",
	);
}

async function checkIsBuilt(
	cloneDir: string,
	manifest: PackageManifest,
): Promise<boolean> {
	if (!manifest.scripts?.build) {
		return true;
	}

	if (Array.isArray(manifest.commands) && manifest.commands.length > 0) {
		let allExist = true;
		for (const cmd of manifest.commands) {
			if (cmd && typeof cmd.name === "string") {
				const jsPath = path.join(cloneDir, `${cmd.name}.js`);
				if (!(await exists(jsPath))) {
					allExist = false;
					break;
				}
			}
		}
		if (allExist) {
			return true;
		}
	}

	return false;
}

async function buildRepositoryInTemp(
	repoUrl: string,
): Promise<{
	cloneDir: string;
	localSha: string;
	packageName: string;
	needsCopy: boolean;
}> {
	await ensureGitInstalled();

	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veg-build-"));
	const cloneDir = path.join(tempDir, "repo");

	try {
		await runCommand("git", ["clone", "--depth", "1", repoUrl, cloneDir]);
		const manifest = parseManifest(
			await fs.readFile(path.join(cloneDir, "package.json"), "utf8"),
		);
		if (!manifest.name || typeof manifest.name !== "string") {
			throw new Error("package.json must contain a string field 'name'");
		}

		const isBuilt = await checkIsBuilt(cloneDir, manifest);

		if (!isBuilt) {
			await ensureNpmInstalled();
			await runCommand("npm", ["install"], cloneDir);
			await runCommand("npm", ["run", "build"], cloneDir);
		}

		const localSha = await runCommand("git", ["rev-parse", "HEAD"], cloneDir);
		await fs.rm(path.join(cloneDir, ".git"), { recursive: true, force: true });
		return {
			cloneDir,
			localSha,
			packageName: manifest.name,
			needsCopy: isBuilt,
		};
	} catch (error) {
		await fs.rm(tempDir, { recursive: true, force: true });
		throw error;
	}
}

async function installBuiltRepository(
	repoUrl: string,
): Promise<{ localSha: string; targetDir: string }> {
	const { cloneDir, localSha, packageName, needsCopy } =
		await buildRepositoryInTemp(repoUrl);
	const tempDir = path.dirname(cloneDir);
	const targetDir = path.join(getExtensionsPath(), packageName);

	try {
		if (needsCopy) {
			await fs.mkdir(targetDir, { recursive: true });
			await fs.cp(cloneDir, targetDir, { recursive: true, force: true });
		}

		await writeSourceMetadata(targetDir, {
			repoUrl,
			installedSha: localSha,
			installedAt: new Date().toISOString(),
		});
		return { localSha, targetDir };
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

function getRepositoryUrl(
	repository: PackageManifest["repository"],
): string | undefined {
	if (!repository) {
		return undefined;
	}

	if (typeof repository === "string") {
		return repository;
	}

	return repository.url;
}

function parseManifest(raw: string): PackageManifest {
	let parsed: unknown;

	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("Invalid package.json in repository");
	}

	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("Invalid package.json format in repository");
	}

	return parsed as PackageManifest;
}

async function inspectRepository(repoUrl: string): Promise<RepoMetadata> {
	await ensureGitInstalled();

	return withTempDir(async (tempDir) => {
		const cloneDir = path.join(tempDir, "repo");
		await runCommand("git", ["clone", "--depth", "1", repoUrl, cloneDir]);

		const packageJsonPath = path.join(cloneDir, "package.json");
		if (!(await exists(packageJsonPath))) {
			throw new Error("Repository does not contain package.json");
		}

		const manifest = parseManifest(await fs.readFile(packageJsonPath, "utf8"));

		if (!manifest.name || typeof manifest.name !== "string") {
			throw new Error("package.json must contain a string field 'name'");
		}

		return {
			url: repoUrl,
			name: manifest.name,
			title:
				(typeof manifest.title === "string" && manifest.title) || manifest.name,
			description:
				(typeof manifest.description === "string" && manifest.description) ||
				"No description",
			repositoryUrl: getRepositoryUrl(manifest.repository),
			iconPath: await resolveIconPath(
				cloneDir,
				typeof manifest.icon === "string" ? manifest.icon : undefined,
			),
			iconDataUrl: await readIconDataUrl(
				cloneDir,
				typeof manifest.icon === "string" ? manifest.icon : undefined,
			),
		};
	});
}

async function loadInstalledPlugins(
	extensionsPath: string,
	checkUpdates: boolean,
): Promise<InstalledPlugin[]> {
	if (checkUpdates) {
		await ensureGitInstalled();
	}
	await fs.mkdir(extensionsPath, { recursive: true });

	const entries = await fs.readdir(extensionsPath, { withFileTypes: true });
	const directories = entries.filter((entry) => entry.isDirectory());
	const plugins: InstalledPlugin[] = [];

	for (const entry of directories) {
		const directoryPath = path.join(extensionsPath, entry.name);
		const sourceMetadata = await readSourceMetadata(directoryPath);
		if (!sourceMetadata) {
			continue;
		}

		const packageJsonPath = path.join(directoryPath, "package.json");
		if (!(await exists(packageJsonPath))) {
			continue;
		}
		const packageJsonRaw = await fs.readFile(packageJsonPath, "utf8");
		const manifest = parseManifest(packageJsonRaw);

		const repoUrl = sourceMetadata.repoUrl;
		const localSha = sourceMetadata.installedSha;

		const repositoryUrl = getRepositoryUrl(manifest.repository);

		const icon = await resolveIconPath(
			directoryPath,
			typeof manifest.icon === "string" ? manifest.icon : undefined,
		);

		const plugin: InstalledPlugin = {
			directoryName: entry.name,
			directoryPath,
			title:
				(typeof manifest.title === "string" && manifest.title) ||
				(typeof manifest.name === "string" && manifest.name) ||
				entry.name,
			description:
				(typeof manifest.description === "string" && manifest.description) ||
				"No description",
			packageName:
				typeof manifest.name === "string" ? manifest.name : undefined,
			repoUrl,
			repositoryUrl,
			icon,
			localSha,
			hasUpdate: false,
		};

		if (checkUpdates) {
			try {
				const remoteSha = await getRemoteHeadSha(repoUrl);
				plugin.remoteSha = remoteSha;
				plugin.hasUpdate = remoteSha !== localSha;
			} catch (error) {
				plugin.updateError = friendlyError(error);
			}
		}

		plugins.push(plugin);
	}

	return plugins.sort((a, b) => a.title.localeCompare(b.title));
}

function shortSha(sha?: string): string {
	return sha ? sha.slice(0, 7) : "-";
}

function toMarkdownLink(url: string): string {
	const trimmed = url.trim();
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
		return `[${trimmed}](${trimmed})`;
	}

	return `\`${trimmed}\``;
}

function buildPluginMarkdown(plugin: InstalledPlugin): string {
	const lines = [
		`# ${plugin.title}`,
		"",
		plugin.description,
		"",
		`- Folder: \`${plugin.directoryName}\``,
		`- Git remote: ${toMarkdownLink(plugin.repoUrl)}`,
		`- Local commit: \`${shortSha(plugin.localSha)}\``,
	];

	if (plugin.remoteSha) {
		lines.push(`- Remote commit: \`${shortSha(plugin.remoteSha)}\``);
	}

	if (plugin.updateError) {
		lines.push(`- Update check error: ${plugin.updateError}`);
	}

	return lines.join("\n");
}

function RepositoryPreview(props: {
	metadata: RepoMetadata;
	onInstalled: () => Promise<void>;
}): JSX.Element {
	const { metadata, onInstalled } = props;
	const extensionsPath = getExtensionsPath();
	const [installing, setInstalling] = useState(false);

	async function installRepository(): Promise<void> {
		setInstalling(true);

		const toast = await showToast({
			style: Toast.Style.Animated,
			title: "Installing extension",
		});

		try {
			await ensureGitInstalled();
			await fs.mkdir(extensionsPath, { recursive: true });

			const targetDir = path.join(extensionsPath, metadata.name);

			if (await exists(targetDir)) {
				const shouldReplace = await confirmAlert({
					title: "Extension already exists",
					message: `Replace ${metadata.name} in ${targetDir}?`,
					primaryAction: {
						title: "Replace",
						style: Alert.ActionStyle.Destructive,
					},
				});

				if (!shouldReplace) {
					toast.style = Toast.Style.Failure;
					toast.title = "Installation cancelled";
					return;
				}
			}

			toast.title = "Building extension";
			await installBuiltRepository(metadata.url);

			toast.style = Toast.Style.Success;
			toast.title = "Extension installed";
			toast.message = metadata.name;

			await onInstalled();
			await popToRoot();
		} catch (error) {
			toast.style = Toast.Style.Failure;
			toast.title = "Installation failed";
			toast.message = friendlyError(error);
		} finally {
			setInstalling(false);
		}
	}

	return (
		<Detail
			navigationTitle="Install from Git"
			markdown={`${metadata.iconDataUrl ? `![](${metadata.iconDataUrl})\n\n` : ""}# ${metadata.title}\n\n${metadata.description}\n\n- package name: \`${metadata.name}\`\n- git remote: [${metadata.url}](${metadata.url})${metadata.repositoryUrl ? `\n- repository: [Open](${metadata.repositoryUrl})` : ""}`}
			actions={
				<ActionPanel>
					<Action
						title="Install Extension"
						icon={Icon.Download}
						onAction={() => void installRepository()}
					/>
					<Action.OpenInBrowser
						title="Open Source URL"
						url={metadata.url}
						icon={Icon.ArrowNe}
					/>
				</ActionPanel>
			}
		/>
	);
}

function AddRepositoryForm(props: {
	onInstalled: () => Promise<void>;
}): JSX.Element {
	const { onInstalled } = props;
	const [isLoading, setIsLoading] = useState(false);
	const { push } = useNavigation();

	async function submit(values: Form.Values): Promise<void> {
		const repoUrl = String(values.repositoryUrl ?? "").trim();

		if (!repoUrl) {
			await showToast({
				style: Toast.Style.Failure,
				title: "Repository URL is required",
			});
			return;
		}

		setIsLoading(true);

		const toast = await showToast({
			style: Toast.Style.Animated,
			title: "Reading repository metadata",
		});

		try {
			const metadata = await inspectRepository(repoUrl);

			toast.style = Toast.Style.Success;
			toast.title = "Metadata loaded";
			toast.message = metadata.name;

			push(<RepositoryPreview metadata={metadata} onInstalled={onInstalled} />);
		} catch (error) {
			toast.style = Toast.Style.Failure;
			toast.title = "Cannot read repository";
			toast.message = friendlyError(error);
		} finally {
			setIsLoading(false);
		}
	}

	return (
		<Form
			navigationTitle="Add Extension"
			isLoading={isLoading}
			actions={
				<ActionPanel>
					<Action.SubmitForm
						title="Fetch Plugin Metadata"
						icon={Icon.MagnifyingGlass}
						onSubmit={(values) => void submit(values)}
					/>
				</ActionPanel>
			}
		>
			<Form.Description text="Enter a git repository URL with a Vicinae extension package.json." />
			<Form.TextField
				id="repositoryUrl"
				title="Repository URL"
				placeholder="https://github.com/owner/repo.git"
			/>
		</Form>
	);
}

export default function VegCommand(): JSX.Element {
	const extensionsPath = getExtensionsPath();

	const [items, setItems] = useState<InstalledPlugin[]>([]);
	const [isLoading, setIsLoading] = useState(false);

	async function refresh(checkUpdates: boolean): Promise<void> {
		setIsLoading(true);

		const toast = checkUpdates
			? await showToast({
					style: Toast.Style.Animated,
					title: "Checking for updates",
				})
			: undefined;

		try {
			const loaded = await loadInstalledPlugins(extensionsPath, checkUpdates);
			setItems(loaded);

			if (toast) {
				const updateCount = loaded.filter((item) => item.hasUpdate).length;
				toast.style = Toast.Style.Success;
				toast.title = "Update check complete";
				toast.message =
					updateCount > 0
						? `${updateCount} update(s) available`
						: "All repositories are up to date";
			}
		} catch (error) {
			if (toast) {
				toast.style = Toast.Style.Failure;
				toast.title = "Update check failed";
				toast.message = friendlyError(error);
			} else {
				await showToast({
					style: Toast.Style.Failure,
					title: "Failed to load repositories",
					message: friendlyError(error),
				});
			}
		} finally {
			setIsLoading(false);
		}
	}

	useEffect(() => {
		void refresh(false);
	}, [extensionsPath]);

	const updates = items.filter((item) => item.hasUpdate);

	async function updateOne(item: InstalledPlugin): Promise<void> {
		const toast = await showToast({
			style: Toast.Style.Animated,
			title: `Updating ${item.title}`,
		});

		try {
			await installBuiltRepository(item.repoUrl);

			toast.style = Toast.Style.Success;
			toast.title = "Updated";
			toast.message = item.title;

			await refresh(true);
		} catch (error) {
			toast.style = Toast.Style.Failure;
			toast.title = "Update failed";
			toast.message = friendlyError(error);
		}
	}

	async function updateAll(): Promise<void> {
		if (updates.length === 0) {
			await showToast({
				style: Toast.Style.Success,
				title: "No updates available",
			});
			return;
		}

		const confirmed = await confirmAlert({
			title: "Update all repositories",
			message: `Install updates for ${updates.length} repositories?`,
			primaryAction: { title: "Update All" },
		});

		if (!confirmed) {
			return;
		}

		const toast = await showToast({
			style: Toast.Style.Animated,
			title: "Updating repositories",
		});

		let success = 0;
		let failed = 0;

		for (const item of updates) {
			try {
				await installBuiltRepository(item.repoUrl);
				success += 1;
			} catch {
				failed += 1;
			}
		}

		toast.style = failed === 0 ? Toast.Style.Success : Toast.Style.Failure;
		toast.title =
			failed === 0 ? "All updates installed" : "Some updates failed";
		toast.message = `Success: ${success}, Failed: ${failed}`;

		await refresh(true);
	}

	async function removeOne(item: InstalledPlugin): Promise<void> {
		const confirmed = await confirmAlert({
			title: "Remove extension",
			message: `Delete ${item.title} from ${item.directoryPath}?`,
			primaryAction: { title: "Remove", style: Alert.ActionStyle.Destructive },
		});

		if (!confirmed) {
			return;
		}

		const toast = await showToast({
			style: Toast.Style.Animated,
			title: `Removing ${item.title}`,
		});

		try {
			await fs.rm(item.directoryPath, { recursive: true, force: true });
			toast.style = Toast.Style.Success;
			toast.title = "Extension removed";
			toast.message = item.title;
			await refresh(false);
		} catch (error) {
			toast.style = Toast.Style.Failure;
			toast.title = "Remove failed";
			toast.message = friendlyError(error);
		}
	}

	function actionsForItem(item: InstalledPlugin): JSX.Element {
		return (
			<ActionPanel>
				{item.hasUpdate ? (
					<Action
						title="Update This Extension"
						icon={Icon.ArrowClockwise}
						onAction={() => void updateOne(item)}
					/>
				) : null}
				<Action.Push
					title="Add from Git URL"
					icon={Icon.Plus}
					target={<AddRepositoryForm onInstalled={() => refresh(false)} />}
				/>
				<Action
					title="Check All for Updates"
					icon={Icon.RotateClockwise}
					onAction={() => void refresh(true)}
				/>
				<Action
					title="Update All"
					icon={Icon.Download}
					onAction={() => void updateAll()}
				/>
				<Action
					title="Remove Extension"
					icon={Icon.Trash}
					onAction={() => void removeOne(item)}
				/>
				<Action.OpenInBrowser
					title="Open Remote URL"
					url={item.repoUrl}
					icon={Icon.ArrowNe}
				/>
				{item.repositoryUrl ? (
					<Action.OpenInBrowser
						title="Open Repository Link"
						url={item.repositoryUrl}
						icon={Icon.Globe01}
					/>
				) : null}
				<Action.ShowInFinder
					title="Show in File Manager"
					path={item.directoryPath}
					icon={Icon.Folder}
				/>
			</ActionPanel>
		);
	}

	return (
		<List
			isLoading={isLoading}
			isShowingDetail
			searchBarPlaceholder="Search installed git repositories"
			actions={
				<ActionPanel>
					<Action.Push
						title="Add from Git URL"
						icon={Icon.Plus}
						target={<AddRepositoryForm onInstalled={() => refresh(false)} />}
					/>
					<Action
						title="Check for Updates"
						icon={Icon.RotateClockwise}
						onAction={() => void refresh(true)}
					/>
					<Action
						title="Update All"
						icon={Icon.Download}
						onAction={() => void updateAll()}
					/>
				</ActionPanel>
			}
		>
			{items.length === 0 ? (
				<List.EmptyView
					title="No Git-managed extensions found"
					description="Add one from a repository URL."
					icon={Icon.Git}
					actions={
						<ActionPanel>
							<Action.Push
								title="Add from Git URL"
								icon={Icon.Plus}
								target={
									<AddRepositoryForm onInstalled={() => refresh(false)} />
								}
							/>
							<Action
								title="Reload"
								icon={Icon.RotateClockwise}
								onAction={() => void refresh(false)}
							/>
						</ActionPanel>
					}
				/>
			) : null}

			{updates.length > 0 ? (
				<List.Section
					title="Updates Available"
					subtitle={String(updates.length)}
				>
					{updates.map((item) => (
						<List.Item
							key={item.directoryPath}
							id={item.directoryPath}
							title={item.title}
							subtitle={item.description}
							icon={item.icon ?? Icon.Download}
							accessories={[
								{ tag: "Update" },
								{
									text: `${shortSha(item.localSha)} -> ${shortSha(item.remoteSha)}`,
								},
							]}
							detail={<List.Item.Detail markdown={buildPluginMarkdown(item)} />}
							actions={actionsForItem(item)}
						/>
					))}
				</List.Section>
			) : null}

			<List.Section title="Installed" subtitle={String(items.length)}>
				{items.map((item) => (
					<List.Item
						key={item.directoryPath}
						id={item.directoryPath}
						title={item.title}
						subtitle={item.description}
						icon={item.icon ?? Icon.Folder}
						accessories={
							item.updateError
								? [{ icon: Icon.QuestionMarkCircle, tooltip: item.updateError }]
								: [{ text: shortSha(item.localSha) }]
						}
						detail={<List.Item.Detail markdown={buildPluginMarkdown(item)} />}
						actions={actionsForItem(item)}
					/>
				))}
			</List.Section>
		</List>
	);
}
