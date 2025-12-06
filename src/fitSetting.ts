import FitPlugin from "main";
import { App, PluginSettingTab, Setting } from "obsidian";
import { setEqual } from "./utils";
import { warn } from "console";
import { fitLogger } from "./logger";

type RefreshCheckPoint = "repo(0)" | "branch(1)" | "link(2)" | "initialize" | "withCache";

export default class FitSettingTab extends PluginSettingTab {
	plugin: FitPlugin;
	authenticating: boolean;
	authUserAvatar: HTMLDivElement;
	authUserHandle: HTMLSpanElement;
	patSetting: Setting;
	ownerSetting: Setting;
	repoSetting: Setting;
	branchSetting: Setting;
	existingRepos: Array<string>;
	existingBranches: Array<string>;
	repoLink: string;

	constructor(app: App, plugin: FitPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.repoLink = this.getLatestLink();
		this.authenticating = false;
		this.existingRepos = [];
		this.existingBranches = [];
	}

	getLatestLink = (): string => {
		if (this.plugin.settings.provider === "gitea") {
			const {giteaUrl, giteaOwner, giteaRepo, giteaBranch} = this.plugin.settings;
			if (giteaUrl.length > 0 && giteaOwner.length > 0 && giteaRepo.length > 0 && giteaBranch.length > 0) {
				return `${giteaUrl}/${giteaOwner}/${giteaRepo}/src/branch/${giteaBranch}`;
			}
		} else {
			const {owner, repo, branch} = this.plugin.settings;
			if (owner.length > 0 && repo.length > 0 && branch.length > 0) {
				return `https://github.com/${owner}/${repo}/tree/${branch}`;
			}
		}
		return "";
	};

	handleUserFetch = async () => {
		this.authenticating = true;
		this.authUserAvatar.removeClass('error');
		this.authUserAvatar.empty();
		this.authUserAvatar.removeClass('empty');
		this.authUserAvatar.addClass('cat');
		try {
			const {owner, avatarUrl} = await this.plugin.fit.getUser();
			this.authUserAvatar.removeClass('cat');
			this.authUserAvatar.createEl('img', { attr: { src: avatarUrl } });
			this.authUserHandle.setText(owner);

			// Update settings based on provider
			if (this.plugin.settings.provider === "gitea") {
				if (owner !== this.plugin.settings.giteaOwner) {
					this.plugin.settings.giteaOwner = owner;
					this.plugin.settings.giteaAvatarUrl = avatarUrl;
					this.plugin.settings.giteaRepo = "";
					this.plugin.settings.giteaBranch = "";
					this.existingBranches = [];
					this.existingRepos = [];
					await this.plugin.saveSettings();
					await this.refreshFields('repo(0)');
				}
			} else {
				if (owner !== this.plugin.settings.owner) {
					this.plugin.settings.owner = owner;
					this.plugin.settings.avatarUrl = avatarUrl;
					this.plugin.settings.repo = "";
					this.plugin.settings.branch = "";
					this.existingBranches = [];
					this.existingRepos = [];
					await this.plugin.saveSettings();
					await this.refreshFields('repo(0)');
				}
			}
			this.authenticating = false;
		} catch (_error) {
			this.authUserAvatar.removeClass('cat');
			this.authUserAvatar.addClass('error');
			this.authUserHandle.setText("Authentication failed, make sure your token has not expired.");

			// Clear settings based on provider
			if (this.plugin.settings.provider === "gitea") {
				this.plugin.settings.giteaOwner = "";
				this.plugin.settings.giteaAvatarUrl = "";
				this.plugin.settings.giteaRepo = "";
				this.plugin.settings.giteaBranch = "";
			} else {
				this.plugin.settings.owner = "";
				this.plugin.settings.avatarUrl = "";
				this.plugin.settings.repo = "";
				this.plugin.settings.branch = "";
			}

			this.existingBranches = [];
			this.existingRepos = [];
			await this.plugin.saveSettings();
			this.refreshFields('initialize');
			this.authenticating = false;
		}
	};


	githubUserInfoBlock = () => {
		const {containerEl} = this;
		new Setting(containerEl).setHeading()
			.setName("GitHub user info")
			.addButton(button => button
				.setCta()
				.setButtonText("Authenticate user")
				.setDisabled(this.authenticating)
				.onClick(async ()=>{
					if (this.authenticating) return;
					await this.handleUserFetch();
				}));
		this.ownerSetting = new Setting(containerEl)
			.setDesc("Input your personal access token below to get authenticated. Create a GitHub account here if you don't have one yet.")
			.addExtraButton(button=>button
				.setIcon('github')
				.setTooltip("Sign up on github.com")
				.onClick(async ()=>{
					window.open("https://github.com/signup", "_blank");
				}));
		this.ownerSetting.nameEl.addClass('fit-avatar-container');
		if (this.plugin.settings.owner === "") {
			this.authUserAvatar = this.ownerSetting.nameEl.createDiv(
				{cls: 'fit-avatar-container empty'});
			this.authUserHandle = this.ownerSetting.nameEl.createEl('span', {cls: 'fit-github-handle'});
			this.authUserHandle.setText("Unauthenticated");
		} else {
			this.authUserAvatar = this.ownerSetting.nameEl.createDiv(
				{cls: 'fit-avatar-container'});
			this.authUserAvatar.createEl('img', { attr: { src: this.plugin.settings.avatarUrl } });
			this.authUserHandle = this.ownerSetting.nameEl.createEl('span', {cls: 'fit-github-handle'});
			this.authUserHandle.setText(this.plugin.settings.owner);
		}
		// hide the control element to make space for authUser
		this.ownerSetting.controlEl.addClass('fit-avatar-display-text');

		this.patSetting = new Setting(containerEl)
			.setName('Github personal access token')
			.setDesc('Make sure Permissions has Contents: "Read and write". Recommended: Limit to selected repository, adjust expiration.')
			.addText(text => text
				.setPlaceholder('GitHub personal access token')
				.setValue(this.plugin.settings.pat)
				.onChange(async (value) => {
					this.plugin.settings.pat = value;
					await this.plugin.saveSettings();
				}))
			.addExtraButton(button=>button
				.setIcon('external-link')
				.setTooltip("Create a token")
				.onClick(async ()=>{
					window.open(
						"https://github.com/settings/personal-access-tokens/new?name=Obsidian%20FIT&description=Obsidian%20FIT%20plugin&contents=write",
						'_blank');
				}));
	};

	repoInfoBlock = async () => {
		const {containerEl} = this;
		const isGitea = this.plugin.settings.provider === "gitea";
		const currentOwner = isGitea ? this.plugin.settings.giteaOwner : this.plugin.settings.owner;
		const currentRepo = isGitea ? this.plugin.settings.giteaRepo : this.plugin.settings.repo;
		const currentBranch = isGitea ? this.plugin.settings.giteaBranch : this.plugin.settings.branch;
		const providerName = isGitea ? "Gitea" : "GitHub";

		new Setting(containerEl).setHeading().setName("Repository info")
			.setDesc("Refresh to retrieve the latest list of repos and branches.")
			.addExtraButton(button => button
				.setTooltip("Refresh repos and branches list")
				.setDisabled(currentOwner === "")
				.setIcon('refresh-cw')
				.onClick(async () => {
					await this.refreshFields('repo(0)');
				}));

		if (!isGitea) {
			new Setting(containerEl)
				.setDesc("Make sure you are logged in to github on your browser.")
				.addExtraButton(button => button
					.setIcon('github')
					.setTooltip("Create a new repository")
					.onClick(() => {
						window.open(`https://github.com/new`, '_blank');
					}));
		}

		this.repoSetting = new Setting(containerEl)
			.setName(`${providerName} repository name`)
			.setDesc("Select a repo to sync your vault, refresh to see your latest repos. If some repos are missing, make sure your token has access to them.")
			.addDropdown(dropdown => {
				dropdown.selectEl.addClass('repo-dropdown');
				this.existingRepos.map(repo=>dropdown.addOption(repo, repo));
				dropdown.setDisabled(this.existingRepos.length === 0);
				dropdown.setValue(currentRepo);
				dropdown.onChange(async (value) => {
					const repoChanged = value !== currentRepo;
					if (repoChanged) {
						if (isGitea) {
							this.plugin.settings.giteaRepo = value;
						} else {
							this.plugin.settings.repo = value;
						}
						await this.plugin.saveSettings();
						// CRITICAL: Reload the remote vault with new repo settings
						this.plugin.fit.loadSettings(this.plugin.settings);
						await this.refreshFields('branch(1)');
					}
				});
			});

		// Section 1: Choose existing branch
		this.branchSetting = new Setting(containerEl)
			.setName('Choose branch')
			.setDesc('Select an existing branch to sync to');

		this.branchSetting.addDropdown(dropdown => {
			dropdown.selectEl.addClass('branch-dropdown');
			// Add existing branches
			this.existingBranches.map(branch => dropdown.addOption(branch, branch));
			// Set current value if it's an existing branch
			if (currentBranch && this.existingBranches.includes(currentBranch)) {
				dropdown.setValue(currentBranch);
			} else if (this.existingBranches.length > 0) {
				dropdown.setValue(this.existingBranches[0]);
			}
			dropdown.setDisabled(this.existingBranches.length === 0);
			dropdown.onChange((value) => {
				const branchChanged = value !== currentBranch;
				if (branchChanged) {
					if (isGitea) {
						this.plugin.settings.giteaBranch = value;
					} else {
						this.plugin.settings.branch = value;
					}
					// Save and refresh asynchronously
					(async () => {
						await this.plugin.saveSettings();
						// CRITICAL: Reload the remote vault with new branch settings
						this.plugin.fit.loadSettings(this.plugin.settings);
						await this.refreshFields('link(2)');
					})();
				}
			});
		});

		// Section 2: Create new branch
		const newBranchSection = new Setting(containerEl)
			.setName('Create new branch')
			.setDesc('Create a new branch remotely');

		let newBranchNameInput: HTMLInputElement;
		newBranchSection.addText(text => {
			newBranchNameInput = text.inputEl;
			text.setPlaceholder('Branch name')
				.setValue(currentBranch || 'main')
				.onChange((value) => {
					// Just update the input, don't save yet
				});
		});

		newBranchSection.addButton(button => button
			.setButtonText('Create branch remotely')
			.onClick(async () => {
				const branchName = newBranchNameInput.value.trim();
				if (!branchName) {
					fitLogger.log('[fitSetting] Branch name cannot be empty');
					return;
				}

				button.setDisabled(true);
				button.setButtonText('Creating...');
				try {
					// Actually create the branch on the remote
					await this.plugin.fit.createBranch(branchName);

					// Update the branch setting
					if (isGitea) {
						this.plugin.settings.giteaBranch = branchName;
					} else {
						this.plugin.settings.branch = branchName;
					}
					await this.plugin.saveSettings();

					fitLogger.log('[fitSetting] Branch created successfully', { branchName });

					// Refresh branches list to show the newly created branch
					await this.refreshFields('branch(1)');
					button.setButtonText('✓ Created');
					setTimeout(() => {
						button.setButtonText('Create branch remotely');
						button.setDisabled(false);
					}, 2000);
				} catch (error) {
					fitLogger.log('[fitSetting] Error creating branch', { error });
					button.setButtonText('✗ Error');
					setTimeout(() => {
						button.setButtonText('Create branch remotely');
						button.setDisabled(false);
					}, 2000);
				}
			}));

		this.repoLink = this.getLatestLink();
		const linkDisplay = new Setting(containerEl)
			.setName(`View your vault on ${providerName}`)
			.setDesc(this.repoLink)
			.addExtraButton(button => button
				.setDisabled(this.repoLink.length === 0)
				.setTooltip(`Open on ${providerName}`)
				.setIcon('external-link')
				.onClick(() => {
					console.log(`opening ${this.repoLink}`);
					window.open(this.repoLink, '_blank');
				})
			);
		linkDisplay.descEl.addClass("link-desc");
	};

	localConfigBlock = () => {
		const {containerEl} = this;
		new Setting(containerEl).setHeading().setName("Local configurations");
		new Setting(containerEl)
			.setName('Device name')
			.setDesc('Sign commit message with this device name.')
			.addText(text => text
				.setPlaceholder('Device name')
				.setValue(this.plugin.settings.deviceName)
				.onChange(async (value) => {
					this.plugin.settings.deviceName = value;
					await this.plugin.saveSettings();
				}));


		new Setting(containerEl)
			.setName("Auto sync")
			.setDesc(`Automatically sync your vault when remote has updates. (Muted: sync in the background without displaying notices, except for file changes and conflicts notice)`)
			.addDropdown(dropdown => {
				dropdown
					.addOption('off', 'Off')
					.addOption('muted', 'Muted')
					.addOption('remind', 'Remind only')
					.addOption('on', 'On')
					.setValue(this.plugin.settings.autoSync ? this.plugin.settings.autoSync : 'off')
					.onChange(async (value) => {
						this.plugin.settings.autoSync = value as "off" | "muted" | "remind" | "on";
						checkIntervalSlider.settingEl.addClass(value === "off" ? "clear" : "restore");
						checkIntervalSlider.settingEl.removeClass(value === "off" ? "restore" : "clear");
						await this.plugin.saveSettings();
					});
			});

		const checkIntervalSlider = new Setting(containerEl)
			.setName('Auto check interval')
			.setDesc(`Automatically check for remote changes in the background every ${this.plugin.settings.checkEveryXMinutes} minutes.`)
			.addSlider(slider => slider
				.setLimits(1, 60, 1)
				.setValue(this.plugin.settings.checkEveryXMinutes)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.checkEveryXMinutes = value;
					await this.plugin.saveSettings();
					checkIntervalSlider.setDesc(`Automatically check for remote changes in the background every ${value} minutes.`);
				})
			);

		if (this.plugin.settings.autoSync === "off") {
			checkIntervalSlider.settingEl.addClass("clear");
		}
	};

	noticeConfigBlock = () => {
		const {containerEl} = this;
		const selectedCol = "var(--interactive-accent)";
		const selectedTxtCol = "var(--text-on-accent)";
		const unselectedColor = "var(--interactive-normal)";
		const unselectedTxtCol = "var(--text-normal)";
		const stateTextMap = (notifyConflicts: boolean, notifyChanges: boolean) => {
			if (notifyConflicts && notifyChanges) {
				return "Displaying file changes and conflicts ";
			} else if (!notifyConflicts && notifyChanges) {
				return "Displaying file changes ";
			} else if (notifyConflicts && !notifyChanges) {
				return "Displaying change conflicts ";
			} else {
				return "No notice displayed ";
			}
		};
		const noticeDisplay = new Setting(containerEl)
			.setName("Notice display")
			.setDesc(`${stateTextMap(this.plugin.settings.notifyConflicts, this.plugin.settings.notifyChanges)} after sync.`);

		noticeDisplay.addButton(button => {
			button.setButtonText("Change conflicts");
			button.onClick(async () => {
				const notifyConflicts = !this.plugin.settings.notifyConflicts;
				this.plugin.settings.notifyConflicts = notifyConflicts;
				await this.plugin.saveSettings();
				button.buttonEl.setCssStyles({
					"background": notifyConflicts ? selectedCol : unselectedColor,
					"color": notifyConflicts ? selectedTxtCol : unselectedTxtCol,
				});
				noticeDisplay.setDesc(`${stateTextMap(notifyConflicts, this.plugin.settings.notifyChanges)} after sync.`);
			});
			button.buttonEl.setCssStyles({
				"background": this.plugin.settings.notifyConflicts ? selectedCol : unselectedColor,
				"color": this.plugin.settings.notifyConflicts ? selectedTxtCol : unselectedTxtCol,
			});
		});
		noticeDisplay.addButton(button => {
			button.setButtonText("File changes");
			button.onClick(async () => {
				const notifyChanges = !this.plugin.settings.notifyChanges;
				this.plugin.settings.notifyChanges = notifyChanges;
				await this.plugin.saveSettings();
				button.buttonEl.setCssStyles({
					"background": notifyChanges ? selectedCol : unselectedColor,
					"color": notifyChanges ? selectedTxtCol : unselectedTxtCol,
				});
				noticeDisplay.setDesc(`${stateTextMap(this.plugin.settings.notifyConflicts, notifyChanges)} after sync.`);
			});
			button.buttonEl.setCssStyles({
				"background": this.plugin.settings.notifyChanges ? selectedCol : unselectedColor,
				"color": this.plugin.settings.notifyChanges ? selectedTxtCol : unselectedTxtCol,
			});
		});

		// Debug logging setting
		new Setting(containerEl)
			.setName("Enable debug logging")
			.setDesc(`Write detailed sync logs to ${this.plugin.manifest.dir}/debug.log. Useful for troubleshooting and bug reports.`)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableDebugLogging)
				.onChange(async (value) => {
					this.plugin.settings.enableDebugLogging = value;
					await this.plugin.saveSettings();
					// Update logger immediately
					const { fitLogger } = await import('./logger');
					fitLogger.setEnabled(value);
					if (value) {
						fitLogger.log('[Settings] Debug logging enabled');
					}
				}));
	};

	refreshFields = async (refreshFrom: RefreshCheckPoint) => {
		const {containerEl} = this;
		const repo_dropdown = containerEl.querySelector('.repo-dropdown') as HTMLSelectElement;
		const branch_dropdown = containerEl.querySelector('.branch-dropdown') as HTMLSelectElement;
		const link_el = containerEl.querySelector('.link-desc') as HTMLElement;

		// Get current repo and branch based on provider
		const isGitea = this.plugin.settings.provider === "gitea";
		const currentRepo = isGitea ? this.plugin.settings.giteaRepo : this.plugin.settings.repo;
		const currentBranch = isGitea ? this.plugin.settings.giteaBranch : this.plugin.settings.branch;

		if (refreshFrom === "repo(0)") {
			repo_dropdown.disabled = true;
			branch_dropdown.disabled = true;
			this.existingRepos = await this.plugin.fit.getRepos();
			const repoOptions = Array.from(repo_dropdown.options).map(option => option.value);
			if (!setEqual<string>(this.existingRepos, repoOptions)) {
				repo_dropdown.empty();
				this.existingRepos.map(repo => {
					repo_dropdown.add(new Option(repo, repo));
				});
				const selectedRepoIndex = this.existingRepos.indexOf(currentRepo);
				repo_dropdown.selectedIndex = selectedRepoIndex;
				if (selectedRepoIndex===-1){
					if (isGitea) {
						this.plugin.settings.giteaRepo = "";
					} else {
						this.plugin.settings.repo = "";
					}
				}
			}
			repo_dropdown.disabled = false;
		}
		if (refreshFrom === "branch(1)" || refreshFrom === "repo(0)") {
			if (currentRepo === "") {
				branch_dropdown.empty();
			} else {
				const latestBranches = await this.plugin.fit.getBranches();
				if (!setEqual<string>(this.existingBranches, latestBranches)) {
					branch_dropdown.empty();
					this.existingBranches = latestBranches;
					this.existingBranches.map(branch => {
						branch_dropdown.add(new Option(branch, branch));
					});
					const selectedBranchIndex = this.existingBranches.indexOf(currentBranch);
					branch_dropdown.selectedIndex = selectedBranchIndex;
					if (selectedBranchIndex===-1){
						if (isGitea) {
							this.plugin.settings.giteaBranch = "";
						} else {
							this.plugin.settings.branch = "";
						}
					}
				}
			}
			branch_dropdown.disabled = false;
		}
		if (refreshFrom === "link(2)" || refreshFrom === "branch(1)" || refreshFrom === "repo(0)") {
			this.repoLink = this.getLatestLink();
			link_el.innerText = this.repoLink;
		}
		if (refreshFrom === "initialize") {
			repo_dropdown.empty();
			branch_dropdown.empty();
			repo_dropdown.add(new Option(currentRepo, currentRepo));
			branch_dropdown.add(new Option(currentBranch, currentBranch));
			link_el.innerText = this.getLatestLink();
		}
		if (refreshFrom === "withCache") {
			repo_dropdown.empty();
			branch_dropdown.empty();
			if (this.existingRepos.length > 0) {
				this.existingRepos.map(repo => {
					repo_dropdown.add(new Option(repo, repo));
				});
				repo_dropdown.selectedIndex = this.existingRepos.indexOf(currentRepo);
			}
			if (this.existingBranches.length > 0) {
				this.existingBranches.map(branch => {
					branch_dropdown.add(new Option(branch, branch));
				});
				if (currentBranch === "") {
					branch_dropdown.selectedIndex = -1;
				}
				branch_dropdown.selectedIndex = this.existingBranches.indexOf(currentBranch);
			}
			if (currentRepo !== "") {
				if (this.existingRepos.length === 0) {
					repo_dropdown.add(new Option(currentRepo, currentRepo));
				} else {
					repo_dropdown.selectedIndex = this.existingRepos.indexOf(currentRepo);
					if (branch_dropdown.selectedIndex === -1) {
						warn(`warning: selected branch ${currentBranch} not found, existing branches: ${this.existingBranches}`);
					}
				}
			}
			if (currentBranch !== "") {
				if (this.existingBranches.length === 0) {
					branch_dropdown.add(new Option(currentBranch, currentBranch));
				} else {
					branch_dropdown.selectedIndex = this.existingBranches.indexOf(currentBranch);
					if (branch_dropdown.selectedIndex === -1) {
						warn(`warning: selected branch ${currentBranch} not found, existing branches: ${this.existingBranches}`);
					}
				}
			}
		}
	};


	providerSelectionBlock = () => {
		const {containerEl} = this;
		new Setting(containerEl).setHeading()
			.setName("Git Provider")
			.setDesc("Choose between GitHub or your own Gitea server");

		new Setting(containerEl)
			.setName("Provider")
			.setDesc("Select your git hosting provider")
			.addDropdown(dropdown => {
				dropdown
					.addOption('github', 'GitHub')
					.addOption('gitea', 'Gitea (Self-hosted)')
					.setValue(this.plugin.settings.provider)
					.onChange(async (value: "github" | "gitea") => {
						this.plugin.settings.provider = value;
						await this.plugin.saveSettings();
						// Reload the entire settings display to show relevant provider settings
						await this.display();
					});
			});
	};

	giteaSettingsBlock = () => {
		const {containerEl} = this;

		// Gitea Server URL
		new Setting(containerEl).setHeading()
			.setName("Gitea Server")
			.setDesc("Configure connection to your Gitea instance");

		new Setting(containerEl)
			.setName('Use HTTP instead of HTTPS')
			.setDesc('Enable for local servers without SSL certificates. WARNING: Insecure, only use on trusted local networks.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.giteaUseHttp)
				.onChange(async (value) => {
					this.plugin.settings.giteaUseHttp = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Gitea Server URL')
			.setDesc('URL of your Gitea server (e.g., https://gitea.example.com or http://gitea.local for HTTP)')
			.addText(text => text
				.setPlaceholder('https://gitea.example.com')
				.setValue(this.plugin.settings.giteaUrl)
				.onChange(async (value) => {
					this.plugin.settings.giteaUrl = value.trim();
					await this.plugin.saveSettings();
				}));

		// Gitea Token
		new Setting(containerEl)
			.setName('Gitea Access Token')
			.setDesc('Personal access token from your Gitea server')
			.addText(text => text
				.setPlaceholder('Gitea access token')
				.setValue(this.plugin.settings.giteaToken)
				.onChange(async (value) => {
					this.plugin.settings.giteaToken = value;
					await this.plugin.saveSettings();
				}));

		// Test Connection Button
		new Setting(containerEl)
			.setName('Test Connection')
			.setDesc('Verify connection to your Gitea server')
			.addButton(button => button
				.setButtonText('Test Connection')
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Testing...');
					try {
						const result = await this.plugin.fit.testConnection();
						if (result.success) {
							button.setButtonText('✓ Connected');
							setTimeout(() => button.setButtonText('Test Connection'), 2000);
						} else {
							button.setButtonText('✗ Failed');
							console.error(result.message);
							setTimeout(() => button.setButtonText('Test Connection'), 2000);
						}
					} catch (_error) {
						button.setButtonText('✗ Error');
						setTimeout(() => button.setButtonText('Test Connection'), 2000);
					} finally {
						button.setDisabled(false);
					}
				}));

		// Gitea User Info
		new Setting(containerEl).setHeading()
			.setName("Gitea user info")
			.addButton(button => button
				.setCta()
				.setButtonText("Authenticate user")
				.setDisabled(this.authenticating)
				.onClick(async ()=>{
					if (this.authenticating) return;
					await this.handleUserFetch();
				}));

		this.ownerSetting = new Setting(containerEl)
			.setDesc("Input your Gitea access token above to get authenticated.");
		this.ownerSetting.nameEl.addClass('fit-avatar-container');

		const currentOwner = this.plugin.settings.giteaOwner;
		const currentAvatar = this.plugin.settings.giteaAvatarUrl;

		if (currentOwner === "") {
			this.authUserAvatar = this.ownerSetting.nameEl.createDiv({cls: 'fit-avatar-container empty'});
			this.authUserHandle = this.ownerSetting.nameEl.createEl('span', {cls: 'fit-github-handle'});
			this.authUserHandle.setText("Unauthenticated");
		} else {
			this.authUserAvatar = this.ownerSetting.nameEl.createDiv({cls: 'fit-avatar-container'});
			this.authUserAvatar.createEl('img', { attr: { src: currentAvatar } });
			this.authUserHandle = this.ownerSetting.nameEl.createEl('span', {cls: 'fit-github-handle'});
			this.authUserHandle.setText(currentOwner);
		}
		this.ownerSetting.controlEl.addClass('fit-avatar-display-text');
	};

	async display(): Promise<void> {
		const {containerEl} = this;

		containerEl.empty();

		// Provider selection (always shown)
		this.providerSelectionBlock();

		// Show provider-specific settings
		if (this.plugin.settings.provider === "gitea") {
			this.giteaSettingsBlock();
		} else {
			this.githubUserInfoBlock();
		}

		// Common blocks (shown for both providers)
		this.repoInfoBlock();
		this.localConfigBlock();
		this.noticeConfigBlock();
		this.refreshFields("withCache");
	}
}
